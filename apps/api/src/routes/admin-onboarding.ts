import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channels,
  exchangeRates,
  funnels,
  kbDocuments,
  llmProviderConfigs,
  tenantSecrets,
} from "@chatman-media/storage";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  EXCHANGE_REQUISITE_FIXED_KEYS,
  EXCHANGE_WALLET_PREFIX,
} from "../lib/exchange/requisite-keys.ts";

/**
 * Onboarding-status endpoint. Возвращает сводку по setup'у tenant'а:
 * подключён ли канал, настроен ли LLM, установлена ли вертикаль, есть ли docs
 * в KB. UI рендерит чек-лист + использует `done` для гейтинга кабинета.
 *
 * `done`:
 *  - generic тенант: channel + ready chat LLM (KB и embed — опциональны).
 *  - exchange-тенант (funnels.vertical_template_id='exchange'): дополнительно
 *    нужны установленная воронка + ≥1 активный курс + ≥1 реквизит приёма.
 *
 * NB: одна агрегирующая ручка вместо N отдельных GET'ов — снижает round-trip'ы
 * и упрощает UI-state (один effect, один loading state).
 */
export interface AdminOnboardingRoutesOpts {
  db: Db;
}

export function makeAdminOnboardingRoutes(opts: AdminOnboardingRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/onboarding-status", async (c) => {
    const tenantId = c.var.tenantId;

    const status = await withTenant(opts.db, tenantId, async (tx) => {
      // 1. Любой active channel?
      const [chRow] = await tx
        .select({ id: channels.id, kind: channels.kind, externalId: channels.externalId })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "active")))
        .limit(1);

      // 2. Chat LLM config?
      const [chatCfg] = await tx
        .select({
          provider: llmProviderConfigs.provider,
          model: llmProviderConfigs.model,
          secretRef: llmProviderConfigs.secretRef,
        })
        .from(llmProviderConfigs)
        .where(
          and(eq(llmProviderConfigs.tenantId, tenantId), eq(llmProviderConfigs.purpose, "chat")),
        )
        .limit(1);

      // 3. Embed LLM config (optional но даёт RAG).
      const [embedCfg] = await tx
        .select({
          provider: llmProviderConfigs.provider,
          model: llmProviderConfigs.model,
        })
        .from(llmProviderConfigs)
        .where(
          and(eq(llmProviderConfigs.tenantId, tenantId), eq(llmProviderConfigs.purpose, "embed")),
        )
        .limit(1);

      // 4. KB docs count (для отображения; НЕ гейтит).
      const [doc] = await tx
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId))
        .limit(1);

      // 5. Установленная активная воронка → вертикаль тенанта.
      // NB: installVertical сеет funnels.slug = funnelSeedKey ('exchange'), а
      // vertical_template_id (slug 'exchange_v1') может оставаться NULL —
      // поэтому детектим обменку по любому из двух признаков.
      const [funnelRow] = await tx
        .select({ vertical: funnels.verticalTemplateId, slug: funnels.slug })
        .from(funnels)
        .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
        .limit(1);
      const isExchange = funnelRow?.vertical === "exchange_v1" || funnelRow?.slug === "exchange";

      // 6. Exchange-completeness: активные курсы + реквизиты приёма.
      let activeRateCount = 0;
      let requisiteCount = 0;
      if (isExchange) {
        const [rateRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(exchangeRates)
          .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.isActive, true)));
        activeRateCount = Number(rateRow?.n ?? 0);

        const [reqRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tenantSecrets)
          .where(
            and(
              eq(tenantSecrets.tenantId, tenantId),
              or(
                like(tenantSecrets.key, `${EXCHANGE_WALLET_PREFIX}%`),
                inArray(tenantSecrets.key, [...EXCHANGE_REQUISITE_FIXED_KEYS]),
              ),
              sql`${tenantSecrets.key} NOT LIKE ${"%_memo"}`,
              sql`${tenantSecrets.key} NOT LIKE ${"%_tag"}`,
            ),
          );
        requisiteCount = Number(reqRow?.n ?? 0);
      }

      const chatHasSecret = !!chatCfg?.secretRef;
      const chatLlmReady = !!chatCfg && (chatCfg.provider === "ollama" || chatHasSecret);

      return {
        channelConnected: !!chRow,
        ...(chRow ? { channelKind: chRow.kind, channelExternalId: chRow.externalId } : {}),
        chatLlmConfigured: !!chatCfg,
        chatLlmReady,
        ...(chatCfg
          ? {
              chatProvider: chatCfg.provider,
              chatModel: chatCfg.model,
              chatHasSecret,
            }
          : {}),
        embedLlmConfigured: !!embedCfg,
        ...(embedCfg ? { embedProvider: embedCfg.provider, embedModel: embedCfg.model } : {}),
        hasKbDocuments: !!doc,
        vertical: funnelRow?.vertical ?? funnelRow?.slug ?? null,
        isExchange,
        funnelInstalled: !!funnelRow,
        activeRateCount,
        requisiteCount,
      };
    });

    const exchangeReady =
      status.funnelInstalled && status.activeRateCount >= 1 && status.requisiteCount >= 1;
    const done =
      status.channelConnected && status.chatLlmReady && (!status.isExchange || exchangeReady);

    return c.json({ ...status, done });
  });

  return app;
}
