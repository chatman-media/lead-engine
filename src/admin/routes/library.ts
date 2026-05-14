import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KbRepo } from "../../db/repos/kb.ts";
import { ingestFile } from "../../rag/ingest.ts";
import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Library: book file upload ───────────────────────────────────────────

const BOOK_TOPIC = "books";
/** 50 MB upload cap — enough for a dense PDF, guards against abuse. */
const BOOK_MAX_BYTES = 50 * 1024 * 1024;
const BOOK_ALLOWED_EXTS = new Set([".pdf", ".txt", ".md"]);

/**
 * POST /admin/api/kb/books/upload
 * Accepts a multipart/form-data with a single `file` field (PDF/TXT/MD).
 * Writes a temp file, runs `ingestFile` with topic="books", then cleans up.
 * Returns { ok, document_id, chunks, created, filename }.
 */
export function createUploadBookHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;

    if (!deps.rag?.embedder) {
      return json(
        { error: "embedder not configured — set OLLAMA_HOST or LLM_PROVIDER" },
        { status: 503 },
      );
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return json({ error: "multipart body expected" }, { status: 400 });
    }

    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) {
      return json({ error: "field 'file' is required" }, { status: 400 });
    }

    const originalName = fileEntry.name;
    const ext = originalName.slice(originalName.lastIndexOf(".")).toLowerCase();
    if (!BOOK_ALLOWED_EXTS.has(ext)) {
      return json(
        { error: `unsupported file type: ${ext} (allowed: pdf, txt, md)` },
        { status: 400 },
      );
    }

    const bytes = await fileEntry.arrayBuffer();
    if (bytes.byteLength > BOOK_MAX_BYTES) {
      return json(
        { error: `file too large (max ${BOOK_MAX_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    const tmpPath = join(tmpdir(), `book-upload-${Date.now()}${ext}`);
    try {
      writeFileSync(tmpPath, new Uint8Array(bytes));
    } catch {
      return json({ error: "failed to write temp file" }, { status: 500 });
    }

    const kb = new KbRepo(deps.sql);
    try {
      const result = await ingestFile(tmpPath, {
        kb,
        embedder: deps.rag.embedder,
        topic: BOOK_TOPIC,
      });
      return json({
        ok: true,
        document_id: result.documentId,
        chunks: result.chunks,
        created: result.created,
        filename: originalName,
      });
    } catch (err) {
      console.error("[admin] uploadBook ingestFile failed:", err);
      return json(
        { error: `ingest failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors — temp dir is cleaned by OS anyway.
      }
    }
  };
}
