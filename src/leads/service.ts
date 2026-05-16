import type { ConversationsRepo } from "../db/repos/conversations.ts";
import type { LeadRow, LeadsRepo } from "../db/repos/leads.ts";
import type { MessagesRepo } from "../db/repos/messages.ts";
import type { UserRow, UsersRepo } from "../db/repos/users.ts";
import { log } from "../log.ts";
import type { TelegramClient } from "../telegram/client.ts";
import type { TgInlineKeyboardButton } from "../telegram/types.ts";
import {
  APPROVAL_PROLOGUE,
  AWAITING_APPROVAL_REPLY,
  CONTRACT_TERMS,
  DOCS_COMPLETE_REPLY,
  INTAKE_FIELD_LABELS,
  INTAKE_TEMPLATE,
  type IntakeFields,
  REJECTION_DEFAULT,
  SUBMITTED_REPLY,
  VISA_ANKETA_TEMPLATE,
  VISA_PHOTO_REQUIREMENTS,
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
      `${user.tg_username ? `@${user.tg_username}` : `tg:${user.tg_user_id}`} · status=${user.status}`,
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
      if (intake.full_body_count !== undefined) {
        renderField("full_body_count", intake.full_body_count);
      }
      renderField("videos_count", intake.videos_count ?? 0);
      renderField("passport_photo_received", intake.passport_photo_received ? "получено" : false);
      renderField("dance_video_received", intake.dance_video_received ? "получено" : false);
      lines.push("");
    }

    if (recentMessages.length > 0) {
      lines.push("Последние реплики:");
      for (const m of recentMessages.slice(-5)) {
        const who = m.role === "user" ? "девочка" : "бот";
        const trimmed = m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text;
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
      await this.deps.leads.setOpsCardMessage(
        input.lead.id,
        this.deps.leadsChatId,
        sent.message_id,
      );
      return (await this.deps.leads.byId(input.lead.id)) ?? input.lead;
    } catch (err) {
      log.error("failed to post lead card", {
        scope: "leads",
        leads_chat_id: this.deps.leadsChatId,
        err,
      });
      return input.lead;
    }
  }

  /**
   * After operator approves: bot DMs the candidate the prologue +
   * contract terms + visa anketa template. Each line goes as a separate
   * Telegram message (and a separate `messages` row) so the admin can
   * see them and they're not crammed into one wall.
   */
  async sendApprovalMessages(input: { lead: LeadRow; user: UserRow }): Promise<void> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) {
      log.warn("no conversation for user (approval flow)", {
        scope: "leads",
        user_id: input.user.id,
      });
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
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: INTAKE_TEMPLATE,
    });
  }

  async sendAwaitingApprovalNote(input: { user: UserRow }): Promise<void> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: AWAITING_APPROVAL_REPLY,
    });
  }

  async sendRejection(input: { user: UserRow; customReason?: string }): Promise<void> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    const text = input.customReason?.trim() || REJECTION_DEFAULT;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text,
    });
  }

  async sendDocsCompleteAck(input: { user: UserRow }): Promise<void> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: DOCS_COMPLETE_REPLY,
    });
  }

  /**
   * Sent once when the operator confirms the visa application was filed
   * with the consulate (lead → `submitted`). Substitutes the allocated
   * application id into SUBMITTED_REPLY.
   */
  async sendSubmittedAck(input: { user: UserRow; applicationId: string }): Promise<void> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) return;
    await this.relayToCandidate({
      chatId: input.user.tg_user_id,
      conversationId: conv.id,
      text: SUBMITTED_REPLY.replace("{applicationId}", input.applicationId),
    });
  }

  /**
   * Phase 2C handoff: post a fully-collected lead's package to the
   * visa-submission ops chat with the auto-allocated application id,
   * the candidate's identifiers, intake fields, and the recent message
   * trail. Operator submits to the consulate from there.
   *
   * Caller is responsible for:
   *  - allocating application_id (via LeadsRepo.allocateApplicationId)
   *  - transitioning the state (this only handles the side effect)
   */
  async postVisaSubmissionPackage(input: {
    lead: LeadRow;
    user: UserRow;
    recentMessages: Array<{ role: string; text: string }>;
    applicationId: string;
  }): Promise<void> {
    if (this.deps.visaChatId == null) return;
    const intake = parseJson<IntakeFields>(input.lead.intake_json);
    const lines: string[] = [];
    lines.push(`📋 ПОДАЧА НА ВИЗУ · ${input.applicationId}`);
    lines.push(
      `${input.user.tg_username ? `@${input.user.tg_username}` : `tg:${input.user.tg_user_id}`}` +
        ` · lead #${input.lead.id}`,
    );
    lines.push("");

    if (intake) {
      lines.push("Анкета:");
      const renderField = (label: string, value: unknown) => {
        if (value === undefined || value === null || value === false) return;
        lines.push(`  · ${label}: ${value}`);
      };
      renderField("рост", intake.height);
      renderField("вес", intake.weight);
      renderField("город", intake.city);
      renderField("выезд", intake.departure_readiness);
      renderField("фото", intake.photos_count ?? 0);
      renderField("видео", intake.videos_count ?? 0);
      lines.push("");
    }

    if (input.recentMessages.length > 0) {
      lines.push("Последние реплики:");
      for (const m of input.recentMessages.slice(-10)) {
        const who = m.role === "user" ? "девочка" : "бот";
        const trimmed = m.text.length > 300 ? `${m.text.slice(0, 300)}…` : m.text;
        lines.push(`  ${who}: ${trimmed}`);
      }
    }

    try {
      await this.deps.telegram.sendMessage({
        chatId: this.deps.visaChatId,
        text: lines.join("\n"),
      });
    } catch (err) {
      log.error("failed to post visa package", {
        scope: "leads",
        visa_chat_id: this.deps.visaChatId,
        err,
      });
    }
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
      log.error("failed to refresh ops card", { scope: "leads", lead_id: input.lead.id, err });
    }
  }

  /**
   * Operator-driven relay: operator replies to a lead card in the ops
   * chat with text and/or a media attachment, this method forwards
   * everything to the candidate. Recorded in the `messages` table as
   * `role='human'` (an operator-originated message) so the admin chat
   * view distinguishes it from the bot's auto-replies.
   *
   * Returns false when neither text nor a recognised media kind is
   * present (caller can ack the operator with a hint to include
   * something).
   */
  async relayFromOperator(input: {
    lead: LeadRow;
    user: UserRow;
    text?: string;
    media?: {
      type: "photo" | "video" | "voice" | "document";
      file_id: string;
    };
  }): Promise<boolean> {
    const conv = await this.deps.conversations.byUserId(input.user.id);
    if (!conv) {
      log.warn("relay: no conversation for user", { scope: "leads", user_id: input.user.id });
      return false;
    }
    const text = input.text?.trim() ?? "";
    const media = input.media;
    if (!text && !media) return false;

    const candidateChatId = input.user.tg_user_id;
    let tgMessageId: number | undefined;

    try {
      if (media?.type === "photo") {
        const sent = await this.deps.telegram.sendPhoto({
          chatId: candidateChatId,
          photoFileId: media.file_id,
          ...(text ? { caption: text } : {}),
        });
        tgMessageId = sent.message_id;
      } else if (media?.type === "video") {
        const sent = await this.deps.telegram.sendVideo({
          chatId: candidateChatId,
          videoFileId: media.file_id,
          ...(text ? { caption: text } : {}),
        });
        tgMessageId = sent.message_id;
      } else if (media?.type === "document") {
        const sent = await this.deps.telegram.sendDocument({
          chatId: candidateChatId,
          documentFileId: media.file_id,
          ...(text ? { caption: text } : {}),
        });
        tgMessageId = sent.message_id;
      } else if (media?.type === "voice") {
        // Voice notes have no first-class send-by-file-id helper here;
        // fall back to sendDocument so the bytes still reach the
        // candidate (Telegram unwraps documents that were originally
        // voice messages on its side).
        const sent = await this.deps.telegram.sendDocument({
          chatId: candidateChatId,
          documentFileId: media.file_id,
          ...(text ? { caption: text } : {}),
        });
        tgMessageId = sent.message_id;
      } else {
        const sent = await this.deps.telegram.sendMessage({
          chatId: candidateChatId,
          text,
        });
        tgMessageId = sent.message_id;
      }
    } catch (err) {
      log.error("relay sendMessage failed", { scope: "leads", err });
      return false;
    }

    // Persist as `role='human'` (operator origin) with media metadata
    // attached so the admin chat view can render the same way it
    // renders the candidate's media.
    await this.deps.messages.add({
      conversationId: conv.id,
      role: "human",
      text: text || `[${media?.type ?? "message"}]`,
      ...(tgMessageId !== undefined ? { tgMessageId } : {}),
      meta: {
        source: "operator-relay",
        ...(media ? { media } : {}),
      },
    });
    await this.deps.conversations.touch(conv.id);
    return true;
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
      log.error("sendMessage to candidate failed", { scope: "leads", err });
    }
    await this.deps.messages.add({
      conversationId: input.conversationId,
      role: "assistant",
      text: input.text,
      ...(tgMessageId !== undefined ? { tgMessageId } : {}),
      meta: { source: "lead-template" },
    });
    await this.deps.conversations.touch(input.conversationId);
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
