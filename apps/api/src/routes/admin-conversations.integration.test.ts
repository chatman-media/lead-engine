// Integration test для admin-conversations endpoints. Создаём 2 tenants,
// 3 conversations + 5 messages в каждом, проверяем pagination, cross-
// tenant isolation, 404 on missing, message ordering chronological.

import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  messages,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminConversationsRoutes } from "./admin-conversations.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_conv_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-conv-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;
const conversationIdsA: number[] = [];
let conversationIdB = 0;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminConversationsRoutes({ db }));

    // Tenant A.
    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "conv-a@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    tokenA = sba.token;
    tenantA = sba.admin.tenantId;

    // Tenant B.
    const sb = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "conv-b@demo.io", password: "strong-pwd-12345" }),
    });
    const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
    tokenB = sbb.token;
    tenantB = sbb.admin.tenantId;

    const now = Math.floor(Date.now() / 1000);

    // Create 3 conversations for tenant A с разным lastMessageAt
    // (для pagination & ordering testing).
    for (let i = 0; i < 3; i++) {
      const [contact] = await db
        .insert(contacts)
        .values({ tenantId: tenantA, displayName: `Contact A${i}` })
        .returning({ id: contacts.id });
      const [conv] = await db
        .insert(conversations)
        .values({
          tenantId: tenantA,
          userId: contact!.id,
          source: "bot",
          mode: "ai",
          lastMessageAt: now - i * 100, // i=0 — newest, i=2 — oldest
          createdAt: now - i * 100,
        })
        .returning({ id: conversations.id });
      conversationIdsA.push(conv!.id);

      // 5 messages per conversation, chronological.
      for (let m = 0; m < 5; m++) {
        await db.insert(messages).values({
          tenantId: tenantA,
          conversationId: conv!.id,
          role: m % 2 === 0 ? "user" : "assistant",
          text: `Msg ${m} in conv ${i}`,
          createdAt: now - i * 100 + m,
        });
      }
    }

    // Tenant B: 1 conversation.
    const [contactB] = await db
      .insert(contacts)
      .values({ tenantId: tenantB, displayName: "Contact B0" })
      .returning({ id: contacts.id });
    const [convB] = await db
      .insert(conversations)
      .values({
        tenantId: tenantB,
        userId: contactB!.id,
        source: "bot",
        mode: "ai",
        lastMessageAt: now,
        createdAt: now,
      })
      .returning({ id: conversations.id });
    conversationIdB = convB!.id;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin-conversations", () => {
  it("GET без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/conversations");
    expect(res.status).toBe(401);
  });

  it("GET list → 3 conversations отсортированы DESC по lastMessageAt", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; lastMessageAt: number; contactName: string }>;
    };
    expect(body.items).toHaveLength(3);
    // DESC: items[0].lastMessageAt > items[1] > items[2]
    expect(body.items[0]!.lastMessageAt).toBeGreaterThan(body.items[1]!.lastMessageAt);
    expect(body.items[1]!.lastMessageAt).toBeGreaterThan(body.items[2]!.lastMessageAt);
    expect(body.items[0]!.contactName).toBe("Contact A0"); // newest
  });

  it("GET list с limit=2 → возвращает 2 + nextCursor", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      nextCursor?: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeDefined();
  });

  it("pagination: cursor возвращает следующую страницу", async () => {
    if (!sql) return;
    const page1 = (await (
      await authReq(tokenA, "/api/admin/conversations?limit=2")
    ).json()) as { nextCursor: number };
    const page2 = (await (
      await authReq(tokenA, `/api/admin/conversations?limit=2&cursor=${page1.nextCursor}`)
    ).json()) as { items: Array<{ id: number }>; nextCursor?: number };
    expect(page2.items).toHaveLength(1); // 3rd remaining
    expect(page2.nextCursor).toBeUndefined(); // last page
  });

  it("cross-tenant isolation: B видит только свой 1 диалог", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/conversations");
    const body = (await res.json()) as {
      items: Array<{ id: number; contactName: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.contactName).toBe("Contact B0");
    expect(body.items[0]!.id).toBe(conversationIdB);
    expect(tenantA).not.toBe(tenantB);
  });

  it("GET /:id → возвращает conversation + messages в chronological order", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: number };
      messages: Array<{ text: string; role: string; createdAt: number }>;
    };
    expect(body.conversation.id).toBe(id);
    expect(body.messages).toHaveLength(5);
    // Chronological: первое сообщение — старейшее, последнее — новейшее.
    expect(body.messages[0]!.text).toBe("Msg 0 in conv 0");
    expect(body.messages[4]!.text).toBe("Msg 4 in conv 0");
    expect(body.messages[0]!.createdAt).toBeLessThan(body.messages[4]!.createdAt);
    // user/assistant alternates
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[1]!.role).toBe("assistant");
  });

  it("GET /:id для чужого conversation → 404 (cross-tenant)", async () => {
    if (!sql) return;
    // Tenant B пытается читать tenant A's conversation
    const res = await authReq(tokenB, `/api/admin/conversations/${conversationIdsA[0]}`);
    expect(res.status).toBe(404);
  });

  it("GET /:id несуществующий → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/999999");
    expect(res.status).toBe(404);
  });

  it("GET /:id invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/not-a-number");
    expect(res.status).toBe(400);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/conversations", {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});
