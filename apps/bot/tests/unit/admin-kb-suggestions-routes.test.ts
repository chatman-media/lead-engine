// Coverage for `src/admin/routes/kb-suggestions.ts` — baseline 26.61% lines.
// The pipeline (create → draft → approve/reject) feeds the KB, so a silent
// SQL bug here would mean unanswered questions never make it back into the
// knowledge base.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { KbSuggestionsRepo } from "@/db/repos/kb-suggestions.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;

const sql = getTestSql();

// Same russian-snowball probe as admin-library-routes.test.ts — the approve
// path runs ingestText which trips the FTS trigger on local dev Postgres
// without the dict installed. CI's pgvector/pgvector:pg16 has it.
let FTS_AVAILABLE = true;
beforeAll(async () => {
  await setupTestDb(sql);
  try {
    await sql`SELECT to_tsvector('russian', 'тест')`;
  } catch {
    FTS_AVAILABLE = false;
  }
});
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function stubEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map(() => new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    },
  };
}

let server: Server;
let cookie: string;

beforeEach(async () => {
  const telegram = new TelegramClient({
    token: "t",
    fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as FetchLike,
  });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    rag: { embedder: stubEmbedder() } as Parameters<typeof createRouter>[0]["rag"],
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => {
  server.stop(true);
});

function url(path: string) {
  return `http://127.0.0.1:${server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
}

async function createPending(question = "Что входит в стоимость путёвки?"): Promise<number> {
  const repo = new KbSuggestionsRepo(sql);
  const row = await repo.create({ questionText: question, sourceConversationId: null });
  return row.id;
}

describe("GET /admin/api/kb/suggestions", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/kb/suggestions"));
    expect(res.status).toBe(401);
  });

  test("returns rows + counts", async () => {
    const a = await createPending("question A");
    const b = await createPending("question B");

    const res = await fetch(url("/admin/api/kb/suggestions"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: { id: number }[];
      counts: { pending: number; ingested: number; rejected: number };
    };
    // Order is created_at DESC; rows inserted within the same second can
    // tie-break either way, so just assert set membership and total.
    expect(new Set(body.suggestions.map((r) => r.id))).toEqual(new Set([a, b]));
    expect(body.counts.pending).toBe(2);
  });

  test("filters by status query param", async () => {
    const id = await createPending();
    // Mark as rejected directly so we can verify the status filter excludes pending.
    const repo = new KbSuggestionsRepo(sql);
    const [adminRow] = await sql<{ id: number }[]>`
      INSERT INTO admins (email, password_hash) VALUES ('reject@x', 'unused') RETURNING id
    `;
    await repo.reject(id, adminRow!.id, "duplicate");

    const pending = (await (
      await fetch(url("/admin/api/kb/suggestions?status=pending"), authed())
    ).json()) as { suggestions: unknown[] };
    expect(pending.suggestions.length).toBe(0);

    const rejected = (await (
      await fetch(url("/admin/api/kb/suggestions?status=rejected"), authed())
    ).json()) as { suggestions: unknown[] };
    expect(rejected.suggestions.length).toBe(1);
  });
});

describe("GET /admin/api/kb/suggestions/counts", () => {
  test("returns the count breakdown", async () => {
    await createPending();
    await createPending();
    const res = await fetch(url("/admin/api/kb/suggestions/counts"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: number; ingested: number; rejected: number };
    expect(body.pending).toBe(2);
    expect(body.ingested).toBe(0);
    expect(body.rejected).toBe(0);
  });
});

describe("GET /admin/api/kb/suggestions/:id", () => {
  test("404 unknown id", async () => {
    const res = await fetch(url("/admin/api/kb/suggestions/99999"), authed());
    expect(res.status).toBe(404);
  });

  test("returns the suggestion (no source conv → empty context_messages)", async () => {
    const id = await createPending();
    const res = await fetch(url(`/admin/api/kb/suggestions/${id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: { id: number };
      context_messages: unknown[];
    };
    expect(body.suggestion.id).toBe(id);
    expect(body.context_messages).toEqual([]);
  });
});

