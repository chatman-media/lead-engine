import { type Db, DrizzleKbStore, withTenant } from "@chatman-media/conversation-engine";
import { ingestText } from "@chatman-media/kb";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { kbDocuments } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Authenticated KB management endpoints — per-tenant.
 *
 *   POST   /api/admin/kb/documents       — upload via multipart file OR JSON {title, body}
 *   GET    /api/admin/kb/documents       — list docs (sorted by createdAt DESC)
 *   DELETE /api/admin/kb/documents/:id   — delete doc + chunks
 *
 * Все under `requireAuth` middleware — middleware выставляет c.var.tenantId.
 * Каждый repo-call оборачивается в withTenant для RLS на non-bypass role'и.
 *
 * Поддерживаемые upload-форматы:
 *   - multipart/form-data: поле `file` (Blob/File), опц. `title`/`topic`
 *   - application/json:    { title, body, topic? } — paste mode
 *
 * Multipart парсится в memory через Bun's `await req.formData()` — для
 * больших файлов (>10MB) переключиться на streaming variant в future.
 * PDF / .md / .txt поддерживаются (за счёт `ingestText` который принимает
 * raw body); PDF binary не парсится в этом endpoint'е — это требует
 * `ingestFile` с filesystem path, что upload-route'у не подходит.
 * Для PDF — TODO: написать в /tmp + ingestFile + cleanup.
 */
export interface AdminKbRoutesOpts {
  db: Db;
  /** Embedder для ingest (vector indexing). Пусто = upload disabled. */
  resolveEmbedder: (tenantId: number) => EmbeddingClient;
}

export function makeAdminKbRoutes(opts: AdminKbRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/kb/documents
   * Returns list of kb_documents for the authenticated tenant, sorted
   * recent-first. Limited to 200 rows per call.
   */
  app.get("/api/admin/kb/documents", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: kbDocuments.id,
          source: kbDocuments.source,
          title: kbDocuments.title,
          topic: kbDocuments.topic,
          createdAt: kbDocuments.createdAt,
        })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId))
        .orderBy(desc(kbDocuments.createdAt))
        .limit(200);
    });
    return c.json({ items: rows });
  });

  /**
   * POST /api/admin/kb/documents
   * Two content-types accepted:
   *
   *   multipart/form-data:
   *     - file: Blob (txt/md/json; PDF не поддерживается в этом MVP)
   *     - title?: string (defaults to file.name)
   *     - topic?: string
   *
   *   application/json:
   *     - { title: string, body: string, topic?: string }
   *
   * Returns: { documentId, source, chunks, created }
   */
  app.post("/api/admin/kb/documents", async (c) => {
    const tenantId = c.var.tenantId;
    const contentType = c.req.header("Content-Type") ?? "";

    let title: string;
    let body: string;
    let topic: string | undefined;

    if (contentType.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const fileField = form.get("file");
      if (!fileField || typeof fileField === "string") {
        return c.json({ error: "missing file field" }, 400);
      }
      const file = fileField as File;
      const fileName = file.name || "upload";
      // Read as text (UTF-8). PDF binary upload requires extra step
      // (write to tmp + ingestFile) — TODO в follow-up.
      if (fileName.toLowerCase().endsWith(".pdf")) {
        return c.json({ error: "PDF upload not yet supported via this endpoint" }, 415);
      }
      body = await file.text();
      const titleField = form.get("title");
      title = typeof titleField === "string" && titleField.length > 0 ? titleField : fileName;
      const topicField = form.get("topic");
      if (typeof topicField === "string" && topicField.length > 0) topic = topicField;
    } else if (contentType.startsWith("application/json")) {
      let payload: { title?: unknown; body?: unknown; topic?: unknown };
      try {
        payload = (await c.req.json()) as typeof payload;
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
      title = typeof payload.title === "string" ? payload.title.trim() : "";
      body = typeof payload.body === "string" ? payload.body : "";
      if (typeof payload.topic === "string" && payload.topic.length > 0) topic = payload.topic;
    } else {
      return c.json({ error: "expected multipart/form-data or application/json" }, 415);
    }

    if (body.length === 0) {
      return c.json({ error: "empty body" }, 400);
    }
    if (body.length > 5_000_000) {
      // 5 MB raw text cap — beyond this нужен streaming/chunked-ingest.
      return c.json({ error: "body too large (>5MB)" }, 413);
    }
    if (!title) title = "untitled";

    // Ingest in tenant-scoped tx. KbStore методы зависят от RLS context.
    let embedder: EmbeddingClient;
    try {
      embedder = opts.resolveEmbedder(tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `embedder not configured: ${msg}` }, 503);
    }

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const kb = new DrizzleKbStore({ db: tx, tenantId });
        return ingestText(
          { title, body },
          {
            kb,
            // llm-router's EmbeddingClient structurally compatible with kb's
            // EmbeddingClient (.embed(inputs) → number[][] + .dim). Cast OK.
            embedder: embedder as unknown as Parameters<typeof ingestText>[1]["embedder"],
            ...(topic !== undefined ? { topic } : {}),
          },
        );
      });
      return c.json({
        documentId: result.documentId,
        source: result.source,
        chunks: result.chunks,
        created: result.created,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `ingest failed: ${msg}` }, 500);
    }
  });

  /**
   * DELETE /api/admin/kb/documents/:id
   * Cascade-deletes document + chunks (FK ON DELETE CASCADE на kb_chunks).
   */
  app.delete("/api/admin/kb/documents/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const result = await tx
        .delete(kbDocuments)
        .where(and(eq(kbDocuments.id, id), eq(kbDocuments.tenantId, tenantId)))
        .returning({ id: kbDocuments.id });
      return result.length;
    });
    if (deleted === 0) return c.json({ error: "document not found" }, 404);
    return c.json({ ok: true, deleted });
  });

  return app;
}
