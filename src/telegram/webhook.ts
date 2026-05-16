import { telegramOpenAccess } from "../config.ts";
import { type ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import { ExperimentsRepo } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillsRepo } from "../db/repos/skills.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { VacanciesRepo } from "../db/repos/vacancies.ts";
import { LeadsService } from "../leads/service.ts";
import { inc } from "../metrics.ts";
import { json, type RouteHandler } from "../router.ts";
import { containsEscalationTrigger } from "./escalation.ts";
import { processInbound } from "./process-inbound.ts";
import type { TgMessage, TgUpdate } from "./types.ts";
import type { MediaInfo, WebhookDeps } from "./webhook-types.ts";

export { processInbound } from "./process-inbound.ts";
// Re-export types so existing importers (src/app.ts, src/index.ts,
// src/telegram/userbot.ts, tests) keep working unchanged.
export type {
  ProcessInboundDeps,
  RagDeps,
  WebhookDeps,
  WebhookEvent,
} from "./webhook-types.ts";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Pull media info off the Telegram message envelope. Photo arrays
 * arrive as multiple sizes — we keep the largest's file_id (Telegram
 * sorts smallest-first, last entry is original). Returns null when
 * the message has no recognised media attachment.
 */
function extractMediaInfo(m: TgMessage): MediaInfo | null {
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    return {
      type: "photo",
      file_id: largest.file_id,
      ...(largest.file_size !== undefined ? { file_size: largest.file_size } : {}),
    };
  }
  if (m.video) {
    return {
      type: "video",
      file_id: m.video.file_id,
      ...(m.video.file_size !== undefined ? { file_size: m.video.file_size } : {}),
      ...(m.video.mime_type ? { mime_type: m.video.mime_type } : {}),
    };
  }
  if (m.voice) {
    return {
      type: "voice",
      file_id: m.voice.file_id,
      ...(m.voice.file_size !== undefined ? { file_size: m.voice.file_size } : {}),
      ...(m.voice.mime_type ? { mime_type: m.voice.mime_type } : {}),
    };
  }
  if (m.document) {
    return {
      type: "document",
      file_id: m.document.file_id,
      ...(m.document.file_size !== undefined ? { file_size: m.document.file_size } : {}),
      ...(m.document.mime_type ? { mime_type: m.document.mime_type } : {}),
    };
  }
  return null;
}

