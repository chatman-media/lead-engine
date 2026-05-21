import {
  type Db,
  DrizzleKbStore,
  LlmReplyStrategy,
  MessagesRepo,
  RagReplyStrategy,
  type ReplyStrategy,
} from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import type { EmbeddingClient as RagEmbeddingClient } from "@chatman-media/rag";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import type { ApiConfig } from "./config.ts";

/**
 * Bootstrap LlmRouter + ReplyStrategy. На текущем этапе single-tenant
 * shim через env-vars (legacy tenant_id=1). После Этапа 8 router'у
 * хочется читать llm_provider_configs из БД per tenant.
 *
 * Выбор стратегии:
 *   - Если задан и chat-config, и embed-config → RagReplyStrategy
 *     (KB-aware ответы через @chatman-media/rag.answerWithRag).
 *   - Если только chat-config → LlmReplyStrategy (история + system prompt,
 *     без KB).
 *   - Если chat не задан → null (бот persist'ит и молчит).
 */
export function makeReplyStrategy(cfg: ApiConfig, db: Db): ReplyStrategy | null {
  if (!cfg.llm.provider || !cfg.llm.apiKey || !cfg.llm.model) {
    return null;
  }
  const chatProvider = cfg.llm.provider;
  const router = new InMemoryLlmRouter();
  router.setConfig({
    tenantId: 1,
    purpose: "chat",
    provider: chatProvider,
    model: cfg.llm.model,
    apiKey: cfg.llm.apiKey,
    ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
  });

  const template = RECRUITMENT_UAE_V1;

  const embedProvider = cfg.embed.provider;
  if (!embedProvider || !cfg.embed.apiKey || !cfg.embed.model) {
    return new LlmReplyStrategy(
      {
        template,
        resolveChat: (tenantId: number) => router.resolveChat(tenantId, "chat"),
      },
      (tenantId: number) => new MessagesRepo({ db, tenantId }),
    );
  }

  router.setConfig({
    tenantId: 1,
    purpose: "embed",
    provider: embedProvider,
    model: cfg.embed.model,
    apiKey: cfg.embed.apiKey,
    embedDim: cfg.embed.dim,
    ...(cfg.embed.baseUrl ? { baseUrl: cfg.embed.baseUrl } : {}),
  });

  return new RagReplyStrategy(
    {
      template,
      resolveChat: (tenantId: number) => router.resolveChat(tenantId, "chat"),
      // llm-router'овский EmbeddingClient structurally compatible с
      // rag's EmbeddingClient (embed(inputs)→number[][] + dim).
      resolveEmbed: (tenantId: number) =>
        router.resolveEmbed(tenantId) as unknown as RagEmbeddingClient,
      resolveKb: (tenantId: number) => new DrizzleKbStore({ db, tenantId }),
    },
    (tenantId: number) => new MessagesRepo({ db, tenantId }),
  );
}
