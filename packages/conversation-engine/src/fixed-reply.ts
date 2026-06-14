import type { OutboundEnvelope } from "@chatman-media/channel-core";
import { ConversationsRepo } from "./dal/conversations.ts";
import { MessagesRepo } from "./dal/messages.ts";
import { OutboundQueueRepo } from "./dal/outbound.ts";
import type { Db } from "./dal/types.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import { withTenant } from "./with-tenant.ts";

export interface EnqueueFixedReplyDeps {
  db: Db;
  tenantId: number;
  channelDbId: number;
  conversationId: number;
  /** Получатель (externalUserId клиента в канале). */
  externalUserId: string;
  text: string;
  nowEpoch: number;
}

/**
 * Ставит в outbound_queue фиксированный текстовый ответ бота (без LLM) и пишет
 * его как assistant-сообщение + обновляет превью инбокса. Используется для
 * системных авто-сообщений: приветствие (#631), вне рабочих часов (#625),
 * ack на медиа без подписи (#633).
 *
 * Открывает свою короткую tx (как generateReplyAndEnqueue). Возвращает id
 * строки очереди или null если текст пустой.
 */
export async function enqueueFixedReply(deps: EnqueueFixedReplyDeps): Promise<number | null> {
  const text = deps.text.trim();
  if (text.length === 0) return null;
  const envelope: OutboundEnvelope = {
    channelId: String(deps.channelDbId),
    externalUserId: deps.externalUserId,
    parts: [{ kind: "text", text }],
  };
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    const repoCtx = { db: tx, tenantId: deps.tenantId };
    const inserted = await new MessagesRepo(repoCtx).insert({
      conversationId: deps.conversationId,
      role: "assistant",
      text,
      nowEpoch: deps.nowEpoch,
    });
    void inserted;
    await new ConversationsRepo(repoCtx).updateInboxMetadata(deps.conversationId, {
      lastMessageAt: deps.nowEpoch,
      lastMessageText: text.slice(0, 200),
    });
    const queued = await dispatchOutbound({
      channelDbId: deps.channelDbId,
      conversationId: deps.conversationId,
      envelope,
      outbound: new OutboundQueueRepo(repoCtx),
      nowEpoch: deps.nowEpoch,
    });
    return queued.id;
  });
}
