import type { ConversationRow, ConversationsRepo } from "./dal/index.ts";

/**
 * ChannelKind -> legacy conversations.source enum. `source` stays as an
 * inbox/query compatibility field; new conversations also carry channelId.
 */
function channelKindToSource(kind: string): "bot" | "userbot" | "self_play" {
  switch (kind) {
    case "telegram_bot":
      return "bot";
    case "telegram_userbot":
      return "userbot";
    case "self_play":
      // Симулированные диалоги (dev/тест): прогоняются через тот же
      // pipeline, но помечаются self_play — оператор видит их в инбоксе,
      // воркер реально в Telegram ничего не шлёт.
      return "self_play";
    default:
      return "bot";
  }
}

function canReuseLegacySource(kind: string): boolean {
  return kind === "telegram_bot" || kind === "telegram_userbot" || kind === "self_play";
}

/**
 * Find-or-create conversation for (contact, channelId). Legacy rows without a
 * channelId are reused only for channels that already had a stable source.
 * WhatsApp/web/Facebook/VK/Max no longer collapse into source='bot' when a
 * channelId is available.
 */
export async function resolveConversation(opts: {
  contactId: number;
  channelId?: number | null;
  channelKind: string;
  conversations: ConversationsRepo;
  nowEpoch: number;
}): Promise<{ conversation: ConversationRow; created: boolean }> {
  const source = channelKindToSource(opts.channelKind);
  const channelId = opts.channelId && opts.channelId > 0 ? opts.channelId : null;

  if (channelId) {
    const byChannel = await opts.conversations.findByContactAndChannel(opts.contactId, channelId);
    if (byChannel) {
      return { conversation: byChannel, created: false };
    }
    if (canReuseLegacySource(opts.channelKind)) {
      const legacy = await opts.conversations.findByContactAndSource(opts.contactId, source);
      if (legacy) {
        return { conversation: legacy, created: false };
      }
    }
  } else {
    const existing = await opts.conversations.findByContactAndSource(opts.contactId, source);
    if (existing) {
      return { conversation: existing, created: false };
    }
  }

  const created = await opts.conversations.create({
    contactId: opts.contactId,
    source,
    channelId,
    mode: "ai",
    nowEpoch: opts.nowEpoch,
  });
  // #694 — балансируем нового клиента по операторам (least-busy). Best-effort:
  // сбой назначения НЕ должен ломать создание диалога/обработку входящего.
  // Sim-диалоги (self_play) не назначаем — тестовая нагрузка не искажает баланс.
  if (source !== "self_play") {
    try {
      const assignedAdminId = await opts.conversations.autoAssignLeastBusyOperator(created.id);
      if (assignedAdminId != null) {
        return {
          conversation: { ...created, assignedAdminId },
          created: true,
        };
      }
    } catch (err) {
      console.warn("[resolveConversation] auto-assign failed:", err);
    }
  }
  return { conversation: created, created: true };
}
