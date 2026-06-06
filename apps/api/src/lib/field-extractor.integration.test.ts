/**
 * Integration test для concierge branch-aware auto-advance (slice 3).
 *
 * Прогоняет полный DB-путь field-extractor против изолированной test-БД:
 * auto-create лида на `request_received` → извлечение `request_type` (через
 * stub-LLM) → branch-aware advance в ветку `<type>_request` + запись
 * `leads.request_type`. Покрывает то, что не видит unit-тест selectNextStage.
 *
 * Без DATABASE_URL тесты мягко скипаются (как и прочие *.integration.test.ts).
 */

import {
  applyAllMigrations,
  contacts,
  createIsolatedDb,
  leadEvents,
  leads,
  schema,
  stageDefinitions,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { applyFunnelStages, SEED_TEMPLATES } from "../routes/admin-funnel.ts";
import { makeAuthRoutes } from "../routes/auth.ts";
import { makeFieldExtractor } from "./field-extractor.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_concierge_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const SECRET = "test-secret-concierge-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;

/** LoadedRef со stub-LLM, который возвращает фиксированный JSON извлечения. */
function stubRef(response: string): LoadedRef {
  return {
    router: {
      resolveChat() {
        return { complete: async () => response };
      },
    },
  } as unknown as LoadedRef;
}

async function freshContact(): Promise<number> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId })
    .returning({ id: contacts.id });
  return c!.id;
}

async function leadOf(contactId: number) {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)));
  return lead;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  // Создаём tenant через signup, затем сидим concierge-воронку.
  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "concierge@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { admin: { tenantId: number } };
  tenantId = sba.admin.tenantId;

  await applyFunnelStages(db as never, tenantId, SEED_TEMPLATES.concierge!, "concierge");
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("concierge branch-aware auto-advance (slice 3)", () => {
  it("request_type=transfer → лид уходит в transfer_request + пишется request_type", async () => {
    if (!sql) return;
    const contactId = await freshContact();
    const extractor = makeFieldExtractor(stubRef('{"request_type":"transfer"}'));

    await extractor.extract({
      tenantId,
      contactId,
      text: "нужен трансфер в аэропорт завтра в 9",
      db,
    });

    const lead = await leadOf(contactId);
    expect(lead?.state).toBe("transfer_request");
    expect(lead?.requestType).toBe("transfer");

    const events = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead!.id));
    expect(events.some((e) => e.toState === "transfer_request")).toBe(true);
  });

  it("request_type=exchange → лид уходит в exchange_request", async () => {
    if (!sql) return;
    const contactId = await freshContact();
    const extractor = makeFieldExtractor(stubRef('{"request_type":"exchange"}'));

    await extractor.extract({ tenantId, contactId, text: "хочу поменять usdt на баты", db });

    const lead = await leadOf(contactId);
    expect(lead?.state).toBe("exchange_request");
    expect(lead?.requestType).toBe("exchange");
  });

  it("request_type=other → лид остаётся на request_received (без мис-роутинга)", async () => {
    if (!sql) return;
    const contactId = await freshContact();
    const extractor = makeFieldExtractor(stubRef('{"request_type":"other"}'));

    await extractor.extract({ tenantId, contactId, text: "хочу что-то необычное", db });

    const lead = await leadOf(contactId);
    expect(lead?.state).toBe("request_received");
    expect(lead?.requestType).toBeNull();
  });

  it("multi-request (3b): после завершения первого запроса новый создаёт отдельный лид", async () => {
    if (!sql) return;
    const contactId = await freshContact();

    // 1) Первый запрос: трансфер → transfer_request.
    await makeFieldExtractor(stubRef('{"request_type":"transfer"}')).extract({
      tenantId,
      contactId,
      text: "нужен трансфер",
      db,
    });
    const first = await leadOf(contactId);
    expect(first?.state).toBe("transfer_request");

    // 2) Завершаем первый лид (терминал completed).
    const [completed] = await db
      .select({ id: stageDefinitions.id })
      .from(stageDefinitions)
      .where(
        and(
          eq(stageDefinitions.tenantId, tenantId),
          eq(stageDefinitions.slug, "completed"),
        ),
      );
    await db
      .update(leads)
      .set({ stageDefinitionId: completed!.id, state: "completed" })
      .where(eq(leads.id, first!.id));

    // 3) Новый запрос того же гостя: обмен → ОТДЕЛЬНЫЙ новый лид.
    await makeFieldExtractor(stubRef('{"request_type":"exchange"}')).extract({
      tenantId,
      contactId,
      text: "теперь хочу поменять деньги",
      db,
    });

    const all = await db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)))
      .orderBy(desc(leads.updatedAt));
    expect(all.length).toBe(2);
    const open = all.find((l) => l.state !== "completed");
    expect(open?.state).toBe("exchange_request");
    expect(open?.requestType).toBe("exchange");
  });

  it("multi-request (parallel): новый тип в треде с открытым запросом → отдельный лид в его ветке", async () => {
    if (!sql) return;
    const contactId = await freshContact();

    // 1) Открываем transfer → transfer_request (лид в ветке).
    await makeFieldExtractor(stubRef('{"request_type":"transfer"}')).extract({
      tenantId,
      contactId,
      text: "нужен трансфер",
      db,
    });
    expect((await leadOf(contactId))?.state).toBe("transfer_request");

    // 2) В ТОМ ЖЕ треде гость начинает другую услугу — LLM сигналит _new_request.
    await makeFieldExtractor(stubRef('{"_new_request":"food"}')).extract({
      tenantId,
      contactId,
      text: "и ещё закажи пиццу",
      db,
    });

    const all = await db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)))
      .orderBy(desc(leads.updatedAt));
    expect(all.length).toBe(2);
    // Новый food-лид сразу в своей ветке.
    expect(all.find((l) => l.requestType === "food")?.state).toBe("food_request");
    // Старый transfer-лид не тронут.
    expect(all.find((l) => l.requestType === "transfer")?.state).toBe("transfer_request");
  });
});
