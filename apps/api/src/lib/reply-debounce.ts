/**
 * Debounce-поллер ответов бота. Периодический тик, который добивает
 * «подошедшие» отложенные ответы: диалоги, у которых наступил дедлайн паузы
 * (conversations.reply_due_at <= now).
 *
 * Механика паузы (см. tenants.reply_delay_seconds):
 *   - входящее/правка в AI-режиме ставит reply_due_at = now + delay (вместо
 *     немедленного ответа); каждое следующее сообщение в окне перезаписывает →
 *     таймер «сбрасывается»;
 *   - этот тик атомарно claim'ит due-строки (UPDATE…RETURNING сбрасывает
 *     reply_due_at в NULL) и генерит ОДИН ответ по всей накопленной переписке
 *     через generateReplyForConversation (история читается из БД).
 *
 * durable: переживает рестарты/деплои apps/api (состояние в БД, не в памяти).
 * Атомарный claim исключает двойной ответ пересекающимися тиками.
 */
import {
  type BotSettings,
  ConversationsRepo,
  type Db,
  generateReplyForConversation,
  type NotificationService,
  type PipelineSink,
  type ReplyStrategy,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { wrapWithConciergeButtons } from "./concierge-reply-markup.ts";

export interface ReplyDebounceOpts {
  nowSec: number;
  replyStrategy: ReplyStrategy;
  notifications?: NotificationService | null;
  sink?: PipelineSink;
  /** #628 — резолвер настроек бота, чтобы отложенный ответ тоже дробился. */
  resolveBotSettings?: ((tenantId: number) => Promise<BotSettings>) | null;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

/** Один тик по всем активным тенантам. */
export async function replyDebounceTick(db: Db, opts: ReplyDebounceOpts): Promise<void> {
  const activeTenants = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  // Concierge-кнопки добавляются и к отложенному ответу — как в inline-пути webhook'а.
  const replyStrategy = wrapWithConciergeButtons(opts.replyStrategy, db);

  for (const t of activeTenants) {
    try {
      // Атомарно забираем диалоги с наступившим дедлайном (сбрасывая reply_due_at).
      const due = await withTenant(db, t.id, async (tx) =>
        new ConversationsRepo({ db: tx, tenantId: t.id }).claimDueReplies(opts.nowSec),
      );
      if (due.length === 0) continue;
      const settings = opts.resolveBotSettings
        ? await opts.resolveBotSettings(t.id).catch(() => null)
        : null;
      for (const conv of due) {
        // mode != 'ai' — диалог ушёл к оператору за время паузы: due_at уже
        // очищен claim'ом, ответ не генерим.
        if (conv.mode !== "ai") continue;
        try {
          await generateReplyForConversation({
            db,
            tenant: { tenantId: t.id, slug: t.slug, llmBillingMode: "byok" },
            conversation: conv,
            replyStrategy,
            notifications: opts.notifications ?? null,
            ...(settings?.splitReplies ? { splitReplies: true } : {}),
            ...(settings?.fallbackText ? { fallbackText: settings.fallbackText } : {}),
            ...(settings?.handoffAfterFallbacks
              ? { handoffAfterFallbacks: settings.handoffAfterFallbacks }
              : {}),
            ...(opts.sink ? { sink: opts.sink } : {}),
          });
        } catch (err) {
          opts.log?.warn?.(
            `reply-debounce conv=${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      opts.log?.warn?.(
        `reply-debounce tenant=${t.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
