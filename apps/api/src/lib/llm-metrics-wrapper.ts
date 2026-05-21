// Wrapper'ы поверх ChatClient/EmbeddingClient из llm-router, которые
// инкрементят счётчики llmCalls/llmErrors на каждый вызов. Labels
// {provider, purpose} — для разбиения метрик по моделям.
//
// Pattern такой же как middleware в HTTP-фреймворках: оригинальный
// клиент в private поле, methods делегируют + side-effect на metric.

import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";

export function wrapChatClient(
  inner: ChatClient,
  metrics: PlatformMetrics,
  labels: { provider: string; purpose: string },
): ChatClient {
  return {
    async complete(
      messages: ChatMessage[],
      opts?: { temperature?: number; numPredict?: number },
    ): Promise<string> {
      metrics.llmCalls.inc(1, labels);
      try {
        return await inner.complete(messages, opts);
      } catch (err) {
        const kind = err instanceof Error ? err.name : "unknown";
        metrics.llmErrors.inc(1, { ...labels, kind });
        throw err;
      }
    },
  };
}

export function wrapEmbeddingClient(
  inner: EmbeddingClient,
  metrics: PlatformMetrics,
  labels: { provider: string; purpose: "embed" },
): EmbeddingClient {
  return {
    get dim(): number {
      return inner.dim;
    },
    async embed(inputs: string[]): Promise<number[][]> {
      metrics.llmCalls.inc(1, labels);
      try {
        return await inner.embed(inputs);
      } catch (err) {
        const kind = err instanceof Error ? err.name : "unknown";
        metrics.llmErrors.inc(1, { ...labels, kind });
        throw err;
      }
    },
  };
}
