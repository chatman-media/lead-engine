// Integration test для admin-kb endpoints. Поднимает isolated PG → миграции →
// signup admin → upload doc → list → delete. NullEmbeddingClient (zero vectors)
// чтобы не зависеть от LLM-provider'а в тестах.

import { NullEmbeddingClient } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  createIsolatedDb,
  kbSuggestions,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminKbRoutes } from "./admin-kb.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_kb_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-kb-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

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

    // NullEmbeddingClient — zero vectors, dim=1536 (default kb_chunks schema).
    const embedder = new NullEmbeddingClient(1536);
    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route(
      "/",
      makeAdminKbRoutes({
        db,
        resolveEmbedder: () => embedder,
      }),
    );

    // Signup to get token + tenantId.
    const signupRes = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "kb-test@demo.io", password: "strong-pwd-12345" }),
    });
    const sb = (await signupRes.json()) as {
      token: string;
      admin: { tenantId: number };
    };
    token = sb.token;
    tenantId = sb.admin.tenantId;
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
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin-kb upload/list/delete flow", () => {
  it("GET /api/admin/kb/documents без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/kb/documents");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/kb/documents с auth → пустой list", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/documents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("POST /api/admin/kb/documents JSON paste → создаёт doc + chunks", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test doc",
        body: "Один из наших клиентов нашёл работу за 2 недели. " +
          "Контракт от 3 месяцев, виза оформляется агентством.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documentId: number;
      source: string;
      chunks: number;
      created: boolean;
    };
    expect(body.documentId).toBeGreaterThan(0);
    expect(body.source).toMatch(/^inline:/);
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.created).toBe(true);
  });

  it("dedup: same body → same source, не дублируется", async () => {
    if (!sql) return;
    const sameBody = "Один из наших клиентов нашёл работу за 2 недели. " +
      "Контракт от 3 месяцев, виза оформляется агентством.";
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test doc again", body: sameBody }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; chunks: number };
    // Same content_hash → dedup → created=false, chunks reused
    expect(body.created).toBe(false);
    expect(body.chunks).toBeGreaterThan(0);
  });

  it("POST с topic → topic сохраняется", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Visa info",
        body: "Виза оформляется агентством за 10 рабочих дней.",
        topic: "visa",
      }),
    });
    expect(res.status).toBe(200);
    // list should include topic
    const listRes = await authReq("/api/admin/kb/documents");
    const list = (await listRes.json()) as {
      items: Array<{ title: string; topic: string | null }>;
    };
    const visa = list.items.find((d) => d.title === "Visa info");
    expect(visa?.topic).toBe("visa");
  });

  it("POST empty body → 400", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Empty", body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST PDF multipart с невалидными байтами → 422 (parse failed)", async () => {
    if (!sql) return;
    const form = new FormData();
    // «fake pdf bytes» — не настоящий PDF, parsePdfBuffer упадёт с ошибкой → 422
    form.append("file", new Blob(["fake pdf bytes"]), "test.pdf");
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(422);
  });

  it("POST multipart .txt → ingest works", async () => {
    if (!sql) return;
    const form = new FormData();
    form.append(
      "file",
      new Blob([
        "Multipart upload test content про танцовщиц в Дубае. Контракт 3 месяца.",
      ]),
      "test.txt",
    );
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; chunks: number };
    expect(body.source).toMatch(/^inline:/);
    expect(body.chunks).toBeGreaterThan(0);
  });

  it("DELETE /api/admin/kb/documents/:id → 200 + isolated", async () => {
    if (!sql) return;
    // Get first doc id from list
    const listRes = await authReq("/api/admin/kb/documents");
    const list = (await listRes.json()) as { items: Array<{ id: number }> };
    const docId = list.items[0]?.id;
    expect(docId).toBeGreaterThan(0);

    const res = await authReq(`/api/admin/kb/documents/${docId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
  });

  it("DELETE несуществующий id → 404", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/documents/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("cross-tenant isolation: другой tenant не видит docs первого", async () => {
    if (!sql) return;
    // Signup второй tenant
    const otherSignup = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "other@demo.io", password: "strong-pwd-67890" }),
    });
    const ob = (await otherSignup.json()) as {
      token: string;
      admin: { tenantId: number };
    };
    expect(ob.admin.tenantId).not.toBe(tenantId);

    // Second tenant lists docs — должен быть пуст
    const listRes = await app.request("/api/admin/kb/documents", {
      headers: { Authorization: `Bearer ${ob.token}` },
    });
    const list = (await listRes.json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  it("invalid token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/kb/documents", {
      headers: { Authorization: "Bearer garbage-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("admin-kb suggestions", () => {
  let pendingId = 0;
  let decidedId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [p] = await db
      .insert(kbSuggestions)
      .values({
        tenantId,
        questionText: "Какой курс USDT?",
        answerDraft: "Курс 36.5 ₽",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: kbSuggestions.id });
    pendingId = p!.id;
    const [d] = await db
      .insert(kbSuggestions)
      .values({
        tenantId,
        questionText: "Уже решённый вопрос",
        status: "rejected",
        createdAt: now - 10,
        updatedAt: now - 10,
      })
      .returning({ id: kbSuggestions.id });
    decidedId = d!.id;
  });

  it("GET без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/kb/suggestions");
    expect(res.status).toBe(401);
  });

  it("GET ?status=pending → возвращает pending + pendingCount", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/suggestions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; status: string }>;
      pendingCount: number;
    };
    expect(body.items.every((i) => i.status === "pending")).toBe(true);
    expect(body.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("GET ?status=rejected → только rejected", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/suggestions?status=rejected");
    const body = (await res.json()) as { items: Array<{ id: number; status: string }> };
    expect(body.items.some((i) => i.id === decidedId)).toBe(true);
    expect(body.items.every((i) => i.status === "rejected")).toBe(true);
  });

  it("PATCH bad id → 400", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/suggestions/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH несуществующий → 404", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/kb/suggestions/999999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH уже решённого → 409", async () => {
    if (!sql) return;
    const res = await authReq(`/api/admin/kb/suggestions/${decidedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH approve без answerDraft → ингестит из suggestion.answerDraft", async () => {
    if (!sql) return;
    const res = await authReq(`/api/admin/kb/suggestions/${pendingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kbDocumentId: number };
    expect(body.ok).toBe(true);
    expect(body.kbDocumentId).toBeGreaterThan(0);
    const [row] = await db
      .select({ status: kbSuggestions.status, kbDocumentId: kbSuggestions.kbDocumentId })
      .from(kbSuggestions)
      .where(and(eq(kbSuggestions.id, pendingId), eq(kbSuggestions.tenantId, tenantId)));
    expect(row!.status).toBe("ingested");
    expect(row!.kbDocumentId).toBe(body.kbDocumentId);
  });

  it("PATCH approve пустого answerDraft → 400", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [s] = await db
      .insert(kbSuggestions)
      .values({ tenantId, questionText: "Без ответа", status: "pending", createdAt: now, updatedAt: now })
      .returning({ id: kbSuggestions.id });
    const res = await authReq(`/api/admin/kb/suggestions/${s!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH reject c reason → status=rejected", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [s] = await db
      .insert(kbSuggestions)
      .values({ tenantId, questionText: "Отклонить", status: "pending", createdAt: now, updatedAt: now })
      .returning({ id: kbSuggestions.id });
    const res = await authReq(`/api/admin/kb/suggestions/${s!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", rejectedReason: "не релевантно" }),
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ status: kbSuggestions.status, reason: kbSuggestions.rejectedReason })
      .from(kbSuggestions)
      .where(eq(kbSuggestions.id, s!.id));
    expect(row!.status).toBe("rejected");
    expect(row!.reason).toBe("не релевантно");
  });
});
