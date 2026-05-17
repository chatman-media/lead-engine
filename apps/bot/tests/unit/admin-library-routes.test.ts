// Coverage for `src/admin/routes/library.ts` — baseline was 15.29% lines.
// Single endpoint: book file upload → ingest into KB. Failure modes here
// are common (oversized files, wrong extensions) and the happy path writes
// kb_documents + kb_chunks rows, so worth a regression net.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;

const sql = getTestSql();

// The kb_chunks table has a GENERATED column `fts = to_tsvector('russian',
// text)` — needs the russian snowball dictionary. The pgvector/pgvector:pg16
// image used in CI bundles it; some dev Postgres installs on macOS do not.
// Probe once at startup and skip the happy-path tests when missing so the
// file runs cleanly on a stock dev machine without false-failing the suite.
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

async function startServer(opts: { withRag: boolean }): Promise<void> {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    // Cast satisfies the optional RagDeps shape — handler only touches
    // `embedder`, so the stub is enough.
    ...(opts.withRag
      ? { rag: { embedder: stubEmbedder() } as Parameters<typeof createRouter>[0]["rag"] }
      : {}),
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  const admins = new AdminsRepo(sql);
  // startServer can be called twice in the same test (we tear down + restart
  // to flip the rag dep). cleanTestDb only runs between tests, so guard
  // against the UNIQUE(email) constraint on re-create.
  if (!(await admins.byEmail("op@x.test"))) {
    await admins.create({ email: "op@x.test", password: "longenough" });
  }
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  await startServer({ withRag: true });
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

function makeFormData(filename: string, content: string, mimeType = "text/plain"): FormData {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: mimeType }), filename);
  return fd;
}

describe("POST /admin/api/kb/books/upload", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/kb/books/upload"), {
      method: "POST",
      body: makeFormData("x.txt", "hi"),
    });
    expect(res.status).toBe(401);
  });

  test("503 when embedder is not configured", async () => {
    server.stop(true);
    await startServer({ withRag: false });
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({ method: "POST", body: makeFormData("x.txt", "hi") }),
    );
    expect(res.status).toBe(503);
  });

  test("400 when body is not multipart/form-data", async () => {
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ not: "multipart" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when 'file' field is missing", async () => {
    const fd = new FormData();
    fd.append("not_file", "oops");
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({ method: "POST", body: fd }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when extension is not in {pdf, txt, md}", async () => {
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({ method: "POST", body: makeFormData("nope.docx", "content") }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unsupported file type/);
  });

  test("400 when filename has no extension", async () => {
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({ method: "POST", body: makeFormData("noext", "content") }),
    );
    expect(res.status).toBe(400);
  });

  test("413 when file exceeds 50 MB cap", async () => {
    // 51 MB of zero bytes — `Blob` accepts a Uint8Array directly.
    const big = new Uint8Array(51 * 1024 * 1024);
    const fd = new FormData();
    fd.append("file", new Blob([big], { type: "application/pdf" }), "big.pdf");
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({ method: "POST", body: fd }),
    );
    expect(res.status).toBe(413);
  });

  test("happy path: .txt file ingests + persists kb_document with topic=books", async () => {
    if (!FTS_AVAILABLE) return; // dict_snowball missing locally — CI exercises this branch
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({
        method: "POST",
        body: makeFormData(
          "sample.txt",
          "Sales technique: open with a question, then a one-line value proposition.",
        ),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      document_id: number;
      chunks: number;
      created: boolean;
      filename: string;
    };
    expect(body.ok).toBe(true);
    expect(body.document_id).toBeGreaterThan(0);
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.created).toBe(true);
    expect(body.filename).toBe("sample.txt");

    // The handler enforces topic='books' — verify it landed on the row.
    const [doc] = await sql<
      { topic: string | null }[]
    >`SELECT topic FROM kb_documents WHERE id = ${body.document_id}`;
    expect(doc?.topic).toBe("books");
  });

  test("happy path: .md file also accepted", async () => {
    if (!FTS_AVAILABLE) return;
    const res = await fetch(
      url("/admin/api/kb/books/upload"),
      authed({
        method: "POST",
        body: makeFormData("notes.md", "# Notes\n\nSome content here for indexing."),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { filename: string };
    expect(body.filename).toBe("notes.md");
  });

  test("re-upload of identical content returns created=false (idempotency)", async () => {
    if (!FTS_AVAILABLE) return;
    const sameText = "deterministic content for idempotency check";
    const first = (await (
      await fetch(
        url("/admin/api/kb/books/upload"),
        authed({ method: "POST", body: makeFormData("dup.txt", sameText) }),
      )
    ).json()) as { document_id: number; created: boolean };
    expect(first.created).toBe(true);

    const second = (await (
      await fetch(
        url("/admin/api/kb/books/upload"),
        authed({ method: "POST", body: makeFormData("dup.txt", sameText) }),
      )
    ).json()) as { document_id: number; created: boolean };
    // Same source path on disk + same content_hash → ingestFile reuses the
    // existing document_id and reports created=false.
    expect(second.created).toBe(false);
    expect(second.document_id).toBe(first.document_id);
  });
});
