import { type Db, DrizzleKbStore, withTenant } from "@chatman-media/conversation-engine";
import { ingestText, parsePdfBuffer } from "@chatman-media/kb";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { kbDocuments, kbSuggestions } from "@chatman-media/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { canAddKbDocument } from "../lib/quota.ts";

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
 * больших файлов (>10MB) переключиться на streaming variant in future.
 * Поддерживаемые форматы файлов: .pdf (text-based), .txt, .md, .json и
 * любые UTF-8 текстовые форматы. Scanned PDF (без текстового слоя) вернёт
 * 422 — нужен предварительный OCR.
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
   *     - file: Blob (.pdf, .txt, .md, .json и любой UTF-8 текстовый формат)
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
      if (fileName.toLowerCase().endsWith(".pdf")) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        try {
          body = await parsePdfBuffer(buffer);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `PDF parse failed: ${msg}` }, 422);
        }
        if (body.length === 0) {
          return c.json(
            { error: "PDF contains no extractable text (possibly scanned image — use OCR first)" },
            422,
          );
        }
      } else {
        body = await file.text();
      }
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

    // Plan-aware quota check (free=50, starter=500, pro=10K). Same-content
    // re-upload dedup'ится по content_hash — будет created=false и НЕ
    // увеличит count, поэтому проверка тут на add-новый-doc корректна для
    // подавляющего числа cases (edge: дубль точно вписался бы over-limit,
    // но dedup ловит — допустимое misalignment).
    const quota = await canAddKbDocument({ db: opts.db, tenantId });
    if (!quota.allowed) {
      return c.json(
        {
          error: "quota_exceeded",
          reason: quota.reason,
          limit: quota.limit,
          current: quota.current,
          plan: quota.plan,
          planLabel: quota.planLabel,
          upgradeHint: "Перейдите на план Starter ($99/мес) для большей базы знаний",
        },
        402,
      );
    }

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

  /**
   * GET /api/admin/kb/suggestions
   * Query: ?status=pending|ingested|rejected (default: pending) | ?limit | ?offset
   */
  app.get("/api/admin/kb/suggestions", async (c) => {
    const tenantId = c.var.tenantId;
    const status = c.req.query("status") ?? "pending";
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);

    const items = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(kbSuggestions)
        .where(and(eq(kbSuggestions.tenantId, tenantId), eq(kbSuggestions.status, status)))
        .orderBy(desc(kbSuggestions.createdAt))
        .limit(limit)
        .offset(offset),
    );

    const pendingRows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(kbSuggestions)
        .where(and(eq(kbSuggestions.tenantId, tenantId), eq(kbSuggestions.status, "pending"))),
    );

    return c.json({ items, pendingCount: pendingRows[0]?.n ?? 0, limit, offset });
  });

  /**
   * PATCH /api/admin/kb/suggestions/:id
   * Body: { action: "approve" | "reject", answerDraft?: string, rejectedReason?: string }
   * approve → ingests answerDraft as KB doc, sets status=ingested
   * reject  → sets status=rejected
   */
  app.patch("/api/admin/kb/suggestions/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const body = await c.req.json<{
      action: "approve" | "reject";
      answerDraft?: string;
      rejectedReason?: string;
    }>();
    const now = Math.floor(Date.now() / 1000);

    const [suggestion] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(kbSuggestions)
        .where(and(eq(kbSuggestions.id, id), eq(kbSuggestions.tenantId, tenantId))),
    );
    if (!suggestion) return c.json({ error: "suggestion not found" }, 404);
    if (suggestion.status !== "pending") return c.json({ error: "already decided" }, 409);

    if (body.action === "reject") {
      await withTenant(opts.db, tenantId, async (tx) =>
        tx
          .update(kbSuggestions)
          .set({
            status: "rejected",
            rejectedReason: body.rejectedReason ?? null,
            decidedByAdminId: adminId ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(kbSuggestions.id, id)),
      );
      return c.json({ ok: true });
    }

    // approve: ingest answer as KB document
    const title = suggestion.questionText.slice(0, 100);
    const bodyText = body.answerDraft ?? suggestion.answerDraft ?? "";
    if (!bodyText.trim()) return c.json({ error: "answerDraft required to approve" }, 400);

    let embedder: EmbeddingClient;
    try {
      embedder = opts.resolveEmbedder(tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `embedder not configured: ${msg}` }, 503);
    }

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const kb = new DrizzleKbStore({ db: tx, tenantId });
      return ingestText(
        { title, body: bodyText },
        {
          kb,
          embedder: embedder as unknown as Parameters<typeof ingestText>[1]["embedder"],
        },
      );
    });

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(kbSuggestions)
        .set({
          status: "ingested",
          answerDraft: bodyText,
          kbDocumentId: result.documentId,
          decidedByAdminId: adminId ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(kbSuggestions.id, id)),
    );

    return c.json({ ok: true, kbDocumentId: result.documentId });
  });

  return app;
}
