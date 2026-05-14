import { KbRepo } from "../../db/repos/kb.ts";
import { ingestText } from "../../rag/ingest.ts";
import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

const KB_TOPIC_MAX = 64;

export function createListKbDocumentsHandler(deps: AdminApiDeps): RouteHandler {
  const kb = new KbRepo(deps.sql);
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const url = new URL(req.url);
    // Sentinel "__untagged__" lets the UI request NULL-topic docs without
    // overloading the empty string. Other values pass through verbatim.
    const topicParam = url.searchParams.get("topic");
    const q = url.searchParams.get("q") ?? undefined;
    const opts: { topic?: string | null; q?: string; limit?: number } = {};
    if (topicParam !== null) opts.topic = topicParam;
    if (q) opts.q = q;
    const documents = await kb.listDocuments(opts);
    return json({
      documents,
      topics: await kb.listTopics(),
      totals: { documents: await kb.countDocuments(), chunks: await kb.countChunks() },
    });
  };
}

export function createGetKbDocumentHandler(deps: AdminApiDeps): RouteHandler {
  const kb = new KbRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const doc = await kb.getDocument(id);
    if (!doc) return json({ error: "not found" }, { status: 404 });
    // Truncate chunk text in the listing — full text is rarely useful at the
    // overview level and balloons the JSON response on long docs.
    const chunks = (await kb.listChunks(id)).map((c) => ({
      id: c.id,
      chunk_index: c.chunk_index,
      token_count: c.token_count,
      text: c.text,
    }));
    return json({ document: doc, chunks });
  };
}

export function createUpdateKbDocumentHandler(deps: AdminApiDeps): RouteHandler {
  const kb = new KbRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    let body: { topic?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    // `null` (or empty string) clears the tag; any string trims + length-checks.
    let nextTopic: string | null;
    if (body.topic === null || body.topic === "") {
      nextTopic = null;
    } else if (typeof body.topic === "string") {
      const trimmed = body.topic.trim();
      if (!trimmed) {
        nextTopic = null;
      } else if (trimmed.length > KB_TOPIC_MAX) {
        return json({ error: `topic > ${KB_TOPIC_MAX}` }, { status: 400 });
      } else {
        nextTopic = trimmed;
      }
    } else {
      return json({ error: "topic must be string or null" }, { status: 400 });
    }
    const updated = await kb.setTopic(id, nextTopic);
    if (!updated) return json({ error: "not found" }, { status: 404 });
    return json({ document: updated });
  };
}

export function createDeleteKbDocumentHandler(deps: AdminApiDeps): RouteHandler {
  const kb = new KbRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const ok = await kb.deleteDocument(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  };
}

const KB_TITLE_MAX = 200;
const KB_BODY_MAX = 200_000; // 200KB upper bound — enough for any single doc

/**
 * Ingest a single document from inline text. Used by the admin UI "+ ADD"
 * form so operators can paste markdown / plain text into the KB without
 * a shell. Pipes through `ingestText` (chunking + embedding).
 *
 * Returns 503 when `rag` deps are absent — without an embedder we can't
 * insert vectors, and inserting a document with zero retrievable chunks
 * is silently broken. Better to fail loud.
 *
 * Idempotent: identical body content (same SHA-256) returns the existing
 * document row instead of creating a duplicate. Re-ingest after a tag
 * change deletes + re-creates with the new topic.
 */
export function createIngestKbDocumentHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;

    if (!deps.rag?.embedder) {
      return json(
        { error: "embedder not configured — set OLLAMA_HOST or LLM_PROVIDER" },
        { status: 503 },
      );
    }

    let body: { title?: unknown; body?: unknown; topic?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body : "";
    if (!title) return json({ error: "title is required" }, { status: 400 });
    if (!text.trim()) return json({ error: "body is required" }, { status: 400 });
    if (title.length > KB_TITLE_MAX) {
      return json({ error: `title > ${KB_TITLE_MAX}` }, { status: 400 });
    }
    if (text.length > KB_BODY_MAX) {
      return json({ error: `body > ${KB_BODY_MAX} bytes` }, { status: 400 });
    }

    let topic: string | null = null;
    if (typeof body.topic === "string") {
      const trimmed = body.topic.trim();
      if (trimmed.length > KB_TOPIC_MAX) {
        return json({ error: `topic > ${KB_TOPIC_MAX}` }, { status: 400 });
      }
      // Match the slug shape the rest of the topic system uses (kebab-ish:
      // letters, digits, hyphen, underscore). Anything else is rejected
      // so we don't accumulate garbage like "  Visa  " vs "visa".
      if (trimmed && !/^[a-z][a-z0-9_-]{0,49}$/i.test(trimmed)) {
        return json({ error: "topic must be alphanumeric / hyphen / underscore" }, { status: 400 });
      }
      topic = trimmed.toLowerCase() || null;
    }

    const kb = new KbRepo(deps.sql);
    try {
      const result = await ingestText(
        { title, body: text },
        {
          kb,
          embedder: deps.rag.embedder,
          ...(topic !== null ? { topic } : {}),
        },
      );
      return json({
        ok: true,
        document_id: result.documentId,
        chunks: result.chunks,
        created: result.created,
      });
    } catch (err) {
      console.error("[admin] ingestText failed:", err);
      return json(
        { error: `ingest failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  };
}
