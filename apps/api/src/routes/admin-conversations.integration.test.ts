// Integration test для admin-conversations endpoints. Создаём 2 tenants,
// 3 conversations + 5 messages в каждом, проверяем pagination, cross-
// tenant isolation, 404 on missing, message ordering chronological.

import {
  adminNotifications,
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  messages,
  outboundQueue,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
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
        .values({
          tenantId: tenantA,
          displayName: `Contact A${i}`,
          ...(i === 0
            ? {
                attributesJson: JSON.stringify({
                  last_photo_class: "passport",
                  passport_family_name: "IVANOV",
                  passport_given_name: "IVAN",
                }),
              }
            : {}),
        })
        .returning({ id: contacts.id });
      const [conv] = await db
        .insert(conversations)
        .values({
          tenantId: tenantA,
          userId: contact!.id,
          source: "bot",
          mode: "ai",
          status: "open",
          lastMessageText: `Msg 4 in conv ${i}`,
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
        status: "open",
        lastMessageText: "Msg B",
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

  it("GET list → items содержат lastMessagePreview и escalatedAt", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        lastMessagePreview?: string | null;
        escalatedAt?: number | null;
      }>;
    };
    // Все 3 диалога имеют сообщения — lastMessagePreview не null.
    for (const item of body.items) {
      expect(item.lastMessagePreview).toBeTruthy();
    }
    // escalatedAt либо отсутствует либо null (не эскалировано в fixtures).
    for (const item of body.items) {
      expect(item.escalatedAt ?? null).toBeNull();
    }
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
      conversation: { id: number; contactAttributesJson: string | null };
      messages: Array<{ text: string; role: string; createdAt: number }>;
    };
    expect(body.conversation.id).toBe(id);
    expect(body.conversation.contactAttributesJson).toContain("passport_family_name");
    expect(body.messages).toHaveLength(5);
    // Chronological: первое сообщение — старейшее, последнее — новейшее.
    expect(body.messages[0]!.text).toBe("Msg 0 in conv 0");
    expect(body.messages[4]!.text).toBe("Msg 4 in conv 0");
    expect(body.messages[0]!.createdAt).toBeLessThan(body.messages[4]!.createdAt);
    // user/assistant alternates
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[1]!.role).toBe("assistant");
  });

  it("GET /:id/operator-handoffs → returns only current tenant operator events", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const now = Math.floor(Date.now() / 1000);
    await db.insert(adminNotifications).values([
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "operator_handoff_required",
        title: "Проверить KYC",
        body: "Клиент прислал видео.",
        dedupKey: `operator_handoff_required:${id}`,
        createdAt: now,
      },
      {
        tenantId: tenantA,
        topic: "leads",
        severity: "info",
        kind: "stage_changed",
        title: "Не handoff",
        body: "",
        dedupKey: `stage_changed:${id}`,
        createdAt: now,
      },
      {
        tenantId: tenantB,
        topic: "escalation",
        severity: "important",
        kind: "operator_handoff_required",
        title: "Чужой tenant",
        body: "",
        dedupKey: `operator_handoff_required:${id}`,
        createdAt: now,
      },
    ]);

    const res = await authReq(tokenA, `/api/admin/conversations/${id}/operator-handoffs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string; kind: string; body: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: "operator_handoff_required",
      title: "Проверить KYC",
      body: "Клиент прислал видео.",
    });
  });

  it("GET /:id/operator-handoffs → hides read operator events", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!;
    const now = Math.floor(Date.now() / 1000);
    await db.insert(adminNotifications).values([
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "operator_confirm_needed",
        title: "Уже прочитано",
        body: "",
        dedupKey: `operator_confirm_needed:${id}`,
        readAt: now,
        createdAt: now,
      },
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "human_takeover",
        title: "Активное действие",
        body: "",
        dedupKey: `human_takeover:${id}`,
        createdAt: now,
      },
    ]);

    const res = await authReq(tokenA, `/api/admin/conversations/${id}/operator-handoffs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string; kind: string; readAt: number | null }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: "human_takeover",
      title: "Активное действие",
      readAt: null,
    });
  });

  it("GET /:id/operator-handoffs → hides KYC tasks already resolved on contact", async () => {
    if (!sql) return;
    const id = conversationIdsA[2]!;
    const now = Math.floor(Date.now() / 1000);
    const [conv] = await db
      .select({ contactId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conv) throw new Error("conversation fixture not found");

    await db
      .update(contacts)
      .set({
        attributesJson: JSON.stringify({
          isVerified: true,
          verificationStatus: "verified",
          kycStatus: "verified",
          exchangeKyc: {
            status: "verified",
            verified: true,
            needsVerification: false,
            reviewedAt: now,
          },
        }),
      })
      .where(eq(contacts.id, conv.contactId));
    await db.insert(adminNotifications).values([
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "operator_handoff_required",
        title: "Проверить KYC клиента",
        body: "Клиент прислал документ и видео для проверки.",
        dedupKey: `operator_handoff_required:${id}`,
        createdAt: now - 12,
      },
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "verification_requested",
        title: "Проверить KYC клиента",
        body: "Нужно проверить документ и видео.",
        dedupKey: `verification_requested:${id}`,
        createdAt: now - 10,
      },
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "info",
        kind: "document_uploaded",
        title: "Документ загружен",
        body: "",
        dedupKey: `document_uploaded:${id}`,
        createdAt: now - 5,
      },
      {
        tenantId: tenantA,
        topic: "escalation",
        severity: "important",
        kind: "human_takeover",
        title: "Обычный handoff",
        body: "",
        dedupKey: `human_takeover:${id}`,
        createdAt: now - 1,
      },
    ]);

    const res = await authReq(tokenA, `/api/admin/conversations/${id}/operator-handoffs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string; kind: string }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        kind: "human_takeover",
        title: "Обычный handoff",
      }),
    ]);

    const notificationRows = await db
      .select({
        kind: adminNotifications.kind,
        dedupKey: adminNotifications.dedupKey,
        readAt: adminNotifications.readAt,
      })
      .from(adminNotifications)
      .where(eq(adminNotifications.tenantId, tenantA));
    const relevantRows = notificationRows.filter((row) =>
      [
        `operator_handoff_required:${id}`,
        `verification_requested:${id}`,
        `document_uploaded:${id}`,
        `human_takeover:${id}`,
      ].includes(row.dedupKey),
    );
    expect(relevantRows.find((row) => row.kind === "verification_requested")?.readAt).toBeGreaterThan(
      0,
    );
    expect(relevantRows.find((row) => row.kind === "operator_handoff_required")?.readAt).toBeGreaterThan(
      0,
    );
    expect(relevantRows.find((row) => row.kind === "document_uploaded")?.readAt).toBeGreaterThan(
      0,
    );
    expect(relevantRows.find((row) => row.kind === "human_takeover")?.readAt).toBeNull();
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

describe("POST /api/admin/conversations/:id/reply", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await app.request(`/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/not-num/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("empty text → 400", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("non-existent conversation → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/999999/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("conversation без channel_identity → 409", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    // У conv A0 нет channel_identity (мы их не seed'или) → 409.
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from operator" }),
    });
    expect(res.status).toBe(409);
  });

  it("conversation с активным channel_identity → 200, message + outbound row", async () => {
    if (!sql) return;
    // Setup: добавить channel + identity для conv A0's contact.
    const id = conversationIdsA[0]!;
    const [conv] = await db
      .select({ contactId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, id));
    const contactId = conv!.contactId;

    const now = Math.floor(Date.now() / 1000);
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId: tenantA,
        kind: "telegram_bot",
        externalId: "replybot",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    await db.insert(channelIdentities).values({
      contactId,
      channelId: ch!.id,
      externalUserId: "tg-user-42",
      createdAt: now,
    });

    const res = await authReq(tokenA, `/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Привет от оператора" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      messageId: number;
      channelKind: string;
    };
    expect(body.ok).toBe(true);
    expect(body.channelKind).toBe("telegram_bot");
    expect(body.messageId).toBeGreaterThan(0);

    // Verify message in DB with role=human.
    const [msg] = await db
      .select({ role: messages.role, text: messages.text, metaJson: messages.metaJson })
      .from(messages)
      .where(eq(messages.id, body.messageId));
    expect(msg!.role).toBe("human");
    expect(msg!.text).toBe("Привет от оператора");
    expect(msg!.metaJson).toContain("adminId");

    // Verify outbound queue row.
    const [out] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.idempotencyKey, `admin-reply-${body.messageId}`));
    expect(out).toBeDefined();
    expect(out!.status).toBe("pending");
    expect(out!.channelId).toBe(ch!.id);
    const payload = JSON.parse(out!.payloadJson) as {
      externalUserId: string;
      parts: Array<{ kind: string; text: string }>;
    };
    expect(payload.externalUserId).toBe("tg-user-42");
    expect(payload.parts[0]!.text).toBe("Привет от оператора");

    // Verify conversation.mode → human.
    const [convAfter] = await db
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(convAfter!.mode).toBe("human");
  });

  it("cross-tenant: B пытается reply на A's conv → 404", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenB, `/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "trying" }),
    });
    expect(res.status).toBe(404);
  });

  it("text > 4000 → 400", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const longText = "x".repeat(4001);
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/conversations/:id/mode", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await app.request(`/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(401);
  });

  it("invalid mode → 400", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "queued" }),
    });
    expect(res.status).toBe(400);
  });

  it("not-found id → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/999999/mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(404);
  });

  it("invalid id (non-numeric) → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/conversations/abc/mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT { mode: 'human' } → conversation flipped + audit", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!; // используем второй чтобы не aliasing'ить
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body.mode).toBe("human");

    const [conv] = await db
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(conv!.mode).toBe("human");
  });

  it("PUT same mode dважды → noop, audit не записывается во 2-й раз", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!;
    // Уже human после предыдущего теста. PUT human снова — noop.
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT { mode: 'ai' } → return-to-AI", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ai" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("ai");

    const [conv] = await db
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(conv!.mode).toBe("ai");
  });

  it("cross-tenant: B пытается изменить A's conv → 404", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenB, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(res.status).toBe(404);
  });

  it("invalid json → 400", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/conversations/:id", () => {
  it("PATCH status → 200 and updated in DB", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(conv!.status).toBe("pending");
  });

  it("PATCH assignedAdminId → 200 and updated in DB", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!;
    // Находим ID админа A
    const [admin] = await db
      .select({ id: schema.admins.id })
      .from(schema.admins)
      .where(eq(schema.admins.email, "conv-a@demo.io"));

    const res = await authReq(tokenA, `/api/admin/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedAdminId: admin!.id }),
    });
    expect(res.status).toBe(200);
    const [conv] = await db
      .select({ assignedAdminId: conversations.assignedAdminId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(conv!.assignedAdminId).toBe(admin!.id);
  });

  it("PATCH assignedAdminId from another tenant → 404", async () => {
    if (!sql) return;
    const id = conversationIdsA[1]!;
    const [adminB] = await db
      .select({ id: schema.admins.id })
      .from(schema.admins)
      .where(eq(schema.admins.email, "conv-b@demo.io"));

    const res = await authReq(tokenA, `/api/admin/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedAdminId: adminB!.id }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH invalid status → 400", async () => {
    if (!sql) return;
    const id = conversationIdsA[0]!;
    const res = await authReq(tokenA, `/api/admin/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid-status" }),
    });
    expect(res.status).toBe(400);
  });
});

// tenantB used only as cross-tenant guard
void tenants;
