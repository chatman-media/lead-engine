/**
 * Hot-reload бизнес-логики apps/api после изменений per-tenant config'а
 * через admin-UI. Без рестарта процесса.
 *
 * Use-cases:
 *   1. PUT /api/admin/llm-configs/:purpose → перерегистрировать configs в
 *      InMemoryLlmRouter для этого tenant'а.
 *   2. POST /api/admin/channels/telegram → пересобрать ChannelEntry в
 *      ChannelRegistry (TelegramBotAdapter с новым token'ом).
 *   3. DELETE — то же, но reload приведёт registry в pустое состояние для
 *      tenant'а.
 *
 * NB: apps/worker — отдельный процесс, in-process bus не достаёт. Worker
 * пока требует рестарта для подхвата channels updates. pg_notify-based
 * cross-process reload — отдельный PR.
 */

import { type Db } from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { ChannelRegistry } from "../channel-registry.ts";
import type { ApiConfig } from "../config.ts";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { loadTenantLlmConfigs } from "./llm-config-loader.ts";
import type { WebChannelRegistry } from "./web-channel-registry.ts";

export interface TenantReloaderOpts {
  db: Db;
  cfg: ApiConfig;
  /** Shared LoadedRef (mutable). После reload содержит свежий snapshot + router. */
  ref: LoadedRef;
  registry: ChannelRegistry;
  /** Опциональный WebChannelRegistry — если передан, reloadChannels так же
   * перестроит web-каналы tenant'а. */
  webRegistry?: WebChannelRegistry;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TenantReloader {
  reloadLlm: (tenantId: number) => Promise<void>;
  reloadChannels: (tenantId: number) => Promise<void>;
}

export function makeTenantReloader(opts: TenantReloaderOpts): TenantReloader {
  async function reloadLlm(tenantId: number): Promise<void> {
    const partial = await loadTenantLlmConfigs({
      db: opts.db,
      tenantIds: [tenantId],
      envFallback: opts.cfg,
      masterKeyHex: opts.cfg.masterKeyHex,
      onError: (msg, ctx) => opts.log(`reloadLlm: ${msg}`, ctx),
    });

    // Invalidate router для этого tenant'а (сбросит cache + удалит configs).
    opts.ref.router.invalidate(tenantId);

    // Re-set configs из partial.
    const perTenant = partial.byTenant.get(tenantId);
    if (perTenant) {
      for (const [purpose, cfg] of perTenant) {
        opts.ref.router.setConfig({
          tenantId,
          purpose,
          provider: cfg.provider as never,
          model: cfg.model,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.embedDim !== undefined ? { embedDim: cfg.embedDim } : {}),
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: union of provider configs
        } as any);
      }
    }

    // Mutate the shared snapshot so factory closures see new configs (для
    // metrics provider-label via getConfig).
    if (perTenant) {
      opts.ref.current.byTenant.set(tenantId, perTenant);
    } else {
      opts.ref.current.byTenant.delete(tenantId);
    }
    // Recompute anyTenantHas* flags по всему snapshot'у.
    let anyChat = false;
    let anyEmbed = false;
    for (const [, m] of opts.ref.current.byTenant) {
      if (m.has("chat")) anyChat = true;
      if (m.has("embed")) anyEmbed = true;
    }
    opts.ref.current.anyTenantHasChat = anyChat;
    opts.ref.current.anyTenantHasEmbed = anyEmbed;

    opts.log("llm configs reloaded for tenant", {
      tenantId,
      purposes: perTenant ? [...perTenant.keys()] : [],
    });
  }

  async function reloadChannels(tenantId: number): Promise<void> {
    // Резолвим slug чтобы передать в registry.
    const [tenant] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) {
      opts.log("reloadChannels: tenant not found", { tenantId });
      return;
    }
    await opts.registry.reloadTenant(tenantId, tenant.slug);
    if (opts.webRegistry) {
      await opts.webRegistry.reloadTenant(tenantId, tenant.slug);
    }
    opts.log("channels reloaded for tenant", {
      tenantId,
      tenantSlug: tenant.slug,
      telegram: opts.registry.getTelegramBotsByTenant(tenant.slug).length,
      web: opts.webRegistry?.byTenant(tenant.slug) ? 1 : 0,
    });
  }

  return { reloadLlm, reloadChannels };
}
