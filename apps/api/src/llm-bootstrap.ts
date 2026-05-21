import {
  LlmReplyStrategy,
  MessagesRepo,
  type Db,
  type ReplyStrategy,
} from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import type { ApiConfig } from "./config.ts";

/**
 * Bootstrap LlmRouter + LlmReplyStrategy. После Этапа 8 будет читать
 * llm_provider_configs из БД per tenant; сейчас — single-tenant shim
 * через env-vars (legacy tenant_id=1).
 *
 * Возвращает null если LLM не сконфигурирован — apps/api тогда стартует
 * без ReplyStrategy (бот persist'ит и молчит).
 */
export function makeLlmReplyStrategy(cfg: ApiConfig, db: Db): ReplyStrategy | null {
  if (!cfg.llm.provider || !cfg.llm.apiKey || !cfg.llm.model) {
    return null;
  }
  const provider = cfg.llm.provider; // narrowing: not ""

  const router = new InMemoryLlmRouter();
  router.setConfig({
    tenantId: 1, // legacy tenant
    purpose: "chat",
    provider,
    model: cfg.llm.model,
    apiKey: cfg.llm.apiKey,
    ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
  });

  // На текущей stage один vertical template — recruitment_uae_v1. После
  // Этапа 8 будет lookup через tenant.vertical_template_id из funnels.
  const template = RECRUITMENT_UAE_V1;

  return new LlmReplyStrategy(
    {
      template,
      resolveChat: (tenantId) => router.resolveChat(tenantId, "chat"),
    },
    (tenantId) => new MessagesRepo({ db, tenantId }),
  );
}