describe("POST /admin/api/kb/suggestions (create)", () => {
  test("400 when question_text missing or empty", async () => {
    const missing = await fetch(
      url("/admin/api/kb/suggestions"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(missing.status).toBe(400);

    const blank = await fetch(
      url("/admin/api/kb/suggestions"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_text: "   " }),
      }),
    );
    expect(blank.status).toBe(400);
  });

  test("creates without an answer_draft → status=pending, no draft", async () => {
    const res = await fetch(
      url("/admin/api/kb/suggestions"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_text: "Сколько стоит виза?" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: { question_text: string; answer_draft: string | null; status: string };
    };
    expect(body.suggestion.question_text).toBe("Сколько стоит виза?");
    expect(body.suggestion.answer_draft).toBeNull();
    expect(body.suggestion.status).toBe("pending");
  });

  test("creates with an answer_draft → draft is set on the returned row", async () => {
    const res = await fetch(
      url("/admin/api/kb/suggestions"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question_text: "Когда подача документов?",
          answer_draft: "По будням 10–18.",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestion: { answer_draft: string } };
    expect(body.suggestion.answer_draft).toBe("По будням 10–18.");
  });
});

describe("PATCH /admin/api/kb/suggestions/:id (set draft)", () => {
  test("400 when answer_draft is not a string", async () => {
    const id = await createPending();
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer_draft: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("404 unknown id", async () => {
    const res = await fetch(
      url("/admin/api/kb/suggestions/99999"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer_draft: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("updates the draft and returns the row", async () => {
    const id = await createPending();
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer_draft: "Полный ответ" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestion: { answer_draft: string } };
    expect(body.suggestion.answer_draft).toBe("Полный ответ");
  });
});

describe("POST /admin/api/kb/suggestions/:id/reject", () => {
  test("404 when not found", async () => {
    const res = await fetch(
      url("/admin/api/kb/suggestions/99999/reject"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("marks as rejected with optional reason", async () => {
    const id = await createPending();
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/reject`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "duplicate" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: { status: string; rejected_reason: string | null };
    };
    expect(body.suggestion.status).toBe("rejected");
    expect(body.suggestion.rejected_reason).toBe("duplicate");
  });

  test("accepts empty body (reason is optional)", async () => {
    const id = await createPending();
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/reject`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestion: { rejected_reason: string | null } };
    expect(body.suggestion.rejected_reason).toBeNull();
  });
});

describe("POST /admin/api/kb/suggestions/:id/approve", () => {
  test("404 when not found", async () => {
    const res = await fetch(
      url("/admin/api/kb/suggestions/99999/approve"),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("400 when answer_draft is empty", async () => {
    const id = await createPending();
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/approve`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  test("409 when suggestion is already decided", async () => {
    // Approve requires status=pending — bounce a rejected one.
    const id = await createPending();
    const [adminRow] = await sql<{ id: number }[]>`
      INSERT INTO admins (email, password_hash) VALUES ('app-409@x', 'unused') RETURNING id
    `;
    await new KbSuggestionsRepo(sql).reject(id, adminRow!.id, "no");

    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/approve`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(409);
  });

  test("happy path: ingests into KB and marks suggestion as ingested", async () => {
    if (!FTS_AVAILABLE) return; // dict_snowball missing locally — CI covers this

    const id = await createPending();
    const repo = new KbSuggestionsRepo(sql);
    await repo.setDraft(id, "Ответ для индексирования");

    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/approve`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: { status: string };
      kb_document_id: number;
    };
    expect(body.suggestion.status).toBe("ingested");
    expect(body.kb_document_id).toBeGreaterThan(0);

    // The Q/A bundle landed in kb_documents.
    const [doc] = await sql<
      { title: string }[]
    >`SELECT title FROM kb_documents WHERE id = ${body.kb_document_id}`;
    expect(doc?.title).toContain("Что входит");
  });

  test("503 when rag is not configured", async () => {
    server.stop(true);
    // Restart without rag.
    const telegram = new TelegramClient({
      token: "t",
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as FetchLike,
    });
    const router = createRouter({ sql, telegram, webhookSecret: SECRET });
    server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
    const admins = new AdminsRepo(sql);
    if (!(await admins.byEmail("op@x.test"))) {
      await admins.create({ email: "op@x.test", password: "longenough" });
    }
    const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const id = await createPending();
    await new KbSuggestionsRepo(sql).setDraft(id, "answer");
    const res = await fetch(
      url(`/admin/api/kb/suggestions/${id}/approve`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(503);
  });
});
