// Integration test для admin-kb endpoints. Поднимает isolated PG → миграции →
// signup admin → upload doc → list → delete. NullEmbeddingClient (zero vectors)
// чтобы не зависеть от LLM-provider'а в тестах.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NullEmbeddingClient } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  createIsolatedDb,
  funnels,
  kbDocuments,
  kbSuggestions,
  schema,
  stageDefinitions,
  stageFields,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
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
let kbUploadDir = "";
let previousKbUploadDir: string | undefined;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    previousKbUploadDir = process.env.KB_UPLOAD_DIR;
    kbUploadDir = await mkdtemp(join(tmpdir(), "lead-engine-kb-files-"));
    process.env.KB_UPLOAD_DIR = kbUploadDir;
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
  if (kbUploadDir) {
    await rm(kbUploadDir, { recursive: true, force: true });
  }
  if (previousKbUploadDir === undefined) {
    delete process.env.KB_UPLOAD_DIR;
  } else {
    process.env.KB_UPLOAD_DIR = previousKbUploadDir;
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
      hasStoredFile: boolean;
      fileName: string | null;
    };
    expect(body.documentId).toBeGreaterThan(0);
    expect(body.source).toMatch(/^inline:/);
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.created).toBe(true);
    expect(body.hasStoredFile).toBe(true);
    expect(body.fileName).toBe("Test doc.txt");
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

  it("scoped upload/list + requirements coverage", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [funnel] = await db
      .insert(funnels)
      .values({
        tenantId,
        slug: "exchange_test",
        verticalTemplateId: "exchange_v1",
        stagesJson: "[]",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: funnels.id });
    const funnelId = funnel?.id;
    if (!funnelId) throw new Error("expected scoped KB test funnel");
    const [stage] = await db
      .insert(stageDefinitions)
      .values({
        tenantId,
        funnelId,
        slug: "payment",
        displayName: "Оплата",
        position: 1,
        kind: "active",
        stageType: "payment",
        phase: "clear",
        nextStages: ["won", "lost"],
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: stageDefinitions.id });
    const stageId = stage?.id;
    if (!stageId) throw new Error("expected scoped KB test stage");
    await db.insert(stageFields).values({
      tenantId,
      stageId,
      slug: "receipt",
      displayName: "Чек",
      fieldType: "photo",
      required: true,
      position: 1,
      createdAt: now,
    });

    const funnelUpload = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "How to pay scoped",
        body: "Для обмена клиент переводит RUB или USDT и присылает proof оплаты оператору.",
        topic: "how_to_pay",
        scopeType: "funnel",
        funnelId,
      }),
    });
    expect(funnelUpload.status).toBe(200);
    const funnelBody = (await funnelUpload.json()) as {
      scopeType: string;
      funnelId: number | null;
      stageSlug: string | null;
    };
    expect(funnelBody.scopeType).toBe("funnel");
    expect(funnelBody.funnelId).toBe(funnelId);
    expect(funnelBody.stageSlug).toBeNull();

    const missingFunnelUpload = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bad scope",
        body: "Документ не должен загрузиться в несуществующую воронку.",
        scopeType: "funnel",
        funnelId: 999_999,
      }),
    });
    expect(missingFunnelUpload.status).toBe(400);

    const missingStageUpload = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bad stage scope",
        body: "Документ не должен загрузиться в несуществующую стадию.",
        scopeType: "stage",
        funnelId,
        stageSlug: "missing",
      }),
    });
    expect(missingStageUpload.status).toBe(400);

    const stageUpload = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Payment stage scoped",
        body: "На стадии оплаты бот не подтверждает платёж до проверки proof оператором.",
        topic: "payment",
        scopeType: "stage",
        funnelId,
        stageSlug: "payment",
      }),
    });
    expect(stageUpload.status).toBe(200);

    const funnelListRes = await authReq(
      `/api/admin/kb/documents?scopeType=funnel&funnelId=${funnelId}`,
    );
    const funnelList = (await funnelListRes.json()) as {
      items: Array<{ title: string; scopeType: string; funnelId: number | null }>;
    };
    expect(funnelList.items.some((d) => d.title === "How to pay scoped")).toBe(true);
    expect(funnelList.items.every((d) => d.scopeType === "funnel" && d.funnelId === funnelId)).toBe(true);

    const allFunnelDocsRes = await authReq(`/api/admin/kb/documents?funnelId=${funnelId}`);
    const allFunnelDocs = (await allFunnelDocsRes.json()) as {
      items: Array<{ title: string; scopeType: string; funnelId: number | null }>;
    };
    expect(allFunnelDocs.items.some((d) => d.title === "How to pay scoped")).toBe(true);
    expect(allFunnelDocs.items.some((d) => d.title === "Payment stage scoped")).toBe(true);
    expect(
      allFunnelDocs.items.every(
        (d) => d.funnelId === funnelId && ["funnel", "stage"].includes(d.scopeType),
      ),
    ).toBe(true);

    await db.insert(kbSuggestions).values([
      {
        tenantId,
        questionText: "Global unanswered scoped test",
        status: "pending",
        scopeType: "global",
        createdAt: now + 1,
        updatedAt: now + 1,
      },
      {
        tenantId,
        questionText: "Funnel unanswered scoped test",
        status: "pending",
        scopeType: "funnel",
        funnelId,
        createdAt: now + 2,
        updatedAt: now + 2,
      },
      {
        tenantId,
        questionText: "Payment unanswered scoped test",
        status: "pending",
        scopeType: "stage",
        funnelId,
        stageSlug: "payment",
        createdAt: now + 3,
        updatedAt: now + 3,
      },
    ]);

    const globalSuggestionsRes = await authReq(
      "/api/admin/kb/suggestions?status=pending&scopeType=global",
    );
    const globalSuggestions = (await globalSuggestionsRes.json()) as {
      items: Array<{ questionText: string; scopeType: string }>;
      pendingCount: number;
    };
    expect(globalSuggestions.items.some((s) => s.questionText === "Global unanswered scoped test")).toBe(true);
    expect(globalSuggestions.items.every((s) => s.scopeType === "global")).toBe(true);
    expect(globalSuggestions.pendingCount).toBe(globalSuggestions.items.length);

    const funnelSuggestionsRes = await authReq(
      `/api/admin/kb/suggestions?status=pending&funnelId=${funnelId}`,
    );
    const funnelSuggestions = (await funnelSuggestionsRes.json()) as {
      items: Array<{ questionText: string; scopeType: string; funnelId: number | null }>;
      pendingCount: number;
    };
    expect(funnelSuggestions.items.some((s) => s.questionText === "Funnel unanswered scoped test")).toBe(true);
    expect(funnelSuggestions.items.some((s) => s.questionText === "Payment unanswered scoped test")).toBe(true);
    expect(funnelSuggestions.items.every((s) => s.funnelId === funnelId)).toBe(true);
    expect(funnelSuggestions.items.some((s) => s.scopeType === "global")).toBe(false);
    expect(funnelSuggestions.pendingCount).toBe(funnelSuggestions.items.length);

    const stageSuggestionsRes = await authReq(
      `/api/admin/kb/suggestions?status=pending&funnelId=${funnelId}&stageSlug=payment`,
    );
    const stageSuggestions = (await stageSuggestionsRes.json()) as {
      items: Array<{ questionText: string; scopeType: string; stageSlug: string | null }>;
    };
    expect(stageSuggestions.items.map((s) => s.questionText)).toContain("Payment unanswered scoped test");
    expect(stageSuggestions.items.every((s) => s.scopeType === "stage" && s.stageSlug === "payment")).toBe(true);

    const requirementsRes = await authReq(`/api/admin/kb/requirements?funnelId=${funnelId}`);
    expect(requirementsRes.status).toBe(200);
    const requirements = (await requirementsRes.json()) as {
      funnel: { id: number };
      items: Array<{ key: string; covered: boolean; matchedDocuments: number }>;
    };
    expect(requirements.funnel.id).toBe(funnelId);
    expect(requirements.items.find((i) => i.key === "exchange_how_to_pay")?.covered).toBe(true);
    expect(requirements.items.find((i) => i.key === "stage_payment_payment")?.matchedDocuments).toBe(1);

    const funnelSearchRes = await authReq("/api/admin/kb/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "proof оплаты для обмена",
        scopeType: "funnel",
        funnelId,
        limit: 5,
      }),
    });
    expect(funnelSearchRes.status).toBe(200);
    const funnelSearch = (await funnelSearchRes.json()) as {
      scopeType: string;
      funnelId: number | null;
      items: Array<{
        rank: number;
        title: string;
        text: string;
        scopeType: string;
        funnelId: number | null;
        stageSlug: string | null;
      }>;
    };
    expect(funnelSearch.scopeType).toBe("funnel");
    expect(funnelSearch.funnelId).toBe(funnelId);
    expect(funnelSearch.items.some((hit) => hit.title === "How to pay scoped")).toBe(true);
    expect(funnelSearch.items.every((hit) => hit.scopeType === "funnel")).toBe(true);
    expect(funnelSearch.items[0]?.rank).toBe(1);

    const stageSearchRes = await authReq("/api/admin/kb/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "платёж проверяет оператор",
        scopeType: "stage",
        funnelId,
        stageSlug: "payment",
        limit: 5,
      }),
    });
    expect(stageSearchRes.status).toBe(200);
    const stageSearch = (await stageSearchRes.json()) as {
      scopeType: string;
      funnelId: number | null;
      stageSlug: string | null;
      items: Array<{ title: string; scopeType: string; stageSlug: string | null }>;
    };
    expect(stageSearch.scopeType).toBe("stage");
    expect(stageSearch.funnelId).toBe(funnelId);
    expect(stageSearch.stageSlug).toBe("payment");
    expect(stageSearch.items.some((hit) => hit.title === "Payment stage scoped")).toBe(true);
    expect(stageSearch.items.every((hit) => hit.scopeType === "stage" && hit.stageSlug === "payment")).toBe(true);
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

  it("POST multipart .md → сохраняет исходник и отдаёт через /file", async () => {
    if (!sql) return;
    const markdown = "# Rules\n\n- Store original file\n- Keep indexed text";
    const form = new FormData();
    form.append("file", new Blob([markdown], { type: "text/markdown" }), "rules.md");
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documentId: number;
      hasStoredFile: boolean;
      fileName: string | null;
      fileMimeType: string | null;
      fileSizeBytes: number | null;
    };
    expect(body.hasStoredFile).toBe(true);
    expect(body.fileName).toBe("rules.md");
    expect(body.fileMimeType).toBe("text/markdown");
    expect(body.fileSizeBytes).toBe(markdown.length);

    const detailRes = await authReq(`/api/admin/kb/documents/${body.documentId}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      item: { hasStoredFile: boolean; fileName: string | null; text: string };
    };
    expect(detail.item.hasStoredFile).toBe(true);
    expect(detail.item.fileName).toBe("rules.md");
    expect(detail.item.text).toContain("Store original file");

    const fileRes = await authReq(`/api/admin/kb/documents/${body.documentId}/file`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toContain("text/markdown");
    expect(await fileRes.text()).toBe(markdown);

    const [row] = await db
      .select({ fileStorageKey: kbDocuments.fileStorageKey })
      .from(kbDocuments)
      .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, body.documentId)))
      .limit(1);
    expect(row?.fileStorageKey).toContain(`tenant-${tenantId}/doc-${body.documentId}-`);
    const storedPath = join(kbUploadDir, row?.fileStorageKey ?? "");
    expect(await readFile(storedPath, "utf8")).toBe(markdown);

    const listAfterUploadRes = await authReq("/api/admin/kb/documents");
    const listAfterUpload = (await listAfterUploadRes.json()) as {
      storage: { storedFiles: number; totalBytes: number; maxUploadBytes: number };
    };
    expect(listAfterUpload.storage.storedFiles).toBeGreaterThanOrEqual(1);
    expect(listAfterUpload.storage.totalBytes).toBeGreaterThanOrEqual(markdown.length);
    expect(listAfterUpload.storage.maxUploadBytes).toBeGreaterThan(0);

    const replacement = "# Updated rules\n\n- Replaced original file\n- Reindexed text";
    const replaceForm = new FormData();
    replaceForm.append(
      "file",
      new Blob([replacement], { type: "text/markdown" }),
      "rules-updated.md",
    );
    const replaceRes = await authReq(`/api/admin/kb/documents/${body.documentId}/file`, {
      method: "POST",
      body: replaceForm,
    });
    expect(replaceRes.status).toBe(200);
    const replaced = (await replaceRes.json()) as {
      item: {
        id: number;
        hasStoredFile: boolean;
        fileName: string | null;
        fileSizeBytes: number | null;
        text: string;
      };
    };
    expect(replaced.item.id).toBe(body.documentId);
    expect(replaced.item.hasStoredFile).toBe(true);
    expect(replaced.item.fileName).toBe("rules-updated.md");
    expect(replaced.item.fileSizeBytes).toBe(replacement.length);
    expect(replaced.item.text).toContain("Reindexed text");

    const detailAfterReplaceRes = await authReq(`/api/admin/kb/documents/${body.documentId}`);
    const detailAfterReplace = (await detailAfterReplaceRes.json()) as {
      item: { text: string; fileName: string | null };
    };
    expect(detailAfterReplace.item.fileName).toBe("rules-updated.md");
    expect(detailAfterReplace.item.text).toContain("Replaced original file");
    expect(detailAfterReplace.item.text).not.toContain("Store original file");

    const replacedFileRes = await authReq(`/api/admin/kb/documents/${body.documentId}/file`);
    expect(await replacedFileRes.text()).toBe(replacement);

    let oldMissing = false;
    try {
      await readFile(storedPath);
    } catch {
      oldMissing = true;
    }
    expect(oldMissing).toBe(true);

    const [replacedRow] = await db
      .select({ fileStorageKey: kbDocuments.fileStorageKey })
      .from(kbDocuments)
      .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, body.documentId)))
      .limit(1);
    const replacedStoredPath = join(kbUploadDir, replacedRow?.fileStorageKey ?? "");
    expect(await readFile(replacedStoredPath, "utf8")).toBe(replacement);

    const deleteRes = await authReq(`/api/admin/kb/documents/${body.documentId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    let missing = false;
    try {
      await readFile(replacedStoredPath);
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
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
    if (!p) throw new Error("expected pending suggestion");
    pendingId = p.id;
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
    if (!d) throw new Error("expected decided suggestion");
    decidedId = d.id;
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
    expect(row?.status).toBe("ingested");
    expect(row?.kbDocumentId).toBe(body.kbDocumentId);
  });

  it("PATCH approve пустого answerDraft → 400", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [s] = await db
      .insert(kbSuggestions)
      .values({ tenantId, questionText: "Без ответа", status: "pending", createdAt: now, updatedAt: now })
      .returning({ id: kbSuggestions.id });
    const suggestionId = s?.id;
    if (!suggestionId) throw new Error("expected empty-draft suggestion");
    const res = await authReq(`/api/admin/kb/suggestions/${suggestionId}`, {
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
    const suggestionId = s?.id;
    if (!suggestionId) throw new Error("expected reject suggestion");
    const res = await authReq(`/api/admin/kb/suggestions/${suggestionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", rejectedReason: "не релевантно" }),
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ status: kbSuggestions.status, reason: kbSuggestions.rejectedReason })
      .from(kbSuggestions)
      .where(eq(kbSuggestions.id, suggestionId));
    expect(row?.status).toBe("rejected");
    expect(row?.reason).toBe("не релевантно");
  });
});