export function createWebhookHandler(deps: WebhookDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const kb = new KbRepo(deps.db);
  const kbSuggestions = new KbSuggestionsRepo(deps.db);
  const styles = new StylesRepo(deps.db);
  const skills = new SkillsRepo(deps.db);
  const experiments = new ExperimentsRepo(deps.db);
  const vacancies = new VacanciesRepo(deps.db);
  const leadsRepo = new LeadsRepo(deps.db);

  return async ({ req, params }) => {
    if (params.secret !== deps.webhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }
    const headerSecret = req.headers.get(SECRET_HEADER);
    if (headerSecret !== null && headerSecret !== deps.webhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TgUpdate;
    try {
      update = (await req.json()) as TgUpdate;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Inline-keyboard click on a lead card in the ops chat. We dispatch
    // approve/reject via a separate handler that lives outside the
    // candidate-message pipeline (different state, different side-effects).
    if (update.callback_query && deps.onCallbackQuery) {
      try {
        await deps.onCallbackQuery(update.callback_query);
      } catch (err) {
        console.error("[webhook] callback_query handler failed:", err);
      }
      return json({ ok: true, callback: true });
    }

    const message = update.message ?? update.edited_message;
    if (!message?.from) {
      return json({ ok: true, ignored: "no-message-or-from" });
    }
    const mediaInfo = extractMediaInfo(message);
    // Accept text OR caption-bearing media OR bare media (photo/video/...).
    // Bare media without text becomes "[photo]" / "[video]" placeholders so
    // the persistence layer doesn't reject the row (text is NOT NULL).
    if (!message.text && !mediaInfo) {
      return json({ ok: true, ignored: "unsupported-message" });
    }

    // Operator relay: when a message arrives in the ops chat as a reply
    // to a lead card we previously posted, route it to the candidate
    // instead of going through the candidate-message pipeline. Phase 4
    // of the lead workflow — see src/leads/service.ts:relayFromOperator.
    if (
      deps.leadsChatId != null &&
      message.chat.id === deps.leadsChatId &&
      message.reply_to_message?.message_id !== undefined
    ) {
      const parentMessageId = message.reply_to_message.message_id;
      const lead = await leadsRepo.byOpsMessage(deps.leadsChatId, parentMessageId);
      if (lead) {
        const opUser = await users.byId(lead.user_id);
        if (opUser) {
          const service = new LeadsService({
            leads: leadsRepo,
            users,
            conversations,
            messages,
            telegram: deps.telegram,
            leadsChatId: deps.leadsChatId,
            visaChatId: deps.visaChatId ?? null,
          });
          const relayInput: Parameters<typeof service.relayFromOperator>[0] = {
            lead,
            user: opUser,
            ...(message.text || message.caption
              ? { text: message.text ?? message.caption ?? "" }
              : {}),
            ...(mediaInfo ? { media: { type: mediaInfo.type, file_id: mediaInfo.file_id } } : {}),
          };
          const ok = await service.relayFromOperator(relayInput);
          if (ok) {
            // React in the ops chat so the operator sees their relay
            // landed. Best-effort — don't fail the webhook if Telegram
            // hiccups.
            await deps.telegram
              .sendMessage({
                chatId: deps.leadsChatId,
                text: `✅ отправлено в lead #${lead.id}`,
                replyToMessageId: message.message_id,
              })
              .catch(() => undefined);
          } else {
            await deps.telegram
              .sendMessage({
                chatId: deps.leadsChatId,
                text: `⚠ relay #${lead.id}: пусто (нужен текст или медиа)`,
                replyToMessageId: message.message_id,
              })
              .catch(() => undefined);
          }
          return json({ ok: true, relayed: lead.id });
        }
      }
    }

    const tgUserId = message.from.id;
    const userMessageText = message.text ?? message.caption ?? `[${mediaInfo!.type}]`;

    const userExisting = await users.byTgId(tgUserId);
    let user = userExisting;
    if (!user && telegramOpenAccess()) {
      user = await users.create({
        tgUserId,
        tgUsername: message.from.username ?? null,
      });
      console.log(`[webhook] TELEGRAM_OPEN_ACCESS: created user tg_user_id=${tgUserId}`);
    }
    if (!user) {
      console.log(`[webhook] ignoring message from non-whitelisted tg_user_id=${tgUserId}`);
      return json({ ok: true, ignored: "not-whitelisted" });
    }

    const conv = await conversations.ensureForUser(user.id, "bot");

    // Idempotency boundary. Telegram retries webhook deliveries with the
    // same message_id when we don't ack in ~60s; we collapse retries to a
    // single row and skip all downstream work for the duplicate.
    const persisted = await messages.addUserMessageIfNew({
      conversationId: conv.id,
      tgMessageId: message.message_id,
      text: userMessageText,
      ...(mediaInfo ? { meta: { media: mediaInfo } } : {}),
    });

    if (!persisted.isNew) {
      return json({
        ok: true,
        deduped: true,
        mode: conv.mode,
        tgMessageId: message.message_id,
      });
    }

    inc("tg_messages_total", 1, { source: "webhook" });
    await conversations.touch(conv.id);
    deps.onEvent?.({
      type: "user-message-persisted",
      conversationId: conv.id,
      tgUserId,
    });

    // Decide what we *intend* to do, synchronously, so the webhook
    // response can describe it for log aggregators and tests. The
    // heavy work below may send nothing (NO_CONTEXT / errors) while mode
    // stays ai, or escalates on explicit operator keywords — by then Telegram
    // has already received its 200 OK.
    const intent = decideIntent(conv.mode, userMessageText, deps.rag !== undefined);

    // Heavy work (RAG, /sendMessage, write assistant reply) is detached
    // from the HTTP response so we ack Telegram immediately. Without this
    // a slow LLM (Ollama) blows past Bot API's 60s timeout and Telegram
    // retries the same update — see migration 002 commentary.
    const processing = processInbound({
      messages,
      conversations,
      kb,
      kbSuggestions,
      styles,
      skills,
      experiments,
      users,
      vacancies,
      leads: leadsRepo,
      telegram: deps.telegram,
      leadsChatId: deps.leadsChatId ?? null,
      visaChatId: deps.visaChatId ?? null,
      rag: deps.rag,
      conv,
      user,
      chatId: message.chat.id,
      text: userMessageText,
      tgUserId,
      onEvent: deps.onEvent,
    }).catch((err) => {
      console.error("[webhook] background processing failed:", err);
    });

    if (deps.awaitProcessing) {
      await processing;
    }

    return json({ ok: true, ...intent });
  };
}

interface InboundIntent {
  mode: "ai" | "queued" | "human";
  reason?: "user-trigger" | "placeholder";
}

function decideIntent(
  currentMode: ConversationRow["mode"],
  text: string,
  ragEnabled: boolean,
): InboundIntent {
  if (currentMode === "human") return { mode: "human" };
  if (currentMode === "queued") return { mode: "queued" };
  if (containsEscalationTrigger(text)) {
    return { mode: "queued", reason: "user-trigger" };
  }
  if (!ragEnabled) return { mode: "ai", reason: "placeholder" };
  return { mode: "ai" };
}
