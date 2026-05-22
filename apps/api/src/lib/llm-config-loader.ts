/**
 * Per-tenant LLM config loader: reads `llm_provider_configs` + decrypts
 * api keys via `getDecryptedSecret`, with env vars as fallback.
 *
 * Workflow:
 *   1. Для каждого active tenant'а грузим всех его llm_provider_configs из БД.
 *   2. Для каждого конфига с secret_ref — decrypt'аем apiKey.
 *   3. Если для пары (tenant, purpose) DB конфига нет — используем env fallback
 *      (cfg.llm / cfg.embed), legacy single-tenant путь.
 *
 * Возвращает: per-tenant per-purpose Map с resolved-config + summary
 * (anyTenantHasChat/Embed) — для null-checks в bootstrap'е.
 *
 * NB: вызывается на boot (начальный snapshot), и повторно через
 * TenantReloader.reloadLlm(tenantId) при PUT /api/admin/llm-configs —
 * apps/api получает hot-reload без рестарта. apps/worker требует
 * рестарта (cross-process pg_notify reload — Phase 2).
 */

import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
import { llmProviderConfigs } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { ApiConfig } from "../config.ts";

export type LlmPurpose = "chat" | "embed" | "vision" | "judge";
export type LlmProvider = "openai" | "openrouter" | "ollama" | "anthropic";

export interface ResolvedLlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  embedDim?: number;
  timeoutMs?: number;
  /** "db" если из llm_provider_configs, "env" если из ApiConfig fallback. */
  source: "db" | "env";
}

export type TenantLlmConfigs = Map<LlmPurpose, ResolvedLlmConfig>;

export interface LoadedLlmConfigs {
  /** Per-tenant map; tenant без любых configs не появится в Map. */
  byTenant: Map<number, TenantLlmConfigs>;
  /** Хоть один tenant имеет рабочий chat config (DB OR env). */
  anyTenantHasChat: boolean;
  /** Хоть один tenant имеет рабочий embed config (DB OR env). */
  anyTenantHasEmbed: boolean;
}

export interface LoadOpts {
  db: Db;
  tenantIds: readonly number[];
  envFallback: ApiConfig;
  masterKeyHex: string;
  /** Hook для логирования decrypt-ошибок (corrupted master key, etc.). */
  onError?: (msg: string, ctx: Record<string, unknown>) => void;
}

interface DbConfigRow {
  tenantId: number;
  purpose: string;
  provider: string;
  model: string;
  secretRef: string | null;
  baseUrl: string | null;
  embedDim: number | null;
  timeoutMs: number | null;
}

function envChatConfig(env: ApiConfig): ResolvedLlmConfig | null {
  const { provider, model, apiKey, baseUrl } = env.llm;
  if (!provider || !model) return null;
  if (provider !== "ollama" && !apiKey) return null;
  return {
    provider: provider as LlmProvider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    source: "env",
  };
}

function envEmbedConfig(env: ApiConfig): ResolvedLlmConfig | null {
  const { provider, model, apiKey, baseUrl, dim } = env.embed;
  if (!provider || !model) return null;
  if (provider !== "ollama" && !apiKey) return null;
  return {
    provider: provider as LlmProvider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(dim ? { embedDim: dim } : {}),
    source: "env",
  };
}

async function resolveDbConfig(
  row: DbConfigRow,
  opts: LoadOpts,
): Promise<ResolvedLlmConfig | null> {
  let apiKey: string | undefined;
  if (row.secretRef) {
    try {
      const decrypted = await getDecryptedSecret({
        db: opts.db,
        tenantId: row.tenantId,
        key: row.secretRef,
        masterKeyHex: opts.masterKeyHex,
      });
      if (decrypted) apiKey = decrypted;
    } catch (err) {
      opts.onError?.("failed to decrypt llm config secret", {
        tenantId: row.tenantId,
        purpose: row.purpose,
        secretRef: row.secretRef,
        err: err instanceof Error ? err.message : String(err),
      });
      // Drop DB config — caller fall back'нется на env если есть.
      return null;
    }
  }
  // non-Ollama requires apiKey to be present
  if (row.provider !== "ollama" && !apiKey) {
    opts.onError?.("llm config missing apiKey", {
      tenantId: row.tenantId,
      purpose: row.purpose,
      provider: row.provider,
      hasSecretRef: !!row.secretRef,
    });
    return null;
  }
  return {
    provider: row.provider as LlmProvider,
    model: row.model,
    ...(apiKey ? { apiKey } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.embedDim !== null ? { embedDim: row.embedDim } : {}),
    ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
    source: "db",
  };
}

