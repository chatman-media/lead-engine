/**
 * Pre-reply поведенческие гейты бота (эпик #623), применяемые в webhook'е после
 * персиста и перед генерацией ответа:
 *   - стоп-слова → передача оператору (#626)
 *   - вне рабочих часов → тихо/авто-сообщение, без AI-ответа (#625)
 *   - приветствие при первом сообщении (#631)
 *   - ack на медиа без подписи (#633)
 *
 * Настройки резолвятся из tenants.bot_settings_json (resolveBotSettings).
 */
import {
  type BotSettings,
  ConversationsRepo,
  type Db,
  DEFAULT_BOT_SETTINGS,
  enqueueFixedReply,
  isWithinBotHours,
  matchStopWord,
  type NotificationService,
  parseBotSettings,
  type PipelineSink,
  type ProcessInboundResult,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { Inbound } from "@chatman-media/channel-core";

/** Резолвер настроек бота per-tenant из tenants.bot_settings_json. */
export function makeResolveBotSettings(db: Db): (tenantId: number) => Promise<BotSettings> {
  return async (tenantId: number): Promise<BotSettings> => {
    try {
      return await withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ json: tenants.botSettingsJson })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        return parseBotSettings(row?.json ?? null);
      });
    } catch {
      return { ...DEFAULT_BOT_SETTINGS };
    }
  };
}

export interface BotBehaviorDeps {
  db: Db;
  tenantId: number;
  channelDbId: number;
  settings: BotSettings;
  inbound: Inbound;
  result: ProcessInboundResult;
  notifications?: NotificationService | null;
  sink?: PipelineSink;
  nowEpoch: number;
}

export interface BotBehaviorOutcome {
  /** Пропустить обычную генерацию AI-ответа (стоп-слово / вне часов). */
  skipReply: boolean;
}

/**
 * Дедуп отправки авто-сообщения «вне рабочих часов»: не чаще раза в 3 часа на диалог.
 */
const OFFHOURS_MIN_GAP_SEC = 3 * 3600;

/**
 * Применяет pre-reply гейты. Возвращает skipReply=true, если AI-ответ не нужен
 * (диалог ушёл к оператору по стоп-слову или сейчас вне рабочих часов).
 * Приветствие/медиа-ack отправляются, но reply не блокируют (greeting precedes).
 */
export async function applyBotBehaviorGates(deps: BotBehaviorDeps): Promise<BotBehaviorOutcome> {
  const { settings, result, inbound } = deps;
  const externalUserId = inbound.externalUserId;
  const text = result.userMessageText ?? "";

  // 1. Стоп-слова → сразу оператору, без AI-ответа.
  if (text.length > 0) {
    const hit = matchStopWord(settings, text);
    if (hit) {
      await withTenant(deps.db, deps.tenantId, async (tx) => {
        await new ConversationsRepo({ db: tx, tenantId: deps.tenantId }).applyAutoHandoff({
          conversationId: result.conversationId,
          reason: "stop_word",
          customerNoticeSent: false,
          nowEpoch: deps.nowEpoch,
        });
      });
      if (deps.notifications) {
        await deps.notifications.notify({
          tenantId: deps.tenantId,
          eventType: "human_takeover",
          conversationId: result.conversationId,
          contactId: result.contactId,
          data: {
            displayName: result.contactDisplayName || "Без имени",
            text: text || "(стоп-слово)",
            reason: "stop_word",
          },
        });
      }
      deps.sink?.log?.("info", "bot handoff by stop word", {
        tenantId: deps.tenantId,
        conversationId: result.conversationId,
        word: hit,
      });
      return { skipReply: true };
    }
  }

  // 2. Вне рабочих часов → AI не отвечает; опц. авто-сообщение (дедуп 3ч).
  if (!isWithinBotHours(settings, deps.nowEpoch) && text.length > 0) {
    if (settings.offhoursMessage) {
      const send = await withTenant(deps.db, deps.tenantId, async (tx) =>
        new ConversationsRepo({ db: tx, tenantId: deps.tenantId }).shouldSendAutoMessage(
          result.conversationId,
          "offhours",
          OFFHOURS_MIN_GAP_SEC,
          deps.nowEpoch,
        ),
      );
      if (send) {
        await enqueueFixedReply({
          db: deps.db,
          tenantId: deps.tenantId,
          channelDbId: deps.channelDbId,
          conversationId: result.conversationId,
          externalUserId,
          text: settings.offhoursMessage,
          nowEpoch: deps.nowEpoch,
        });
      }
    }
    deps.sink?.log?.("debug", "bot silent (off hours)", {
      tenantId: deps.tenantId,
      conversationId: result.conversationId,
    });
    return { skipReply: true };
  }

  // 3. Приветствие при первом сообщении (не блокирует обычный ответ).
  if (result.conversationCreated && settings.greetingText) {
    await enqueueFixedReply({
      db: deps.db,
      tenantId: deps.tenantId,
      channelDbId: deps.channelDbId,
      conversationId: result.conversationId,
      externalUserId,
      text: settings.greetingText,
      nowEpoch: deps.nowEpoch,
    });
  }

  // 4. Медиа без подписи → ack (обычный ответ для mediaOnly и так не идёт).
  if (result.mediaOnly && settings.mediaAckText) {
    await enqueueFixedReply({
      db: deps.db,
      tenantId: deps.tenantId,
      channelDbId: deps.channelDbId,
      conversationId: result.conversationId,
      externalUserId,
      text: settings.mediaAckText,
      nowEpoch: deps.nowEpoch,
    });
  }

  return { skipReply: false };
}
