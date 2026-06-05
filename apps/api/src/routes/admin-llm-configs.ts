import { type Db, setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import { llmProviderConfigs } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Per-tenant LLM provider configuration CRUD под /api/admin/llm-configs/*.
 *
 * Schema (llm_provider_configs):
 *   (tenant_id, purpose, provider, model, secret_ref?, base_url?, embed_dim?, timeout_ms?)
 *
 * Purpose: chat | embed | vision | judge — one config per purpose per tenant.
 * Secrets (api keys) живут в отдельной таблице tenant_secrets через AES-256-GCM
 * (см. setEncryptedSecret в conversation-engine). secret_ref хранит key-name
 * (e.g. "llm_chat_apikey") — physical секрет извлекается отдельно при boot
 * apps/api (см. llm-bootstrap.ts).
 *
 * Endpoints:
 *   GET    /api/admin/llm-configs           — list (WITHOUT secret values)
 *   PUT    /api/admin/llm-configs/:purpose  — upsert
 *   DELETE /api/admin/llm-configs/:purpose  — drop
 *
 * NB: изменения вступают в силу после рестарта apps/api (текущий
 * InMemoryLlmRouter резолвится на boot). Hot-reload — отдельный PR.
 */
export interface AdminLlmConfigsRoutesOpts {
  db: Db;
  /** Master key для AES-256-GCM шифрования API ключей (env PLATFORM_MASTER_KEY). */
  masterKeyHex: string;
  /**
   * Hot-reload hook — вызывается после успешного PUT/DELETE с tenantId.
   * Если задан — изменения применяются live без рестарта apps/api.
   * Если null — нужен restart (legacy путь).
   */
  onReload?: (tenantId: number) => Promise<void>;
}

type Purpose = "chat" | "embed" | "vision" | "judge" | "reranker" | "transcribe";
type Provider = "openai" | "openrouter" | "ollama" | "anthropic" | "jina" | "cohere";

const PURPOSES: readonly Purpose[] = [
  "chat",
  "embed",
  "vision",
  "judge",
  "reranker",
  "transcribe",
];
const PROVIDERS: readonly Provider[] = [
  "openai",
  "openrouter",
  "ollama",
  "anthropic",
  "jina",
  "cohere",
];

interface UpsertBody {
  provider: unknown;
  model: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  embedDim?: unknown;
  timeoutMs?: unknown;
}

export function makeAdminLlmConfigsRoutes(opts: AdminLlmConfigsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/llm-configs
   * Returns list of configs for the authenticated tenant (без secretRef values).
   * Каждый config: { purpose, provider, model, baseUrl, embedDim, timeoutMs, hasSecret }
   * `hasSecret` — boolean флаг что secret_ref непустой (API-key есть в tenant_secrets).
   */
  app.get("/api/admin/llm-configs", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          purpose: llmProviderConfigs.purpose,
          provider: llmProviderConfigs.provider,
          model: llmProviderConfigs.model,
          secretRef: llmProviderConfigs.secretRef,
          baseUrl: llmProviderConfigs.baseUrl,
          embedDim: llmProviderConfigs.embedDim,
          timeoutMs: llmProviderConfigs.timeoutMs,
          updatedAt: llmProviderConfigs.updatedAt,
        })
        .from(llmProviderConfigs)
        .where(eq(llmProviderConfigs.tenantId, tenantId));
    });
    return c.json({
      items: rows.map((r) => ({
        purpose: r.purpose,
        provider: r.provider,
        model: r.model,
        baseUrl: r.baseUrl,
        embedDim: r.embedDim,
        timeoutMs: r.timeoutMs,
        hasSecret: r.secretRef !== null && r.secretRef !== "",
        updatedAt: r.updatedAt,
      })),
    });
  });

  /**
   * PUT /api/admin/llm-configs/:purpose
   * Body: { provider, model, apiKey?, baseUrl?, embedDim?, timeoutMs? }
   *
   * Upsert. Если apiKey задан — encrypted via AES-256-GCM в tenant_secrets
   * под key=`llm_<purpose>_apikey`; secret_ref устанавливается в это значение.
   * Если apiKey === null — secret_ref clear'ится (но запись секрета в
   * tenant_secrets остаётся — manual cleanup отдельной операцией).
   */
  app.put("/api/admin/llm-configs/:purpose", async (c) => {
    const tenantId = c.var.tenantId;
    const purpose = c.req.param("purpose") as Purpose;
    if (!PURPOSES.includes(purpose)) {
      return c.json({ error: `invalid purpose: ${purpose}` }, 400);
    }
    let body: UpsertBody;
    try {
      body = (await c.req.json()) as UpsertBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const provider = typeof body.provider === "string" ? body.provider : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const apiKey = typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : null;
    const baseUrl =
      typeof body.baseUrl === "string" && body.baseUrl.length > 0 ? body.baseUrl.trim() : null;
    const embedDim =
      typeof body.embedDim === "number" && Number.isFinite(body.embedDim) ? body.embedDim : null;
    const timeoutMs =
      typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : null;

    if (!PROVIDERS.includes(provider as Provider)) {
      return c.json({ error: `invalid provider (must be one of ${PROVIDERS.join(",")})` }, 400);
    }
    if (!model) return c.json({ error: "model required" }, 400);
    // Embed-purpose требует embedDim для vector consistency со schema.
    if (purpose === "embed" && (embedDim === null || embedDim <= 0)) {
      return c.json({ error: "embedDim required for purpose=embed (must be positive)" }, 400);
    }
    // Non-Ollama providers требуют apiKey (Ollama — local без auth).
    if (provider !== "ollama" && !apiKey) {
      // Может быть update без re-supply'а apiKey'я — позволим, если row уже
      // существует с secret_ref. Проверим ниже.
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const secretKey = `llm_${purpose}_apikey`;

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      // Существующий row?
      const [existing] = await tx
        .select()
        .from(llmProviderConfigs)
        .where(
          and(eq(llmProviderConfigs.tenantId, tenantId), eq(llmProviderConfigs.purpose, purpose)),
        );

      // Если apiKey задан — store encrypted.
      let secretRef: string | null = existing?.secretRef ?? null;
      if (apiKey) {
        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: secretKey,
          value: apiKey,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });
        secretRef = secretKey;
      }
      // Переиспользование ключа: если своего секрета нет и новый не передан —
      // берём secret_ref от другого назначения с ТЕМ ЖЕ провайдером (один и тот
      // же API-ключ работает для chat/embed/vision у одного провайдера). Так
      // пользователю не нужно вводить ключ повторно.
      if (!secretRef && provider !== "ollama") {
        const siblings = await tx
          .select({
            provider: llmProviderConfigs.provider,
            secretRef: llmProviderConfigs.secretRef,
          })
          .from(llmProviderConfigs)
          .where(eq(llmProviderConfigs.tenantId, tenantId));
        const shared = siblings.find((s) => s.provider === provider && s.secretRef);
        if (shared?.secretRef) secretRef = shared.secretRef;
      }
      // Provider validation против apiKey-required: только если ни existing
      // secret_ref ни новый apiKey ни sibling-секрет не заданы для не-Ollama.
      if (provider !== "ollama" && !secretRef) {
        throw new Error(`provider ${provider} requires apiKey (or pre-existing secret)`);
      }

      if (existing) {
        await tx
          .update(llmProviderConfigs)
          .set({
            provider,
            model,
            secretRef,
            baseUrl,
            embedDim,
            timeoutMs,
            updatedAt: nowEpoch,
          })
          .where(
            and(eq(llmProviderConfigs.tenantId, tenantId), eq(llmProviderConfigs.purpose, purpose)),
          );
        return { updated: true, id: existing.id };
      }
      const [inserted] = await tx
        .insert(llmProviderConfigs)
        .values({
          tenantId,
          purpose,
          provider,
          model,
          secretRef,
          baseUrl,
          embedDim,
          timeoutMs,
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning();
      return { updated: false, id: inserted!.id };
    });

    // Audit log: actor + purpose + provider/model (без apiKey value).
    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId,
      action: result.updated ? "llm_config.update" : "llm_config.create",
      targetKind: "llm_provider_config",
      targetId: purpose,
      details: {
        provider,
        model,
        hasApiKey: !!apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(embedDim !== null ? { embedDim } : {}),
        ...(timeoutMs !== null ? { timeoutMs } : {}),
      },
    });

    // Hot-reload: вступает в силу live без рестарта apps/api.
    if (opts.onReload) {
      try {
        await opts.onReload(tenantId);
      } catch (err) {
        // НЕ откатываем DB-update — reload может fail при corrupted master key,
        // но запись валидна. Restart восстановит.
        return c.json({
          ok: true,
          ...result,
          reloadError: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true, ...result });
  });

  /**
   * DELETE /api/admin/llm-configs/:purpose
   * Drops the config row. Сам tenant_secrets row не удаляется (manual
   * cleanup для безопасности).
   */
  app.delete("/api/admin/llm-configs/:purpose", async (c) => {
    const tenantId = c.var.tenantId;
    const purpose = c.req.param("purpose") as Purpose;
    if (!PURPOSES.includes(purpose)) {
      return c.json({ error: `invalid purpose: ${purpose}` }, 400);
    }
    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const result = await tx
        .delete(llmProviderConfigs)
        .where(
          and(eq(llmProviderConfigs.tenantId, tenantId), eq(llmProviderConfigs.purpose, purpose)),
        )
        .returning({ id: llmProviderConfigs.id });
      return result.length;
    });
    if (deleted === 0) return c.json({ error: "config not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId,
      action: "llm_config.delete",
      targetKind: "llm_provider_config",
      targetId: purpose,
    });

    if (opts.onReload) {
      try {
        await opts.onReload(tenantId);
      } catch (err) {
        return c.json({
          ok: true,
          deleted,
          reloadError: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true, deleted });
  });

  return app;
}