export async function loadTenantLlmConfigs(opts: LoadOpts): Promise<LoadedLlmConfigs> {
  const byTenant = new Map<number, TenantLlmConfigs>();

  // Load all DB rows in one query, group by tenant.
  const rows: DbConfigRow[] = await opts.db
    .select({
      tenantId: llmProviderConfigs.tenantId,
      purpose: llmProviderConfigs.purpose,
      provider: llmProviderConfigs.provider,
      model: llmProviderConfigs.model,
      secretRef: llmProviderConfigs.secretRef,
      baseUrl: llmProviderConfigs.baseUrl,
      embedDim: llmProviderConfigs.embedDim,
      timeoutMs: llmProviderConfigs.timeoutMs,
    })
    .from(llmProviderConfigs);

  const dbByTenant = new Map<number, Map<LlmPurpose, DbConfigRow>>();
  for (const row of rows) {
    let m = dbByTenant.get(row.tenantId);
    if (!m) {
      m = new Map();
      dbByTenant.set(row.tenantId, m);
    }
    m.set(row.purpose as LlmPurpose, row);
  }

  const envChat = envChatConfig(opts.envFallback);
  const envEmbed = envEmbedConfig(opts.envFallback);

  let anyChat = false;
  let anyEmbed = false;

  for (const tenantId of opts.tenantIds) {
    const tenantMap: TenantLlmConfigs = new Map();
    const dbConfigs = dbByTenant.get(tenantId);

    // CHAT: DB → env fallback
    const dbChatRow = dbConfigs?.get("chat");
    let chatCfg: ResolvedLlmConfig | null = null;
    if (dbChatRow) {
      chatCfg = await resolveDbConfig(dbChatRow, opts);
    }
    chatCfg ??= envChat;
    if (chatCfg) {
      tenantMap.set("chat", chatCfg);
      anyChat = true;
    }

    // EMBED: DB → env fallback
    const dbEmbedRow = dbConfigs?.get("embed");
    let embedCfg: ResolvedLlmConfig | null = null;
    if (dbEmbedRow) {
      embedCfg = await resolveDbConfig(dbEmbedRow, opts);
    }
    embedCfg ??= envEmbed;
    if (embedCfg) {
      tenantMap.set("embed", embedCfg);
      anyEmbed = true;
    }

    // VISION + JUDGE: DB only (env не имеет полей под эти purposes).
    for (const purpose of ["vision", "judge"] as const) {
      const dbRow = dbConfigs?.get(purpose);
      if (dbRow) {
        const cfg = await resolveDbConfig(dbRow, opts);
        if (cfg) tenantMap.set(purpose, cfg);
      }
    }

    if (tenantMap.size > 0) byTenant.set(tenantId, tenantMap);
  }

  return { byTenant, anyTenantHasChat: anyChat, anyTenantHasEmbed: anyEmbed };
}

/** Filter tenants that have a given purpose configured. */
export function tenantsWithPurpose(
  loaded: LoadedLlmConfigs,
  purpose: LlmPurpose,
): number[] {
  const out: number[] = [];
  for (const [tenantId, m] of loaded.byTenant) {
    if (m.has(purpose)) out.push(tenantId);
  }
  return out;
}

/** Get resolved config for (tenant, purpose) or null. */
export function getConfig(
  loaded: LoadedLlmConfigs,
  tenantId: number,
  purpose: LlmPurpose,
): ResolvedLlmConfig | null {
  return loaded.byTenant.get(tenantId)?.get(purpose) ?? null;
}
