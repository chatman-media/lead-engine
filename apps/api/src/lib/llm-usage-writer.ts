/**
 * Batched writer для llm_usage_events. Каждый wrapChatClient/wrapEmbeddingClient
 * call дёргает `record(tenantId, event)` — events накапливаются в memory
 * buffer и flush'атся в DB пачками каждые N сек (или сразу при buffer full).
 *
 * Зачем batch: pipeline дёргает LLM ~раз в секунду в пике; INSERT на каждый
 * call'у блочит pool без cause'а. Batched INSERT'ы один SQL statement —
 * микросекунды.
 *
 * Fail-quiet: если DB write fails — события dropp'ятся, log warn,
 * pipeline continues (usage tracking — telemetry, не критично для UX).
 *
 * Graceful shutdown: вызвать `flush()` перед exit чтобы не потерять
 * buffered events.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { llmUsageEvents } from "@chatman-media/storage";
import type { UsageEvent } from "./llm-metrics-wrapper.ts";

export interface UsageWriterOpts {
  db: Db;
  /** Flush interval ms. Default 5000 (5 sec). */
  flushIntervalMs?: number;
  /** Max buffer size — при превышении flush immediate. Default 200. */
  maxBufferSize?: number;
  /** Hook для logging errors во время flush'а. */
  onError?: (err: unknown, droppedCount: number) => void;
}

interface BufferedEvent extends UsageEvent {
  tenantId: number;
  createdAt: number;
}

const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_MAX_BUFFER = 200;

export class LlmUsageWriter {
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private stopped = false;

  constructor(private readonly opts: UsageWriterOpts) {
    const interval = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, interval);
    }
  }

  /**
   * Append usage event. Если buffer достиг maxBufferSize → schedule immediate
   * flush (Promise.resolve().then() — fire-and-forget вне current tick).
   */
  record(tenantId: number, event: UsageEvent): void {
    if (this.stopped) return;
    this.buffer.push({
      ...event,
      tenantId,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const max = this.opts.maxBufferSize ?? DEFAULT_MAX_BUFFER;
    if (this.buffer.length >= max) {
      // Defer чтобы не блочить вызывающий call'у.
      void Promise.resolve().then(() => this.flush());
    }
  }

  /**
   * Принудительный flush — один INSERT-multi-values для всего buffer'а.
   * Группируется по tenantId чтобы каждая транзакция была withTenant-scoped
   * (RLS-correct под non-bypass role'ю).
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const drained = this.buffer;
    this.buffer = [];
    try {
      // Group by tenantId — каждая группа INSERT'ится в своей withTenant tx
      // чтобы RLS policy получила правильный app.tenant_id.
      const byTenant = new Map<number, BufferedEvent[]>();
      for (const e of drained) {
        const list = byTenant.get(e.tenantId);
        if (list) list.push(e);
        else byTenant.set(e.tenantId, [e]);
      }
      for (const [tenantId, events] of byTenant) {
        try {
          await withTenant(this.opts.db, tenantId, async (tx) => {
            await tx.insert(llmUsageEvents).values(
              events.map((e) => ({
                tenantId: e.tenantId,
                purpose: e.purpose,
                provider: e.provider,
                model: e.model ?? null,
                latencyMs: e.latencyMs,
                success: e.success,
                errorKind: e.errorKind ?? null,
                promptTokens: null,
                completionTokens: null,
                createdAt: e.createdAt,
              })),
            );
          });
        } catch (err) {
          this.opts.onError?.(err, events.length);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Размер buffer'а — для metrics/inspection. */
  bufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Graceful shutdown: останавливает timer, flush'ает buffer, помечает
   * stopped (record() становится no-op).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
