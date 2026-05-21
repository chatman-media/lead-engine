import { messages as messagesTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
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
    nowEpoch: number;
  }): Promise<MessageRow> {
    const externalId =
      opts.externalMessageId !== undefined ? Number(opts.externalMessageId) : null;
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
        createdAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("messages.insert: insert returned no row");
    return row as MessageRow;
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
}
