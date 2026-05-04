import type { ConversationsRepo } from "../db/repos/conversations.ts";
import type { LeadRow, LeadsRepo } from "../db/repos/leads.ts";
import type { MessagesRepo } from "../db/repos/messages.ts";
import type { UserRow, UsersRepo } from "../db/repos/users.ts";
import type { TelegramClient } from "../telegram/client.ts";
import type { TgInlineKeyboardButton } from "../telegram/types.ts";
import {
  APPROVAL_PROLOGUE,
  AWAITING_APPROVAL_REPLY,
  CONTRACT_TERMS,
  DOCS_COMPLETE_REPLY,
  INTAKE_FIELD_LABELS,
  INTAKE_TEMPLATE,
  REJECTION_DEFAULT,
  VISA_ANKETA_TEMPLATE,
  VISA_PHOTO_REQUIREMENTS,
  type IntakeFields,
} from "./templates.ts";

export interface LeadsServiceDeps {
  leads: LeadsRepo;
  users: UsersRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  telegram: TelegramClient;
  /** Group chat where new leads cards are posted. Optional — when unset
   *  the lead is still created/transitioned but no TG card is sent. */
  leadsChatId?: number | null;
  /** Group chat where the visa-submission package goes after docs are
   *  complete. Optional, same opt-in semantics. */
  visaChatId?: number | null;
}

/**
 * Why this exists: state transitions on a lead always come paired with
 * outbound TG messages (to the candidate, to ops chats) that need to be
 * recorded as `messages` rows so the admin chat view sees them and the
 * conversation history stays intact for RAG. Centralising that logic
 * here keeps the admin handlers and the callback_query handler from
 * duplicating it.
 *
 * All side-effect helpers are best-effort — TG send failures are logged
 * but do not abort the state change (the candidate can be DM'd manually
 * if needed; the source-of-truth is the DB row).
 */
export class LeadsService {
  constructor(private deps: LeadsServiceDeps) {}

  /**
   * Compose the lead card text for the ops chat. Public so callers can
   * preview / edit before sending if they want.
   */
  formatLeadCard(input: {
    lead: LeadRow;
    user: UserRow;
    intake: IntakeFields | null;
    recentMessages: Array<{ role: string; text: string }>;
    decision?: { state: "approved" | "rejected"; adminEmail?: string };
  }): string {
    const { lead, user, intake, recentMessages, decision } = input;
    const lines: string[] = [];
    const stateBadge =
      decision?.state === "approved"
        ? "✅ APPROVED"
        : decision?.state === "rejected"
          ? "❌ REJECTED"
          : "🆕 НОВЫЙ ЛИД";
    lines.push(`${stateBadge} #${lead.id}`);
    lines.push(
      `${user.tg_username ? "@" + user.tg_username : "tg:" + user.tg_user_id} · status=${user.status}`,
    );
    lines.push("");

    if (intake) {
      lines.push("Анкета:");
      const renderField = (key: keyof IntakeFields, value: unknown) => {
        const label = INTAKE_FIELD_LABELS[key];
        if (value === undefined || value === null || value === false) {
          lines.push(`  · ${label}: —`);
        } else {
          lines.push(`  · ${label}: ${value}`);
        }
      };
      renderField("height", intake.height);
      renderField("weight", intake.weight);
      renderField("city", intake.city);
      renderField("departure_readiness", intake.departure_readiness);
      renderField("photos_count", intake.photos_count ?? 0);
      renderField("videos_count", intake.videos_count ?? 0);
      renderField(
        "passport_photo_received",
        intake.passport_photo_received ? "получено" : false,
      );
      renderField(
        "dance_video_received",
        intake.dance_video_received ? "получено" : false,
      );
      lines.push("");
    }

    if (recentMessages.length > 0) {
      lines.push("Последние реплики:");
      for (const m of recentMessages.slice(-5)) {
        const who = m.role === "user" ? "девочка" : "бот";
        const trimmed = m.text.length > 200 ? m.text.slice(0, 200) + "…" : m.text;
        lines.push(`  ${who}: ${trimmed}`);
      }
      lines.push("");
    }

    if (decision) {
      lines.push(
        `Решение: ${decision.state === "approved" ? "одобрено" : "отклонено"}` +
          (decision.adminEmail ? ` · ${decision.adminEmail}` : "") +
          ` · ${new Date().toLocaleString("ru-RU")}`,
      );
    } else if (lead.application_id) {
      lines.push(`Заявка: ${lead.application_id}`);
    }

    return lines.join("\n");
  }

  /**
   * Inline keyboard with approve/reject buttons. callback_data carries
   * the lead id so the callback_query handler can dispatch.
   */
  approvalKeyboard(leadId: number): TgInlineKeyboardButton[][] {
    return [
      [
        { text: "✅ Одобрить", callback_data: `lead:approve:${leadId}` },
        { text: "❌ Отклонить", callback_data: `lead:reject:${leadId}` },
      ],
    ];
  }

