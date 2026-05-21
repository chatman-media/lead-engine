import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type { OutboundQueueRepo, OutboundQueueRow } from "./dal/index.ts";

/**
 * Поставить envelope в outbound_queue. Worker'у дальше pop'ить
 * pending записи и слать через ChannelAdapter.send().
 *
 * `idempotencyKey` на envelope защищает от дублей при retry processInbound'а.
 * Рекомендованный формат ключа — `${channelId}:${externalUserId}:${reasonHash}`.
 */
export async function dispatchOutbound(opts: {
  channelDbId: number;
  conversationId: number | null;
  envelope: OutboundEnvelope;
  outbound: OutboundQueueRepo;
  nowEpoch: number;
}): Promise<OutboundQueueRow> {
  return opts.outbound.enqueue({
    channelId: opts.channelDbId,
    conversationId: opts.conversationId,
    envelope: opts.envelope,
    nowEpoch: opts.nowEpoch,
  });
}
