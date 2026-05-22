// Wrapper'ы поверх ChatClient/EmbeddingClient из llm-router, которые
// инкрементят счётчики llmCalls/llmErrors на каждый вызов. Labels
// {provider, purpose} — для разбиения метрик по моделям.
//
// Pattern такой же как middleware в HTTP-фреймворках: оригинальный
// клиент в private поле, methods делегируют + side-effect на metric.
//
// Опционально wrapper'ы дёргают `onComplete` callback после каждого
// (успешного или failed) вызова с latency + error info. Boot apps/api
// wire'ит этот callback к batched DB-writer'у который append'ит rows
// в `llm_usage_events` для UI billing dashboard'а.

import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";

export interface UsageEvent {
  /** chat | embed | vision | judge | memory | stage (см. schema check). */
  purpose: string;
  provider: string;
  model?: string;
  latencyMs: number;
  success: boolean;
  /** Error.name если success=false. */
  errorKind?: string;
}

export type OnUsage = (event: UsageEvent) => void;

export function wrapChatClient(
  inner: ChatClient,
  metrics: PlatformMetrics,
  labels: { provider: string; purpose: string; model?: string },
  onComplete?: OnUsage,
): ChatClient {
  return {
    async complete(
      messages: ChatMessage[],
      opts?: { temperature?: number; numPredict?: number },
    ): Promise<string> {
      metrics.llmCalls.inc(1, { provider: labels.provider, purpose: labels.purpose });
      const start = performance.now();
      try {
        const result = await inner.complete(messages, opts);
        onComplete?.({
          purpose: labels.purpose,
          provider: labels.provider,
          ...(labels.model ? { model: labels.model } : {}),
          latencyMs: Math.round(performance.now() - start),
          success: true,
        });
        return result;
      } catch (err) {
        const kind = err instanceof Error ? err.name : "unknown";
        metrics.llmErrors.inc(1, { provider: labels.provider, purpose: labels.purpose, kind });
        onComplete?.({
          purpose: labels.purpose,
          provider: labels.provider,
          ...(labels.model ? { model: labels.model } : {}),
          latencyMs: Math.round(performance.now() - start),
          success: false,
          errorKind: kind,
        });
        throw err;
      }
    },
  };
}

export function wrapEmbeddingClient(
  inner: EmbeddingClient,
  metrics: PlatformMetrics,
  labels: { provider: string; purpose: "embed"; model?: string },
  onComplete?: OnUsage,
): EmbeddingClient {
  return {
    get dim(): number {
      return inner.dim;
    },
    async embed(inputs: string[]): Promise<number[][]> {
      metrics.llmCalls.inc(1, { provider: labels.provider, purpose: labels.purpose });
      const start = performance.now();
      try {
        const result = await inner.embed(inputs);
        onComplete?.({
          purpose: labels.purpose,
          provider: labels.provider,
          ...(labels.model ? { model: labels.model } : {}),
          latencyMs: Math.round(performance.now() - start),
          success: true,
        });
        return result;
      } catch (err) {
        const kind = err instanceof Error ? err.name : "unknown";
        metrics.llmErrors.inc(1, { provider: labels.provider, purpose: labels.purpose, kind });
        onComplete?.({
          purpose: labels.purpose,
          provider: labels.provider,
          ...(labels.model ? { model: labels.model } : {}),
          latencyMs: Math.round(performance.now() - start),
          success: false,
          errorKind: kind,
        });
        throw err;
      }
    },
  };
}
