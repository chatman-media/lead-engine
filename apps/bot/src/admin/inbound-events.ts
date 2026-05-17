import { config } from "../config.ts";
import type { TelegramClient } from "../telegram/client.ts";
import type { WebhookEvent } from "../telegram/webhook-types.ts";
import type { AdminBus } from "./bus.ts";

/**
 * Translates dialog-state events produced by the inbound pipeline
 * (`WebhookEvent`) into `AdminBus` events for the admin WebSocket layer.
 *
 * Shared by two producers:
 *   - the Bot API webhook handler (runs in the main process — `src/app.ts`)
 *   - the userbot subprocess, whose events arrive over IPC (`src/index.ts`)
 */
export function createInboundEventBridge(deps: {
  bus?: AdminBus;
  telegram: TelegramClient;
}): (event: WebhookEvent) => void {
  return (event) => {
    switch (event.type) {
      case "user-message-persisted":
      case "assistant-replied":
        deps.bus?.publish({
          type: "message:new",
          conversationId: event.conversationId,
          tgUserId: event.tgUserId,
        });
        return;
      case "conversation-mode-changed":
        deps.bus?.publish({
          type: "conversation:updated",
          conversationId: event.conversationId,
        });
        return;
      case "kb-suggestion:created": {
        deps.bus?.publish({
          type: "kb-suggestion:created",
          suggestionId: event.suggestionId,
          conversationId: event.conversationId,
        });
        // DM the admin in Telegram so they can jump to the chat immediately.
        const adminTgId = config.admin.tgUserId;
        if (adminTgId) {
          const adminUrl = `${config.publicBaseUrl}/admin/kb-suggestions`;
          deps.telegram
            .sendMessage({
              chatId: adminTgId,
              text: `❓ Новый вопрос без ответа (conversation #${event.conversationId})\n\nОткрыть: ${adminUrl}`,
            })
            .catch(() => undefined);
        }
        return;
      }
    }
  };
}