  /**
   * Posts the lead card to LEADS_CHAT_ID (if configured) with approve/
   * reject buttons. Records the resulting message id on the lead so
   * later transitions can edit it in place. Returns the lead row.
   */
  async postCardToOpsChat(input: {
    lead: LeadRow;
    user: UserRow;
    recentMessages: Array<{ role: string; text: string }>;
  }): Promise<LeadRow> {
    if (this.deps.leadsChatId == null) return input.lead;

    const intake = parseJson<IntakeFields>(input.lead.intake_json);
    const text = this.formatLeadCard({
      lead: input.lead,
      user: input.user,
      intake,
      recentMessages: input.recentMessages,
    });
    try {
      const sent = await this.deps.telegram.sendMessage({
        chatId: this.deps.leadsChatId,
        text,
        replyMarkup: { inline_keyboard: this.approvalKeyboard(input.lead.id) },
      });
      this.deps.leads.setOpsCardMessage(
        input.lead.id,
        this.deps.leadsChatId,
        sent.message_id,
      );
      return this.deps.leads.byId(input.lead.id) ?? input.lead;
    } catch (err) {
      console.error(
        `[leads] failed to post card to LEADS_CHAT_ID=${this.deps.leadsChatId}:`,
        err,
      );
      return input.lead;
    }
  }

  /**
   * After operator approves: bot DMs the candidate the prologue +
   * contract terms + visa anketa template. Each line goes as a separate
   * Telegram message (and a separate `messages` row) so the admin can
   * see them and they're not crammed into one wall.
   */
  async sendApprovalMessages(input: {
    lead: LeadRow;
    user: UserRow;
  }): Promise<void> {
    const conv = this.deps.conversations.byUserId(input.user.id);
    if (!conv) {
      console.warn(`[leads] no conversation for user ${input.user.id}`);
      return;
    }
    const messages = [
      APPROVAL_PROLOGUE,
      CONTRACT_TERMS,
      VISA_ANKETA_TEMPLATE,
      VISA_PHOTO_REQUIREMENTS,
    ];
    for (const text of messages) {
      await this.relayToCandidate({
        chatId: input.user.tg_user_id,
        conversationId: conv.id,
        text,
      });
    }
  }

  async sendIntakeTemplate(input: { user: UserRow }): Promise<void> {
    const conv = this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: INTAKE_TEMPLATE,
    });
  }

  async sendAwaitingApprovalNote(input: { user: UserRow }): Promise<void> {
    const conv = this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: AWAITING_APPROVAL_REPLY,
    });
  }

  async sendRejection(input: {
    user: UserRow;
    customReason?: string;
  }): Promise<void> {
    const conv = this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    const text = input.customReason?.trim() || REJECTION_DEFAULT;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text,
    });
  }

  async sendDocsCompleteAck(input: { user: UserRow }): Promise<void> {
    const conv = this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: DOCS_COMPLETE_REPLY,
    });
  }

  /**
   * Re-renders the lead card with the decision header / no buttons and
   * pushes editMessageText. Best-effort.
   */
  async refreshOpsCard(input: {
    lead: LeadRow;
    user: UserRow;
    recentMessages: Array<{ role: string; text: string }>;
    decision?: { state: "approved" | "rejected"; adminEmail?: string };
  }): Promise<void> {
    if (input.lead.ops_chat_id == null || input.lead.ops_message_id == null) {
      return;
    }
    const intake = parseJson<IntakeFields>(input.lead.intake_json);
    const text = this.formatLeadCard({
      lead: input.lead,
      user: input.user,
      intake,
      recentMessages: input.recentMessages,
      ...(input.decision ? { decision: input.decision } : {}),
    });
    try {
      await this.deps.telegram.editMessageText({
        chatId: input.lead.ops_chat_id,
        messageId: input.lead.ops_message_id,
        text,
        // No keyboard once a decision is recorded — operators shouldn't
        // be able to flip-flop the lead via the buttons.
        replyMarkup: input.decision
          ? { inline_keyboard: [] }
          : { inline_keyboard: this.approvalKeyboard(input.lead.id) },
      });
    } catch (err) {
      console.error(`[leads] failed to refresh ops card for lead ${input.lead.id}:`, err);
    }
  }

  /**
   * Send a message FROM the bot TO the candidate, AND record it in the
   * messages table as `role=assistant` so the admin chat view sees it.
   * Mirrors what the webhook does on a normal RAG reply but for these
   * structured operator-triggered relays.
   */
  private async relayToCandidate(input: {
    chatId: number;
    conversationId: number;
    text: string;
  }): Promise<void> {
    let tgMessageId: number | undefined;
    try {
      const sent = await this.deps.telegram.sendMessage({
        chatId: input.chatId,
        text: input.text,
      });
      tgMessageId = sent.message_id;
    } catch (err) {
      console.error("[leads] sendMessage to candidate failed:", err);
    }
    this.deps.messages.add({
      conversationId: input.conversationId,
      role: "assistant",
      text: input.text,
      ...(tgMessageId !== undefined ? { tgMessageId } : {}),
      meta: { source: "lead-template" },
    });
    this.deps.conversations.touch(input.conversationId);
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
