import { messages as messagesTable } from "@chatman-media/storage";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface MessageRow {
  id: number;
  tenantId: number;
  conversationId: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  tgMessageId: number | null;
  metaJson: string | null;
  createdAt: number;
  stage: string | null;
  deletedAt: number | null;
  origLang: string | null;
  translatedText: string | null;
  translatedLang: string | null;
}

export class MessagesRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async insert(opts: {
    conversationId: number;
    role: "user" | "assistant" | "human" | "system";
    text: string;
    externalMessageId?: string;
    metaJson?: string;
    stage?: string;
    /** Язык оригинала text (#736). Пишется, если известен из детекта (#735). */
    origLang?: string | null;
    nowEpoch: number;
  }): Promise<MessageRow> {
    const externalId = opts.externalMessageId !== undefined ? Number(opts.externalMessageId) : null;
    const [row] = await this.ctx.db
      .insert(messagesTable)
      .values({
        tenantId: this.ctx.tenantId,
        conversationId: opts.conversationId,
        role: opts.role,
        text: opts.text,
        ...(externalId !== null && !Number.isNaN(externalId) ? { tgMessageId: externalId } : {}),
        ...(opts.metaJson !== undefined ? { metaJson: opts.metaJson } : {}),
        ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
        ...(opts.origLang != null ? { origLang: opts.origLang } : {}),
        createdAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("messages.insert: insert returned no row");
    return row as MessageRow;
  }

  /**
   * Записывает перевод сообщения (#736): translated_text + язык перевода.
   * Кэш для переводящего слоя оператора (#731) — чтобы не переводить повторно.
   * Tenant-scoped UPDATE (RLS-инвариант), по образцу setDetectedLang.
   */
  async setTranslation(messageId: number, opts: { text: string; lang: string }): Promise<void> {
    await this.ctx.db
      .update(messagesTable)
      .set({ translatedText: opts.text, translatedLang: opts.lang })
      .where(and(eq(messagesTable.tenantId, this.ctx.tenantId), eq(messagesTable.id, messageId)));
  }

  /**
   * Читает закэшированный перевод сообщения (#736) или null, если его ещё нет.
   * #731 использует это, чтобы не звать LLM-перевод повторно.
   */
  async getTranslation(messageId: number): Promise<{ text: string; lang: string } | null> {
    const [row] = await this.ctx.db
      .select({
        translatedText: messagesTable.translatedText,
        translatedLang: messagesTable.translatedLang,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.tenantId, this.ctx.tenantId), eq(messagesTable.id, messageId)))
      .limit(1);
    if (!row || row.translatedText == null || row.translatedLang == null) return null;
    return { text: row.translatedText, lang: row.translatedLang };
  }

  /**
   * Обновляет текст (и meta_json) уже сохранённого пользовательского
   * сообщения. Используется при правке входящего (Telegram `edited_message`):
   * клиент отредактировал ранее отправленное сообщение — мы перезаписываем
   * его текст вместо вставки нового. `created_at` НЕ трогаем: сообщение
   * остаётся на своём месте в истории (как в самом Telegram).
   */
  async updateUserText(
    messageId: number,
    opts: { text: string; metaJson?: string | null },
  ): Promise<MessageRow | null> {
    const [row] = await this.ctx.db
      .update(messagesTable)
      .set({
        text: opts.text,
        ...(opts.metaJson !== undefined ? { metaJson: opts.metaJson } : {}),
      })
      .where(
        and(
          eq(messagesTable.tenantId, this.ctx.tenantId),
          eq(messagesTable.id, messageId),
          sql`role = 'user'`,
        ),
      )
      .returning();
    return (row as MessageRow) ?? null;
  }

  /**
   * Дедупликационный path для пользовательских сообщений: один tg_message_id
   * per (conversation_id, role='user') уже защищён partial UNIQUE
   * uniq_msg_user_tg, но мы делаем явный pre-check чтобы вернуть существующую
   * строку вместо ON CONFLICT (нужны её id и timestamp для downstream).
   */
  async findUserByExternalId(
    conversationId: number,
    externalMessageId: string,
  ): Promise<MessageRow | null> {
    const num = Number(externalMessageId);
    if (Number.isNaN(num)) return null;
    const [row] = await this.ctx.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.tenantId, this.ctx.tenantId),
          eq(messagesTable.conversationId, conversationId),
          eq(messagesTable.tgMessageId, num),
          sql`role = 'user'`,
        ),
      );
    return (row as MessageRow) ?? null;
  }

  /**
   * Последнее (по времени) не-удалённое пользовательское сообщение в диалоге.
   * Нужен debounce-поллеру: восстановить userMessageText/tgMessageId/parts для
   * отложенной генерации ответа из одного conversationId.
   */
  async latestUser(conversationId: number): Promise<MessageRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.tenantId, this.ctx.tenantId),
          eq(messagesTable.conversationId, conversationId),
          isNull(messagesTable.deletedAt),
          sql`role = 'user'`,
        ),
      )
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(1);
    return (row as MessageRow) ?? null;
  }

  /**
   * Последние N не-удалённых сообщений в conversation, в хронологическом
   * порядке (oldest → newest). Используется ReplyStrategy для построения
   * history-промпта.
   *
   * Skip'ает soft-deleted (deleted_at NOT NULL) и system-role (их не
   * показываем LLM как историю — они для внутренних флагов).
   */
  async recent(conversationId: number, limit: number): Promise<MessageRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.tenantId, this.ctx.tenantId),
          eq(messagesTable.conversationId, conversationId),
          isNull(messagesTable.deletedAt),
          sql`role <> 'system'`,
        ),
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit);
    return (rows as MessageRow[]).reverse();
  }

  /**
   * Подсчитать общее кол-во non-deleted, non-system сообщений в диалоге.
   * Используется для compaction threshold check.
   */
  async countByConversation(conversationId: number): Promise<number> {
    const [row] = await this.ctx.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.tenantId, this.ctx.tenantId),
          eq(messagesTable.conversationId, conversationId),
          isNull(messagesTable.deletedAt),
          sql`role <> 'system'`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Старое окно сообщений для rolling-summary: все non-deleted, non-system
   * сообщения afterMessageId < id < beforeMessageId, oldest → newest.
   */
  async forConversationSummary(
    conversationId: number,
    opts: {
      afterMessageId?: number | null;
      beforeMessageId: number;
      limit: number;
    },
  ): Promise<MessageRow[]> {
    if (opts.limit <= 0) return [];
    const filters = [
      eq(messagesTable.tenantId, this.ctx.tenantId),
      eq(messagesTable.conversationId, conversationId),
      isNull(messagesTable.deletedAt),
      sql`role <> 'system'`,
      lt(messagesTable.id, opts.beforeMessageId),
    ];
    if (opts.afterMessageId !== undefined && opts.afterMessageId !== null) {
      filters.push(gt(messagesTable.id, opts.afterMessageId));
    }

    const rows = await this.ctx.db
      .select()
      .from(messagesTable)
      .where(and(...filters))
      .orderBy(asc(messagesTable.id))
      .limit(opts.limit);
    return rows as MessageRow[];
  }
}
