// Integration test для эмуляционного харнесса обмена (POST /sim/exchange-eval).
// Реальный processInbound, persona + reply-стратегия — фейковые. Проверяем, что
// скорер ловит «хороший» сквозной диалог (курс+реквизиты) как passed, а
// преждевременный уход к оператору — как failed.

import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminSimRoutes } from "./admin-sim.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_xeval_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-xeval-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let appGood: Hono;
let appBail: Hono;
let token = "";
let tenantId = 0;

const fakePersona = {
  complete: async () => "Хочу обменять 500 USDT (TRC20) на баты, какой курс?",
};
function reply(text: string) {
  return {
    generate: async () => [
      { channelId: "x", externalUserId: "u", parts: [{ kind: "text", text }] },
    ],
  };
}

function mount(replyStrategy: unknown): Hono {
  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: drizzle/fake generics
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route(
    "/",
    makeAdminSimRoutes({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: reply-strategy fake
      replyStrategy: replyStrategy as any,
      // biome-ignore lint/suspicious/noExplicitAny: chat-client fake
      resolveSimChat: () => fakePersona as any,
    }),
  );
  return app;
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

  appGood = mount(
    reply(
      "Курс 33.2 THB за 1 USDT, итого 16 600 THB. Реквизиты для перевода: адрес TRC20 TJ9k…q4Fq2Xb.",
    ),
  );
  appBail = mount(reply("Секунду, уточню у оператора — менеджер свяжется с вами."));

  const sa = await appGood.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "xeval@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  token = sba.token;
  tenantId = sba.admin.tenantId;

  await withTenant(db, tenantId, (tx) =>
    tx
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "@xevalbot", status: "active" }),
  );
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function evalReq(app: Hono): Promise<Response> {
  return app.request("/api/admin/sim/exchange-eval", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ personaIds: ["exchange_usdt"], maxTurns: 2 }),
  });
}

describe("exchange-eval harness", () => {
  it("good dialog (курс + реквизиты) scores as passed", async () => {
    if (!sql) return;
    const res = await evalReq(appGood);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { passed: number; total: number };
      report: Array<{
        id: string;
        passed: boolean;
        signals: { reachedQuote: boolean; requisitesIssued: boolean; prematureOperator: boolean };
      }>;
    };
    expect(body.summary.total).toBe(1);
    expect(body.summary.passed).toBe(1);
    const r = body.report[0]!;
    expect(r.passed).toBe(true);
    expect(r.signals.reachedQuote).toBe(true);
    expect(r.signals.requisitesIssued).toBe(true);
    expect(r.signals.prematureOperator).toBe(false);
  });

  it("premature operator handoff scores as failed", async () => {
    if (!sql) return;
    const res = await evalReq(appBail);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { passed: number; total: number };
      report: Array<{
        passed: boolean;
        reasons: string[];
        signals: { prematureOperator: boolean };
      }>;
    };
    expect(body.summary.passed).toBe(0);
    const r = body.report[0]!;
    expect(r.passed).toBe(false);
    expect(r.signals.prematureOperator).toBe(true);
    expect(r.reasons).toContain("преждевременный уход к оператору");
  });

  it("400 when chat LLM not configured", async () => {
    if (!sql) return;
    const noChat = new Hono();
    noChat.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    noChat.route("/", makeAdminSimRoutes({ db, replyStrategy: null, resolveSimChat: () => null }));
    const res = await noChat.request("/api/admin/sim/exchange-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
