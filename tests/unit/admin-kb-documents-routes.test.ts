// Coverage for `src/admin/routes/kb-documents.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;

function stubEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map(() => new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    },
  };
}

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

async function startServer(withRag: boolean) {
  const telegram = new TelegramClient({
    token: "t",
    fetch: (async () => new Response("{}")) as FetchLike,
  });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    ...(withRag
      ? { rag: { embedder: stubEmbedder() } as Parameters<typeof createRouter>[0]["rag"] }
      : {}),
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  const admins = new AdminsRepo(sql);
  // startServer may run twice in one test (rag → no-rag restart); the admin
  // row survives in the DB, so only create it the first time.
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

beforeEach(() => startServer(true), 30_000);
afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});

async function seedDoc(source: string, title: string, topic?: string) {
  const kb = new KbRepo(sql);
  const doc = await kb.upsertDocument({ source, title, contentHash: `h-${source}` });
  await kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: `${title} body`,
    tokenCount: 2,
    embedding: new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
  });
  if (topic) await kb.setTopic(doc.id, topic);
  return doc;
}

describe("GET /admin/api/kb/documents", () => {
  test("requires auth", async () => {
    expect((await fetch(url("/admin/api/kb/documents"))).status).toBe(401);
  });

  test("returns documents, topics and totals", async () => {
    await seedDoc("a.md", "Alpha", "visa");
    const res = await fetch(url("/admin/api/kb/documents"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: unknown[];
      topics: unknown[];
      totals: { documents: number; chunks: number };
    };
    expect(body.totals.documents).toBe(1);
    expect(body.totals.chunks).toBe(1);
    expect(body.topics).toContain("visa");
  });

  test("filters by the q search param", async () => {
    await seedDoc("a.md", "Alpha");
    await seedDoc("b.md", "Beta");
    const res = await fetch(url("/admin/api/kb/documents?q=Alpha"), authed());
    const body = (await res.json()) as { documents: { title: string }[] };
    expect(body.documents.every((d) => d.title.includes("Alpha"))).toBe(true);
  });
});

describe("GET /admin/api/kb/documents/:id", () => {
  test("returns the document with its chunks", async () => {
    const doc = await seedDoc("a.md", "Alpha");
    const res = await fetch(url(`/admin/api/kb/documents/${doc.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { id: number }; chunks: unknown[] };
    expect(body.document.id).toBe(doc.id);
    expect(body.chunks).toHaveLength(1);
  });

  test("404 for an unknown id, 400 for a bad id", async () => {
    expect((await fetch(url("/admin/api/kb/documents/999999"), authed())).status).toBe(404);
    expect((await fetch(url("/admin/api/kb/documents/xx"), authed())).status).toBe(400);
  });
});

describe("PATCH /admin/api/kb/documents/:id", () => {
  test("sets and clears the topic tag", async () => {
    const doc = await seedDoc("a.md", "Alpha");
    const set = await fetch(
      url(`/admin/api/kb/documents/${doc.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "payment" }),
      }),
    );
    expect(set.status).toBe(200);
    expect(((await set.json()) as { document: { topic: string } }).document.topic).toBe("payment");

    const clear = await fetch(
      url(`/admin/api/kb/documents/${doc.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: null }),
      }),
    );
    expect(((await clear.json()) as { document: { topic: null } }).document.topic).toBeNull();
  });

  test("400 for an over-long topic and a non-string topic", async () => {
    const doc = await seedDoc("a.md", "Alpha");
    const long = await fetch(
      url(`/admin/api/kb/documents/${doc.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "x".repeat(65) }),
      }),
    );
    expect(long.status).toBe(400);
    const bad = await fetch(
      url(`/admin/api/kb/documents/${doc.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: 123 }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  test("404 when patching an unknown document", async () => {
    const res = await fetch(
      url("/admin/api/kb/documents/999999"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/api/kb/documents/:id", () => {
  test("deletes an existing document", async () => {
    const doc = await seedDoc("a.md", "Alpha");
    const res = await fetch(url(`/admin/api/kb/documents/${doc.id}`), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await new KbRepo(sql).getDocument(doc.id)).toBeNull();
  });

  test("404 when deleting a missing document", async () => {
    const res = await fetch(url("/admin/api/kb/documents/999999"), authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/api/kb/ingest", () => {
  test("ingests inline text into a new document", async () => {
    const res = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Manual doc", body: "Some KB content here.", topic: "visa" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; document_id: number; created: boolean };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
  });

  test("400 when title or body is missing", async () => {
    const noTitle = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "text" }),
      }),
    );
    expect(noTitle.status).toBe(400);
    const noBody = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T" }),
      }),
    );
    expect(noBody.status).toBe(400);
  });

  test("400 for a topic with illegal characters", async () => {
    const res = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", body: "text", topic: "bad topic!" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("503 when no embedder is configured", async () => {
    server.stop(true);
    await startServer(false);
    const res = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", body: "text" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
