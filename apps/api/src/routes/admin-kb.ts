import { type Db, DrizzleKbStore, withTenant } from "@chatman-media/conversation-engine";
import { ingestText, type KbScope, parsePdfBuffer } from "@chatman-media/kb";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { funnels, kbDocuments, kbSuggestions, stageDefinitions, stageFields } from "@chatman-media/storage";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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

type KbRequirement = {
  key: string;
  title: string;
  description: string;
  topic: string;
  required: boolean;
  scopeType: "funnel" | "stage";
  funnelId: number;
  stageSlug: string | null;
  covered: boolean;
  matchedDocuments: number;
};

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

function addRequirement(
  map: Map<string, Omit<KbRequirement, "covered" | "matchedDocuments">>,
  req: Omit<KbRequirement, "covered" | "matchedDocuments">,
) {
  if (!map.has(req.key)) map.set(req.key, req);
}

function buildRequirementDrafts(input: {
  funnel: { id: number; slug: string; verticalTemplateId: string | null };
  stages: Array<{
    slug: string;
    displayName: string;
    stageType: string;
    fields: Array<{ fieldType: string; required: boolean }>;
  }>;
}): Array<Omit<KbRequirement, "covered" | "matchedDocuments">> {
  const { funnel, stages } = input;
  const out = new Map<string, Omit<KbRequirement, "covered" | "matchedDocuments">>();
  const isExchange =
    funnel.slug.includes("exchange") || funnel.verticalTemplateId === "exchange_v1";

  addRequirement(out, {
    key: "business_overview",
    title: "Что делает бизнес",
    description: "Краткое описание услуги, кому она подходит, что бот может обещать клиенту.",
    topic: "business_overview",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });
  addRequirement(out, {
    key: "process_and_sla",
    title: "Процесс и сроки",
    description: "Как проходит заявка по шагам, типичные сроки, где нужен оператор.",
    topic: "process",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });
  addRequirement(out, {
    key: "pricing_terms",
    title: "Цены, лимиты и условия",
    description: "Что можно называть клиенту, где брать цену, какие лимиты/комиссии/исключения.",
    topic: "pricing",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });

  if (isExchange) {
    for (const req of [
      {
        key: "exchange_how_to_pay",
        title: "Как оплатить / перевести",
        description: "Пошаговая инструкция по RUB/crypto оплате, что прислать как proof.",
        topic: "how_to_pay",
      },
      {
        key: "exchange_kyc_aml",
        title: "KYC и AML правила",
        description: "Когда нужна верификация, какие документы, что делать при high-risk.",
        topic: "kyc_aml",
      },
      {
        key: "exchange_payout",
        title: "Способы выдачи THB",
        description: "Офис, cardless ATM, курьер, банковский перевод, зоны и ограничения.",
        topic: "payout",
      },
      {
        key: "exchange_locations",
        title: "Офисы и точки выдачи",
        description: "Адреса, часы работы, районы, как выбрать ближайшую точку.",
        topic: "locations",
      },
    ]) {
      addRequirement(out, {
        ...req,
        required: true,
        scopeType: "funnel",
        funnelId: funnel.id,
        stageSlug: null,
      });
    }
  }

  for (const stage of stages) {
    const hasRequiredMedia = stage.fields.some(
      (field) =>
        field.required && ["file", "photo", "video"].includes(field.fieldType),
    );
    if (stage.stageType === "payment") {
      addRequirement(out, {
        key: `stage_${stage.slug}_payment`,
        title: `${stage.displayName}: оплата`,
        description: "Методы оплаты, реквизиты/ссылки, подтверждение платежа, что нельзя писать без проверки.",
        topic: "payment",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (
      stage.stageType === "document_upload" ||
      stage.stageType === "document_signature" ||
      hasRequiredMedia
    ) {
      addRequirement(out, {
        key: `stage_${stage.slug}_documents`,
        title: `${stage.displayName}: документы`,
        description: "Какие документы нужны, формат файлов, кто проверяет и что делать при ошибке.",
        topic: "documents",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (stage.stageType === "awaiting_operator" || stage.stageType === "external_approval") {
      addRequirement(out, {
        key: `stage_${stage.slug}_handoff`,
        title: `${stage.displayName}: решение оператора`,
        description: "Что бот может сказать до ответа оператора, SLA, какие данные передать человеку.",
        topic: "operator_handoff",
        required: false,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (stage.stageType === "rate_confirmation") {
      addRequirement(out, {
        key: `stage_${stage.slug}_rate_policy`,
        title: `${stage.displayName}: курс/расчёт`,
        description: "Источник курса, срок фиксации, что делать при торге или устаревшем курсе.",
        topic: "rates",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
  }

  return [...out.values()];
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
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: kbDocuments.id,
          source: kbDocuments.source,
          title: kbDocuments.title,
          topic: kbDocuments.topic,
          scopeType: kbDocuments.scopeType,
          funnelId: kbDocuments.funnelId,
          stageSlug: kbDocuments.stageSlug,
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
    });
    return c.json({ items: rows });
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

      const drafts = buildRequirementDrafts({
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

      const items: KbRequirement[] = drafts.map((req) => {
        const matchedDocuments = docs.filter((doc) => {
          if (doc.topic !== req.topic && doc.topic !== req.key) return false;
          if (doc.scopeType === "global") return true;
          if (doc.scopeType === "funnel") return doc.funnelId === req.funnelId;
          return doc.funnelId === req.funnelId && doc.stageSlug === req.stageSlug;
        }).length;
        return {
          ...req,
          covered: matchedDocuments > 0,
          matchedDocuments,
        };
      });
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
      return c.json({
        documentId: result.documentId,
        source: result.source,
        chunks: result.chunks,
        created: result.created,
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
