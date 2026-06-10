import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Db, DrizzleKbStore, withTenant } from "@chatman-media/conversation-engine";
import { chunkText, ingestText, type KbScope, parsePdfBuffer, stripNonContent } from "@chatman-media/kb";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { funnels, kbChunks, kbDocuments, kbSuggestions, stageDefinitions, stageFields } from "@chatman-media/storage";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  buildKbRequirementDrafts,
  coverKbRequirements,
  type KbRequirement,
} from "../lib/kb-requirements.ts";
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
  /** Embedder для ingest/search/reindex. Может бросить ошибку, если embeddings не настроены. */
  resolveEmbedder: (tenantId: number) => EmbeddingClient;
}

type KbDocumentFormat = "text" | "markdown" | "pdf" | "json";
type KbIndexStatus = "empty" | "text_only" | "partial" | "embedded";
type KbSearchMode = "hybrid" | "text";

type KbIndexStats = {
  chunksCount: number;
  embeddedChunksCount: number;
};

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

type StoredKbFile = {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

class KbUploadHttpError extends Error {
  constructor(
    public readonly status: 413 | 422,
    message: string,
  ) {
    super(message);
    this.name = "KbUploadHttpError";
  }
}

function inferKbDocumentFormat(input: {
  source: string;
  title: string;
  fileName?: string | null;
  fileMimeType?: string | null;
}): KbDocumentFormat {
  const mime = input.fileMimeType?.toLowerCase() ?? "";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("markdown")) return "markdown";
  if (mime.includes("json")) return "json";

  const value = `${input.title} ${input.source} ${input.fileName ?? ""}`.toLowerCase();
  if (/\.(pdf)(\?|#|\s|$)/.test(value)) return "pdf";
  if (/\.(md|markdown)(\?|#|\s|$)/.test(value)) return "markdown";
  if (/\.(json)(\?|#|\s|$)/.test(value)) return "json";
  return "text";
}

function maxKbUploadBytes(): number {
  const raw = Number.parseInt(process.env.KB_MAX_UPLOAD_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES;
}

function kbUploadRoot(): string {
  return resolve(process.env.KB_UPLOAD_DIR ?? join(process.cwd(), "data", "kb-files"));
}

function sanitizeFileName(input: string): string {
  const cleaned = input
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "upload";
}

function storedFileKey(input: {
  tenantId: number;
  documentId: number;
  fileName: string;
  bytes: Uint8Array;
}): string {
  const hash = createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);
  return [
    `tenant-${input.tenantId}`,
    `doc-${input.documentId}-${hash}-${sanitizeFileName(input.fileName)}`,
  ].join("/");
}

function storedFilePath(key: string): string {
  const root = kbUploadRoot();
  const full = resolve(root, key);
  if (!full.startsWith(`${root}/`) && full !== root) {
    throw new Error("invalid stored file key");
  }
  return full;
}

async function saveStoredKbFile(input: {
  tenantId: number;
  documentId: number;
  file: StoredKbFile;
}) {
  const key = storedFileKey({
    tenantId: input.tenantId,
    documentId: input.documentId,
    fileName: input.file.fileName,
    bytes: input.file.bytes,
  });
  const path = storedFilePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.file.bytes);
  return {
    fileStorageKey: key,
    fileName: sanitizeFileName(input.file.fileName),
    fileMimeType: input.file.mimeType || "application/octet-stream",
    fileSizeBytes: input.file.sizeBytes,
    fileUploadedAt: Math.floor(Date.now() / 1000),
  };
}

async function deleteStoredKbFile(key: string | null): Promise<void> {
  if (!key) return;
  await unlink(storedFilePath(key)).catch(() => {});
}

function contentDispositionInline(fileName: string): string {
  const safe = sanitizeFileName(fileName).replace(/"/g, "'");
  return `inline; filename="${safe}"`;
}

function docFileFields(doc: {
  fileStorageKey: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  fileSizeBytes: number | null;
  fileUploadedAt: number | null;
}) {
  return {
    hasStoredFile: doc.fileStorageKey !== null,
    fileName: doc.fileName,
    fileMimeType: doc.fileMimeType,
    fileSizeBytes: doc.fileSizeBytes,
    fileUploadedAt: doc.fileUploadedAt,
  };
}

function kbIndexStatus(stats: KbIndexStats): KbIndexStatus {
  if (stats.chunksCount <= 0) return "empty";
  if (stats.embeddedChunksCount <= 0) return "text_only";
  if (stats.embeddedChunksCount < stats.chunksCount) return "partial";
  return "embedded";
}

function docIndexFields(stats?: Partial<KbIndexStats> | null) {
  const normalized = {
    chunksCount: stats?.chunksCount ?? 0,
    embeddedChunksCount: stats?.embeddedChunksCount ?? 0,
  };
  return {
    ...normalized,
    indexStatus: kbIndexStatus(normalized),
  };
}

function vectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) throw new Error("empty embedding vector");
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding contains non-finite value");
  }
  return `[${embedding.join(",")}]`;
}

async function readUploadFile(file: File): Promise<{ body: string; originalFile: StoredKbFile }> {
  const fileName = file.name || "upload";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxKbUploadBytes()) {
    throw new KbUploadHttpError(413, "file too large");
  }
  const originalFile = {
    // Some parsers can detach/move the input ArrayBuffer. Keep an
    // independent copy for hashing and durable file storage.
    bytes: new Uint8Array(bytes),
    fileName,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: bytes.byteLength,
  };
  if (fileName.toLowerCase().endsWith(".pdf")) {
    let body: string;
    try {
      body = await parsePdfBuffer(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KbUploadHttpError(422, `PDF parse failed: ${msg}`);
    }
    if (body.length === 0) {
      throw new KbUploadHttpError(
        422,
        "PDF contains no extractable text (possibly scanned image — use OCR first)",
      );
    }
    return { body, originalFile };
  }
  return { body: new TextDecoder("utf-8").decode(bytes), originalFile };
}

function preparedKbText(input: { body: string; fileName: string }): string {
  return input.fileName.toLowerCase().endsWith(".pdf")
    ? input.body
    : stripNonContent(input.body);
}

function textContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parseSearchLimit(value: unknown): number {
  const n = parsePositiveInt(value);
  if (!n) return DEFAULT_SEARCH_LIMIT;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseScope(input: {
  scopeType?: unknown;
  funnelId?: unknown;
  stageSlug?: unknown;
}): { scope: KbScope; error?: never } | { scope?: never; error: string } {
  const rawType = typeof input.scopeType === "string" ? input.scopeType : "global";
  if (rawType !== "global" && rawType !== "funnel" && rawType !== "stage") {
    return { error: "scopeType must be global, funnel or stage" };
  }
  if (rawType === "global") return { scope: { scopeType: "global" } };

  const funnelId = parsePositiveInt(input.funnelId);
  if (!funnelId) return { error: "funnelId required for scoped KB document" };
  if (rawType === "funnel") return { scope: { scopeType: "funnel", funnelId } };

  const stageSlug = typeof input.stageSlug === "string" ? input.stageSlug.trim() : "";
  if (!stageSlug) return { error: "stageSlug required for stage-scoped KB document" };
  return { scope: { scopeType: "stage", funnelId, stageSlug } };
}

function scopeToDbFields(scope: KbScope): {
  scopeType: KbScope["scopeType"];
  funnelId: number | null;
  stageSlug: string | null;
} {
  return {
    scopeType: scope.scopeType,
    funnelId: scope.scopeType === "global" ? null : scope.funnelId ?? null,
    stageSlug: scope.scopeType === "stage" ? scope.stageSlug ?? null : null,
  };
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
    const scopeTypeParam = c.req.query("scopeType");
    const funnelIdParam = c.req.query("funnelId");
    const stageSlugParam = c.req.query("stageSlug");
    const scopeFilter =
      scopeTypeParam
        ? parseScope({
            scopeType: scopeTypeParam,
            funnelId: funnelIdParam,
            stageSlug: stageSlugParam,
          })
        : null;
    if (scopeFilter?.error) return c.json({ error: scopeFilter.error }, 400);
    const scopeDb = scopeFilter?.scope ? scopeToDbFields(scopeFilter.scope) : null;
    const funnelFilter = scopeTypeParam ? null : parsePositiveInt(funnelIdParam);
    if (!scopeTypeParam && funnelIdParam && !funnelFilter) {
      return c.json({ error: "bad funnelId" }, 400);
    }
    const stageFilter = scopeTypeParam ? null : stageSlugParam?.trim();
    if (!scopeTypeParam && stageFilter && !funnelFilter) {
      return c.json({ error: "funnelId required for stageSlug filter" }, 400);
    }
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: kbDocuments.id,
          source: kbDocuments.source,
          title: kbDocuments.title,
          topic: kbDocuments.topic,
          scopeType: kbDocuments.scopeType,
          funnelId: kbDocuments.funnelId,
          stageSlug: kbDocuments.stageSlug,
          fileStorageKey: kbDocuments.fileStorageKey,
          fileName: kbDocuments.fileName,
          fileMimeType: kbDocuments.fileMimeType,
          fileSizeBytes: kbDocuments.fileSizeBytes,
          fileUploadedAt: kbDocuments.fileUploadedAt,
          createdAt: kbDocuments.createdAt,
        })
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.tenantId, tenantId),
            scopeDb ? eq(kbDocuments.scopeType, scopeDb.scopeType) : undefined,
            scopeDb?.funnelId !== null && scopeDb?.funnelId !== undefined
              ? eq(kbDocuments.funnelId, scopeDb.funnelId)
              : scopeDb
                ? sql`${kbDocuments.funnelId} IS NULL`
                : undefined,
            scopeDb?.stageSlug !== null && scopeDb?.stageSlug !== undefined
              ? eq(kbDocuments.stageSlug, scopeDb.stageSlug)
              : scopeDb
                ? sql`${kbDocuments.stageSlug} IS NULL`
                : undefined,
            funnelFilter ? eq(kbDocuments.funnelId, funnelFilter) : undefined,
            funnelFilter && !stageFilter
              ? inArray(kbDocuments.scopeType, ["funnel", "stage"])
              : undefined,
            stageFilter ? eq(kbDocuments.scopeType, "stage") : undefined,
            stageFilter ? eq(kbDocuments.stageSlug, stageFilter) : undefined,
          ),
        )
        .orderBy(desc(kbDocuments.createdAt))
        .limit(200);
      const [storage] = await tx
        .select({
          storedFiles: sql<number>`count(${kbDocuments.fileStorageKey})::int`,
          totalBytes: sql<number>`coalesce(sum(${kbDocuments.fileSizeBytes}), 0)::int`,
        })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId));
      const statsRows =
        rows.length > 0
          ? await tx
              .select({
                documentId: kbChunks.documentId,
                chunksCount: sql<number>`count(*)::int`,
                embeddedChunksCount: sql<number>`count(${kbChunks.embedding})::int`,
              })
              .from(kbChunks)
              .where(
                and(
                  eq(kbChunks.tenantId, tenantId),
                  inArray(
                    kbChunks.documentId,
                    rows.map((row) => row.id),
                  ),
                ),
              )
              .groupBy(kbChunks.documentId)
          : [];
      const statsByDocumentId = new Map(
        statsRows.map((stats) => [
          stats.documentId,
          {
            chunksCount: stats.chunksCount,
            embeddedChunksCount: stats.embeddedChunksCount,
          },
        ]),
      );
      return {
        rows: rows.map((row) => ({
          ...row,
          ...docIndexFields(statsByDocumentId.get(row.id)),
        })),
        storage: {
          storedFiles: storage?.storedFiles ?? 0,
          totalBytes: storage?.totalBytes ?? 0,
          maxUploadBytes: maxKbUploadBytes(),
        },
      };
    });
    return c.json({
      items: result.rows.map((row) => ({
        ...row,
        format: inferKbDocumentFormat(row),
        ...docFileFields(row),
        fileStorageKey: undefined,
      })),
      storage: result.storage,
    });
  });

  /**
   * GET /api/admin/kb/documents/:id
   * Returns document metadata and reconstructed text from chunks for
   * admin-side preview.
   */
  app.get("/api/admin/kb/documents/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [doc] = await tx
        .select({
          id: kbDocuments.id,
          source: kbDocuments.source,
          title: kbDocuments.title,
          topic: kbDocuments.topic,
          scopeType: kbDocuments.scopeType,
          funnelId: kbDocuments.funnelId,
          stageSlug: kbDocuments.stageSlug,
          fileStorageKey: kbDocuments.fileStorageKey,
          fileName: kbDocuments.fileName,
          fileMimeType: kbDocuments.fileMimeType,
          fileSizeBytes: kbDocuments.fileSizeBytes,
          fileUploadedAt: kbDocuments.fileUploadedAt,
          createdAt: kbDocuments.createdAt,
        })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, id)))
        .limit(1);
      if (!doc) return null;

      const chunks = await tx
        .select({
          chunkIndex: kbChunks.chunkIndex,
          text: kbChunks.text,
          tokenCount: kbChunks.tokenCount,
        })
        .from(kbChunks)
        .where(and(eq(kbChunks.tenantId, tenantId), eq(kbChunks.documentId, id)))
        .orderBy(asc(kbChunks.chunkIndex));
      const [stats] = await tx
        .select({
          chunksCount: sql<number>`count(*)::int`,
          embeddedChunksCount: sql<number>`count(${kbChunks.embedding})::int`,
        })
        .from(kbChunks)
        .where(and(eq(kbChunks.tenantId, tenantId), eq(kbChunks.documentId, id)));

      return {
        ...doc,
        format: inferKbDocumentFormat(doc),
        ...docFileFields(doc),
        ...docIndexFields(stats),
        fileStorageKey: undefined,
        text: chunks.map((chunk) => chunk.text).join("\n\n"),
        chunks,
      };
    });

    if (!result) return c.json({ error: "document not found" }, 404);
    return c.json({ item: result });
  });

  /**
   * GET /api/admin/kb/documents/:id/file
   * Streams the original stored upload file.
   */
  app.get("/api/admin/kb/documents/:id/file", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const doc = await withTenant(opts.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          fileStorageKey: kbDocuments.fileStorageKey,
          fileName: kbDocuments.fileName,
          fileMimeType: kbDocuments.fileMimeType,
          fileSizeBytes: kbDocuments.fileSizeBytes,
        })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, id)))
        .limit(1);
      return row ?? null;
    });
    if (!doc) return c.json({ error: "document not found" }, 404);
    if (!doc.fileStorageKey) return c.json({ error: "stored file not found" }, 404);

    const file = Bun.file(storedFilePath(doc.fileStorageKey));
    if (!(await file.exists())) return c.json({ error: "stored file missing on disk" }, 404);

    return new Response(file, {
      headers: {
        "Content-Type": doc.fileMimeType ?? "application/octet-stream",
        "Content-Disposition": contentDispositionInline(doc.fileName ?? "upload"),
        ...(doc.fileSizeBytes !== null ? { "Content-Length": String(doc.fileSizeBytes) } : {}),
      },
    });
  });

  /**
   * POST /api/admin/kb/documents/:id/file
   * Replaces the original stored upload and re-indexes chunks in-place so
   * document id, scope and topic remain stable.
   */
  app.post("/api/admin/kb/documents/:id/file", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      return c.json({ error: "expected multipart/form-data" }, 415);
    }

    const form = await c.req.formData();
    const fileField = form.get("file");
    if (!fileField || typeof fileField === "string") {
      return c.json({ error: "missing file field" }, 400);
    }

    let parsed: Awaited<ReturnType<typeof readUploadFile>>;
    try {
      parsed = await readUploadFile(fileField as File);
    } catch (err) {
      if (err instanceof KbUploadHttpError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    if (parsed.body.length === 0) return c.json({ error: "empty body" }, 400);
    if (parsed.body.length > 5_000_000) {
      return c.json({ error: "body too large (>5MB)" }, 413);
    }

    const existing = await withTenant(opts.db, tenantId, async (tx) => {
      const [doc] = await tx
        .select({
          id: kbDocuments.id,
          source: kbDocuments.source,
          title: kbDocuments.title,
          topic: kbDocuments.topic,
          scopeType: kbDocuments.scopeType,
          funnelId: kbDocuments.funnelId,
          stageSlug: kbDocuments.stageSlug,
          fileStorageKey: kbDocuments.fileStorageKey,
          createdAt: kbDocuments.createdAt,
        })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, id)))
        .limit(1);
      return doc ?? null;
    });
    if (!existing) return c.json({ error: "document not found" }, 404);

    let embedder: EmbeddingClient;
    try {
      embedder = opts.resolveEmbedder(tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `embedder not configured: ${msg}` }, 503);
    }

    const preparedText = preparedKbText({
      body: parsed.body,
      fileName: parsed.originalFile.fileName,
    });
    const chunks = chunkText(preparedText);
    let vectors: number[][] = [];
    if (chunks.length > 0) {
      vectors = await embedder.embed(chunks.map((chunk) => chunk.text));
    }

    const fileMeta = await saveStoredKbFile({
      tenantId,
      documentId: id,
      file: parsed.originalFile,
    });
    let committed = false;
    try {
      await withTenant(opts.db, tenantId, async (tx) => {
        await tx
          .delete(kbChunks)
          .where(and(eq(kbChunks.tenantId, tenantId), eq(kbChunks.documentId, id)));
        await tx
          .update(kbDocuments)
          .set({
            contentHash: textContentHash(parsed.body),
            ...fileMeta,
          })
          .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, id)));
        const kb = new DrizzleKbStore({ db: tx, tenantId });
        for (const [index, chunk] of chunks.entries()) {
          const vec = vectors[index];
          if (!vec) throw new Error(`embedder returned no vector for chunk ${index}`);
          await kb.insertChunkWithEmbedding({
            documentId: id,
            chunkIndex: chunk.index,
            text: chunk.text,
            tokenCount: chunk.tokenCount,
            embedding: vec,
          });
        }
      });
      committed = true;
    } finally {
      if (!committed) {
        await deleteStoredKbFile(fileMeta.fileStorageKey);
      }
    }
    if (existing.fileStorageKey && existing.fileStorageKey !== fileMeta.fileStorageKey) {
      await deleteStoredKbFile(existing.fileStorageKey);
    }

    const item = {
      ...existing,
      ...fileMeta,
      format: inferKbDocumentFormat({
        ...existing,
        fileName: fileMeta.fileName,
        fileMimeType: fileMeta.fileMimeType,
      }),
      ...docFileFields(fileMeta),
      ...docIndexFields({
        chunksCount: chunks.length,
        embeddedChunksCount: chunks.length,
      }),
      fileStorageKey: undefined,
      text: chunks.map((chunk) => chunk.text).join("\n\n"),
      chunks: chunks.map((chunk) => ({
        chunkIndex: chunk.index,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
      })),
    };
    return c.json({ item });
  });

  /**
   * POST /api/admin/kb/documents/:id/reindex
   * Rebuilds vector embeddings for existing chunks without touching document
   * metadata, scope or stored original file.
   */
  app.post("/api/admin/kb/documents/:id/reindex", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const existing = await withTenant(opts.db, tenantId, async (tx) => {
      const [doc] = await tx
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, id)))
        .limit(1);
      if (!doc) return null;
      const chunks = await tx
        .select({
          id: kbChunks.id,
          chunkIndex: kbChunks.chunkIndex,
          text: kbChunks.text,
        })
        .from(kbChunks)
        .where(and(eq(kbChunks.tenantId, tenantId), eq(kbChunks.documentId, id)))
        .orderBy(asc(kbChunks.chunkIndex));
      return { doc, chunks };
    });
    if (!existing) return c.json({ error: "document not found" }, 404);
    if (existing.chunks.length === 0) {
      return c.json({
        ok: true,
        documentId: id,
        ...docIndexFields({ chunksCount: 0, embeddedChunksCount: 0 }),
      });
    }

    let embedder: EmbeddingClient;
    try {
      embedder = opts.resolveEmbedder(tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `embedder not configured: ${msg}` }, 503);
    }

    const vectors = await embedder.embed(existing.chunks.map((chunk) => chunk.text));
    if (vectors.length !== existing.chunks.length) {
      return c.json({ error: "embedder returned unexpected vector count" }, 503);
    }

    const stats = await withTenant(opts.db, tenantId, async (tx) => {
      for (const [index, chunk] of existing.chunks.entries()) {
        const vector = vectors[index];
        if (!vector) return null;
        await tx.execute(sql`
          UPDATE kb_chunks
          SET embedding = ${vectorLiteral(vector)}::vector
          WHERE tenant_id = ${tenantId}
            AND document_id = ${id}
            AND id = ${chunk.id}
        `);
      }
      const [row] = await tx
        .select({
          chunksCount: sql<number>`count(*)::int`,
          embeddedChunksCount: sql<number>`count(${kbChunks.embedding})::int`,
        })
        .from(kbChunks)
        .where(and(eq(kbChunks.tenantId, tenantId), eq(kbChunks.documentId, id)));
      return docIndexFields(row);
    });
    if (!stats) return c.json({ error: "embedder returned no vector" }, 503);

    return c.json({
      ok: true,
      documentId: id,
      ...stats,
    });
  });

  /**
   * POST /api/admin/kb/search
   * Preview retrieval for admins: returns raw chunks the RAG layer would
   * retrieve for a question in an explicit KB scope.
   */
  app.post("/api/admin/kb/search", async (c) => {
    const tenantId = c.var.tenantId;
    let payload: {
      query?: unknown;
      limit?: unknown;
      topic?: unknown;
      scopeType?: unknown;
      funnelId?: unknown;
      stageSlug?: unknown;
    };
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (!query) return c.json({ error: "query required" }, 400);
    if (query.length > 2000) return c.json({ error: "query too long" }, 413);

    const parsedScope = parseScope(payload);
    if ("error" in parsedScope) return c.json({ error: parsedScope.error }, 400);
    const scope = parsedScope.scope;
    const limit = parseSearchLimit(payload.limit);
    const topic =
      typeof payload.topic === "string" && payload.topic.trim().length > 0
        ? payload.topic.trim()
        : null;

    if (scope.scopeType !== "global") {
      const scopeError = await withTenant(opts.db, tenantId, async (tx) => {
        const [funnel] = await tx
          .select({ id: funnels.id })
          .from(funnels)
          .where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, scope.funnelId ?? 0)))
          .limit(1);
        if (!funnel) return "funnel not found";
        if (scope.scopeType !== "stage") return null;
        const [stage] = await tx
          .select({ id: stageDefinitions.id })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.tenantId, tenantId),
              eq(stageDefinitions.funnelId, scope.funnelId ?? 0),
              eq(stageDefinitions.slug, scope.stageSlug ?? ""),
            ),
          )
          .limit(1);
        return stage ? null : "stage not found";
      });
      if (scopeError) return c.json({ error: scopeError }, 400);
    }

    let embedding: number[] | null = null;
    try {
      const embedder = opts.resolveEmbedder(tenantId);
      const [vector] = await embedder.embed([query]);
      if (vector) embedding = vector;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[admin-kb] vector search unavailable, falling back to text search: ${msg}`);
    }

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const kb = new DrizzleKbStore({ db: tx, tenantId });
      const mode: KbSearchMode = embedding ? "hybrid" : "text";
      const rawHits = embedding
        ? await kb.hybridSearch({
            embedding,
            query,
            k: limit,
            topic,
            scope,
          })
        : await kb.textSearch(query, limit, topic, scope);
      const documentIds = [...new Set(rawHits.map((hit) => hit.document_id))];
      const docRows =
        documentIds.length > 0
          ? await tx
              .select({
                id: kbDocuments.id,
                topic: kbDocuments.topic,
                scopeType: kbDocuments.scopeType,
                funnelId: kbDocuments.funnelId,
                stageSlug: kbDocuments.stageSlug,
                fileName: kbDocuments.fileName,
                fileMimeType: kbDocuments.fileMimeType,
                source: kbDocuments.source,
                title: kbDocuments.title,
              })
              .from(kbDocuments)
              .where(and(eq(kbDocuments.tenantId, tenantId), inArray(kbDocuments.id, documentIds)))
          : [];
      const docsById = new Map(docRows.map((doc) => [doc.id, doc]));

      return {
        mode,
        items: rawHits.map((hit, index) => {
          const doc = docsById.get(hit.document_id);
          return {
            rank: index + 1,
            chunkId: hit.chunk_id,
            documentId: hit.document_id,
            distance: hit.distance,
            text: hit.text,
            source: hit.source,
            title: hit.title,
            topic: doc?.topic ?? null,
            scopeType: doc?.scopeType ?? "global",
            funnelId: doc?.funnelId ?? null,
            stageSlug: doc?.stageSlug ?? null,
            format: inferKbDocumentFormat({
              source: doc?.source ?? hit.source,
              title: doc?.title ?? hit.title,
              fileName: doc?.fileName ?? null,
              fileMimeType: doc?.fileMimeType ?? null,
            }),
          };
        }),
      };
    });

    return c.json({
      query,
      limit,
      topic,
      mode: result.mode,
      ...scopeToDbFields(scope),
      items: result.items,
    });
  });

  /**
   * GET /api/admin/kb/requirements?funnelId=<id>
   * Returns derived KB material requirements/checklist for a funnel, with
   * coverage computed from uploaded docs.
   */
  app.get("/api/admin/kb/requirements", async (c) => {
    const tenantId = c.var.tenantId;
    const funnelId = parsePositiveInt(c.req.query("funnelId"));
    if (!funnelId) return c.json({ error: "funnelId required" }, 400);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [funnel] = await tx
        .select({
          id: funnels.id,
          slug: funnels.slug,
          verticalTemplateId: funnels.verticalTemplateId,
        })
        .from(funnels)
        .where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, funnelId)))
        .limit(1);
      if (!funnel) return null;

      const stages = await tx
        .select({
          id: stageDefinitions.id,
          slug: stageDefinitions.slug,
          displayName: stageDefinitions.displayName,
          stageType: stageDefinitions.stageType,
          position: stageDefinitions.position,
        })
        .from(stageDefinitions)
        .where(
          and(
            eq(stageDefinitions.tenantId, tenantId),
            eq(stageDefinitions.funnelId, funnelId),
          ),
        )
        .orderBy(asc(stageDefinitions.position));

      const fields =
        stages.length > 0
          ? await tx
              .select({
                stageId: stageFields.stageId,
                fieldType: stageFields.fieldType,
                required: stageFields.required,
              })
              .from(stageFields)
              .where(
                and(
                  eq(stageFields.tenantId, tenantId),
                  inArray(
                    stageFields.stageId,
                    stages.map((s) => s.id),
                  ),
                ),
              )
          : [];
      const fieldsByStage = new Map<number, typeof fields>();
      for (const field of fields) {
        const arr = fieldsByStage.get(field.stageId) ?? [];
        arr.push(field);
        fieldsByStage.set(field.stageId, arr);
      }

      const drafts = buildKbRequirementDrafts({
        funnel,
        stages: stages.map((stage) => ({
          slug: stage.slug,
          displayName: stage.displayName,
          stageType: stage.stageType,
          fields: fieldsByStage.get(stage.id) ?? [],
        })),
      });

      const docs = await tx
        .select({
          topic: kbDocuments.topic,
          scopeType: kbDocuments.scopeType,
          funnelId: kbDocuments.funnelId,
          stageSlug: kbDocuments.stageSlug,
        })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId));

      const items: KbRequirement[] = coverKbRequirements(drafts, docs);
      return { funnel, items };
    });

    if (!result) return c.json({ error: "funnel not found" }, 404);
    return c.json(result);
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
    let scopePayload: {
      scopeType?: unknown;
      funnelId?: unknown;
      stageSlug?: unknown;
    } = {};
    let originalFile: StoredKbFile | null = null;

    if (contentType.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const fileField = form.get("file");
      if (!fileField || typeof fileField === "string") {
        return c.json({ error: "missing file field" }, 400);
      }
      const file = fileField as File;
      const fileName = file.name || "upload";
      try {
        const parsed = await readUploadFile(file);
        body = parsed.body;
        originalFile = parsed.originalFile;
      } catch (err) {
        if (err instanceof KbUploadHttpError) return c.json({ error: err.message }, err.status);
        throw err;
      }
      const titleField = form.get("title");
      title = typeof titleField === "string" && titleField.length > 0 ? titleField : fileName;
      const topicField = form.get("topic");
      if (typeof topicField === "string" && topicField.length > 0) topic = topicField;
      scopePayload = {
        scopeType: form.get("scopeType"),
        funnelId: form.get("funnelId"),
        stageSlug: form.get("stageSlug"),
      };
    } else if (contentType.startsWith("application/json")) {
      let payload: {
        title?: unknown;
        body?: unknown;
        topic?: unknown;
        scopeType?: unknown;
        funnelId?: unknown;
        stageSlug?: unknown;
      };
      try {
        payload = (await c.req.json()) as typeof payload;
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
      title = typeof payload.title === "string" ? payload.title.trim() : "";
      body = typeof payload.body === "string" ? payload.body : "";
      if (typeof payload.topic === "string" && payload.topic.length > 0) topic = payload.topic;
      scopePayload = payload;
      originalFile = {
        bytes: new TextEncoder().encode(body),
        fileName: `${sanitizeFileName(title || "untitled")}.txt`,
        mimeType: "text/plain; charset=utf-8",
        sizeBytes: new TextEncoder().encode(body).byteLength,
      };
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
    const parsedScope = parseScope(scopePayload);
    if ("error" in parsedScope) return c.json({ error: parsedScope.error }, 400);
    const scope = parsedScope.scope;
    if (scope.scopeType !== "global") {
      const scopeError = await withTenant(opts.db, tenantId, async (tx) => {
        const [funnel] = await tx
          .select({ id: funnels.id })
          .from(funnels)
          .where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, scope.funnelId ?? 0)))
          .limit(1);
        if (!funnel) return "funnel not found";
        if (scope.scopeType !== "stage") return null;

        const [stage] = await tx
          .select({ id: stageDefinitions.id })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.tenantId, tenantId),
              eq(stageDefinitions.funnelId, scope.funnelId ?? 0),
              eq(stageDefinitions.slug, scope.stageSlug ?? ""),
            ),
          )
          .limit(1);
        return stage ? null : "stage not found";
      });
      if (scopeError) return c.json({ error: scopeError }, 400);
    }

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
            scope,
          },
        );
      });
      let storedFile:
        | Awaited<ReturnType<typeof saveStoredKbFile>>
        | null = null;
      if (originalFile) {
        const fileMeta = await saveStoredKbFile({
          tenantId,
          documentId: result.documentId,
          file: originalFile,
        });
        storedFile = fileMeta;
        let previousStorageKey: string | null = null;
        await withTenant(opts.db, tenantId, async (tx) => {
          const [previous] = await tx
            .select({ fileStorageKey: kbDocuments.fileStorageKey })
            .from(kbDocuments)
            .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, result.documentId)))
            .limit(1);
          previousStorageKey = previous?.fileStorageKey ?? null;
          await tx
            .update(kbDocuments)
            .set(fileMeta)
            .where(and(eq(kbDocuments.tenantId, tenantId), eq(kbDocuments.id, result.documentId)));
        });
        if (previousStorageKey && previousStorageKey !== fileMeta.fileStorageKey) {
          await deleteStoredKbFile(previousStorageKey);
        }
      }
      return c.json({
        documentId: result.documentId,
        source: result.source,
        chunks: result.chunks,
        ...docIndexFields({
          chunksCount: result.chunks,
          embeddedChunksCount: result.chunks,
        }),
        created: result.created,
        ...(storedFile ? docFileFields(storedFile) : {}),
        ...scopeToDbFields(scope),
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
        .returning({ id: kbDocuments.id, fileStorageKey: kbDocuments.fileStorageKey });
      return result[0] ?? null;
    });
    if (!deleted) return c.json({ error: "document not found" }, 404);
    await deleteStoredKbFile(deleted.fileStorageKey);
    return c.json({ ok: true, deleted: 1 });
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
    const scopeTypeParam = c.req.query("scopeType");
    const funnelIdParam = c.req.query("funnelId");
    const stageSlugParam = c.req.query("stageSlug");
    const scopeFilter =
      scopeTypeParam
        ? parseScope({
            scopeType: scopeTypeParam,
            funnelId: funnelIdParam,
            stageSlug: stageSlugParam,
          })
        : null;
    if (scopeFilter?.error) return c.json({ error: scopeFilter.error }, 400);
    const scopeDb = scopeFilter?.scope ? scopeToDbFields(scopeFilter.scope) : null;
    const funnelFilter = scopeTypeParam ? null : parsePositiveInt(funnelIdParam);
    if (!scopeTypeParam && funnelIdParam && !funnelFilter) {
      return c.json({ error: "bad funnelId" }, 400);
    }
    const stageFilter = scopeTypeParam ? null : stageSlugParam?.trim();
    if (!scopeTypeParam && stageFilter && !funnelFilter) {
      return c.json({ error: "funnelId required for stageSlug filter" }, 400);
    }

    const items = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(kbSuggestions)
        .where(
          and(
            eq(kbSuggestions.tenantId, tenantId),
            eq(kbSuggestions.status, status),
            scopeDb ? eq(kbSuggestions.scopeType, scopeDb.scopeType) : undefined,
            scopeDb?.funnelId !== null && scopeDb?.funnelId !== undefined
              ? eq(kbSuggestions.funnelId, scopeDb.funnelId)
              : scopeDb
                ? sql`${kbSuggestions.funnelId} IS NULL`
                : undefined,
            scopeDb?.stageSlug !== null && scopeDb?.stageSlug !== undefined
              ? eq(kbSuggestions.stageSlug, scopeDb.stageSlug)
              : scopeDb
                ? sql`${kbSuggestions.stageSlug} IS NULL`
                : undefined,
            funnelFilter ? eq(kbSuggestions.funnelId, funnelFilter) : undefined,
            funnelFilter && !stageFilter
              ? inArray(kbSuggestions.scopeType, ["funnel", "stage"])
              : undefined,
            stageFilter ? eq(kbSuggestions.scopeType, "stage") : undefined,
            stageFilter ? eq(kbSuggestions.stageSlug, stageFilter) : undefined,
          ),
        )
        .orderBy(desc(kbSuggestions.createdAt))
        .limit(limit)
        .offset(offset),
    );

    const pendingRows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(kbSuggestions)
        .where(
          and(
            eq(kbSuggestions.tenantId, tenantId),
            eq(kbSuggestions.status, "pending"),
            scopeDb ? eq(kbSuggestions.scopeType, scopeDb.scopeType) : undefined,
            scopeDb?.funnelId !== null && scopeDb?.funnelId !== undefined
              ? eq(kbSuggestions.funnelId, scopeDb.funnelId)
              : scopeDb
                ? sql`${kbSuggestions.funnelId} IS NULL`
                : undefined,
            scopeDb?.stageSlug !== null && scopeDb?.stageSlug !== undefined
              ? eq(kbSuggestions.stageSlug, scopeDb.stageSlug)
              : scopeDb
                ? sql`${kbSuggestions.stageSlug} IS NULL`
                : undefined,
            funnelFilter ? eq(kbSuggestions.funnelId, funnelFilter) : undefined,
            funnelFilter && !stageFilter
              ? inArray(kbSuggestions.scopeType, ["funnel", "stage"])
              : undefined,
            stageFilter ? eq(kbSuggestions.scopeType, "stage") : undefined,
            stageFilter ? eq(kbSuggestions.stageSlug, stageFilter) : undefined,
          ),
        ),
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
      const scope: KbScope = {
        scopeType: suggestion.scopeType as KbScope["scopeType"],
        ...(suggestion.funnelId !== null ? { funnelId: suggestion.funnelId } : {}),
        ...(suggestion.stageSlug !== null ? { stageSlug: suggestion.stageSlug } : {}),
      };
      return ingestText(
        { title, body: bodyText },
        {
          kb,
          embedder: embedder as unknown as Parameters<typeof ingestText>[1]["embedder"],
          scope,
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
