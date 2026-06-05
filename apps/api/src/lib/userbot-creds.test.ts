// Integration test резолва per-tenant MTProto-кредов. Реальное шифрование
// (setEncryptedSecret) в изолированной PG — НЕ мокаем conversation-engine,
// иначе mock.module протёк бы в другие тест-файлы того же процесса.
//
// Без DATABASE_URL / живого PG тест self-skip'ается (как остальные integration).

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import {
  resolveUserbotCreds,
  setUserbotCreds,
  TELEGRAM_API_HASH_KEY,
  TELEGRAM_API_ID_KEY,
} from "./userbot-creds.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ubcreds_${Math.random().toString(36).slice(2, 10)}`;
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
const MASTER_KEY_HEX = "b".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;

async function makeTenant(slug: string): Promise<number> {
  const [row] = await db.insert(tenants).values({ slug }).returning({ id: tenants.id });
  return row!.id;
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
  enabled = true;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("resolveUserbotCreds", () => {
  it("возвращает per-tenant креды если заданы", async () => {
    if (!enabled) return;
    const tid = await makeTenant("ub-a");
    await setUserbotCreds({
      db,
      tenantId: tid,
      apiId: 111,
      apiHash: "hash-aaa",
      masterKeyHex: MASTER_KEY_HEX,
      nowEpoch: 0,
    });
    expect(await resolveUserbotCreds({ db, tenantId: tid, masterKeyHex: MASTER_KEY_HEX })).toEqual({
      apiId: 111,
      apiHash: "hash-aaa",
    });
  });

  it("фолбэк на env, если per-tenant не заданы", async () => {
    if (!enabled) return;
    const tid = await makeTenant("ub-b");
    expect(
      await resolveUserbotCreds({
        db,
        tenantId: tid,
        masterKeyHex: MASTER_KEY_HEX,
        fallbackApiId: 999,
        fallbackApiHash: "env-hash",
      }),
    ).toEqual({ apiId: 999, apiHash: "env-hash" });
  });

  it("per-tenant перекрывает env", async () => {
    if (!enabled) return;
    const tid = await makeTenant("ub-c");
    await setUserbotCreds({
      db,
      tenantId: tid,
      apiId: 333,
      apiHash: "hash-ccc",
      masterKeyHex: MASTER_KEY_HEX,
      nowEpoch: 0,
    });
    expect(
      await resolveUserbotCreds({
        db,
        tenantId: tid,
        masterKeyHex: MASTER_KEY_HEX,
        fallbackApiId: 999,
        fallbackApiHash: "env-hash",
      }),
    ).toEqual({ apiId: 333, apiHash: "hash-ccc" });
  });

  it("null если нет ни per-tenant, ни env", async () => {
    if (!enabled) return;
    const tid = await makeTenant("ub-d");
    expect(
      await resolveUserbotCreds({ db, tenantId: tid, masterKeyHex: MASTER_KEY_HEX }),
    ).toBeNull();
  });

  it("частичная пара (только api_id) → фолбэк/null", async () => {
    if (!enabled) return;
    const tid = await makeTenant("ub-e");
    // Сохраняем только api_id, без hash.
    await setEncryptedSecret({
      db,
      tenantId: tid,
      key: TELEGRAM_API_ID_KEY,
      value: "555",
      masterKeyHex: MASTER_KEY_HEX,
      nowEpoch: 0,
    });
    expect(
      await resolveUserbotCreds({ db, tenantId: tid, masterKeyHex: MASTER_KEY_HEX }),
    ).toBeNull();
    expect(
      await resolveUserbotCreds({
        db,
        tenantId: tid,
        masterKeyHex: MASTER_KEY_HEX,
        fallbackApiId: 999,
        fallbackApiHash: "env-hash",
      }),
    ).toEqual({ apiId: 999, apiHash: "env-hash" });
    // Защита от unused-import: ключ hash отсутствует в этом кейсе.
    expect(TELEGRAM_API_HASH_KEY).toBe("telegram_api_hash");
  });
});
