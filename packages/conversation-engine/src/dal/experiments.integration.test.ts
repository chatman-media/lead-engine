/**
 * ExperimentsRepo (CRUD + status-переходы) + parseAllocation. Требует
 * DATABASE_URL; без него — graceful-skip.
 */
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { ExperimentsRepo, parseAllocation } from "./experiments.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exp_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let t1 = 0;
let t2 = 0;
let enabled = false;
let n = 0;

const repo = () => new ExperimentsRepo({ db, tenantId: t1 });
const slug = (s: string) => `${s}-${n}`;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 3,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [a] = await db
    .insert(schema.tenants)
    .values({ slug: `exp-a-${n}` })
    .returning({ id: schema.tenants.id });
  const [b] = await db
    .insert(schema.tenants)
    .values({ slug: `exp-b-${n}` })
    .returning({ id: schema.tenants.id });
  t1 = a!.id;
  t2 = b!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ExperimentsRepo", () => {
  it("create → draft, byId находит, чужой тенант не видит", async () => {
    if (!enabled) return;
    const created = await repo().create({
      slug: slug("c1"),
      allocationJson: "[]",
      successMetric: "qualified",
    });
    expect(created.status).toBe("draft");
    expect((await repo().byId(created.id))?.id).toBe(created.id);
    // изоляция: репо другого тенанта не видит
    expect(await new ExperimentsRepo({ db, tenantId: t2 }).byId(created.id)).toBeNull();
  });

  it("byId несуществующего → null", async () => {
    if (!enabled) return;
    expect(await repo().byId(999_999)).toBeNull();
  });

  it("setStatus running проставляет startedAt и виден в findRunningBySlug", async () => {
    if (!enabled) return;
    const e = await repo().create({
      slug: slug("run"),
      allocationJson: "[]",
      successMetric: "won",
    });
    expect(await repo().findRunningBySlug(e.slug)).toBeNull(); // ещё draft
    const upd = await repo().setStatus(e.id, "running");
    expect(upd?.status).toBe("running");
    expect(upd?.startedAt).toBeGreaterThan(0);
    expect((await repo().findRunningBySlug(e.slug))?.id).toBe(e.id);
  });

  it("setStatus done проставляет endedAt", async () => {
    if (!enabled) return;
    const e = await repo().create({
      slug: slug("done"),
      allocationJson: "[]",
      successMetric: "qualified",
    });
    const upd = await repo().setStatus(e.id, "done");
    expect(upd?.status).toBe("done");
    expect(upd?.endedAt).toBeGreaterThan(0);
  });

  it("update меняет allocationJson и successMetric", async () => {
    if (!enabled) return;
    const e = await repo().create({
      slug: slug("upd"),
      allocationJson: "[]",
      successMetric: "qualified",
    });
    const upd = await repo().update(e.id, {
      allocationJson: '[{"style_slug":"x"}]',
      successMetric: "won",
    });
    expect(upd?.allocationJson).toBe('[{"style_slug":"x"}]');
    expect(upd?.successMetric).toBe("won");
  });

  it("listAll возвращает все эксперименты тенанта (DESC по created_at)", async () => {
    if (!enabled) return;
    const list = await repo().listAll();
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.every((e) => e.tenantId === t1)).toBe(true);
  });
});

describe("parseAllocation", () => {
  it("валидный массив → записи с весами", () => {
    const out = parseAllocation('[{"style_slug":"a","weight":2},{"styleSlug":"b"}]');
    expect(out).toEqual([
      { styleSlug: "a", weight: 2 },
      { styleSlug: "b", weight: 1 }, // дефолтный вес
    ]);
  });
  it("вес ≤ 0 игнорируется → дефолт 1", () => {
    expect(parseAllocation('[{"style_slug":"a","weight":-5}]')).toEqual([
      { styleSlug: "a", weight: 1 },
    ]);
  });
  it("пропускает записи без строкового slug", () => {
    expect(parseAllocation('[{"weight":2},{"style_slug":"ok"}]')).toEqual([
      { styleSlug: "ok", weight: 1 },
    ]);
  });
  it("не-JSON → ошибка", () => {
    expect(() => parseAllocation("{not json")).toThrow("not JSON");
  });
  it("не массив → ошибка", () => {
    expect(() => parseAllocation('{"a":1}')).toThrow("must be array");
  });
  it("нет валидных записей → ошибка", () => {
    expect(() => parseAllocation("[]")).toThrow("no valid entries");
  });
});
