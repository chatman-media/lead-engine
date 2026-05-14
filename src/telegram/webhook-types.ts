import type { Sql } from "../db/postgres.ts";
import type { ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import type { ExperimentsRepo } from "../db/repos/experiments.ts";
import type { KbRepo } from "../db/repos/kb.ts";
import type { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import type { LeadsRepo } from "../db/repos/leads.ts";
import type { MessagesRepo } from "../db/repos/messages.ts";
import type { SkillsRepo } from "../db/repos/skills.ts";
import type { StylesRepo } from "../db/repos/styles.ts";
import type { UserRow, UsersRepo } from "../db/repos/users.ts";
import type { VacanciesRepo } from "../db/repos/vacancies.ts";
import type { Persona } from "../rag/answer.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import type { Style } from "../sales/types.ts";
import type { TelegramClient } from "./client.ts";

export interface RagDeps {
  embedder: EmbeddingClient;
  chat: ChatClient;
  /**
   * Enable cross-session memory: after each turn, extract facts about the
   * candidate and persist them in users.profile_json.memory. Facts are
   * injected into the system prompt on subsequent turns so the bot doesn't
   * re-ask things the candidate already volunteered. Adds one async LLM call
   * after the reply (does NOT block the reply itself).
   */
  userMemory?: boolean;
  /** Query rewriting before retrieval — see `answerWithRag.rewriteQueryBeforeRetrieval`. */
  queryRewrite?: boolean;
  /** Post-generation hallucination check — see `answerWithRag.reflect`. */
  reflect?: boolean;
  /** Hybrid BM25+vector retrieval with RRF fusion — see `answerWithRag.hybridSearch`. */
  hybridSearch?: boolean;
  /** Topic-routed retrieval — see `answerWithRag.topicRouting`. */
  topicRouting?: boolean;
  /** Books-priority retrieval — see `answerWithRag.booksPriority`. */
  booksPriority?: boolean;
  /**
   * Conversation summarization for long chats: when total messages exceeds
   * `summaryStartThreshold` (default 30), older turns get compressed into a
   * paragraph stored in `conversations.summary_json` and injected into the
   * system prompt as "ИЗ РАННЕЙ ПЕРЕПИСКИ:". Refreshed lazily after each
   * reply when the gap from `summarizedThroughMsgId` exceeds
   * `summaryStaleness` (default 8 messages). Adds one async LLM call per
   * refresh (does NOT block the reply itself).
   */
  conversationSummary?: boolean;
  topK?: number;
  /** pgvector cosine distance threshold; hits above are dropped before LLM. */
  maxDistance?: number;
  /** How the bot identifies itself in answers (name, role, company).
   *  Used only when `style` is not provided. */
  persona?: Persona;
  /**
   * Sales-engine style FORCE-OVERRIDE. When set, this style is used for ALL
   * conversations regardless of DB state — the operator's escape hatch via
   * `BOT_SALES_STYLE` env. When unset, the bot picks a per-conversation
   * style from the DB (`styles` + `experiments` tables) on first inbound.
   */
  style?: Style;
  /**
   * Funnel-stage routing strategy.
   *   "regex" — fast regex-based router (default).
   *   "llm"   — LLM classifies the message; falls back to regex when
   *             confidence < `stageClassifierThreshold` or output is bad.
   * Adds one LLM call per inbound message when enabled — pick a small/fast
   * model if cost or latency matters.
   */
  stageClassifier?: "regex" | "llm";
  /** Confidence threshold for the LLM classifier (0..1). Default 0.6. */
  stageClassifierThreshold?: number;
}

export type WebhookEvent =
  | { type: "user-message-persisted"; conversationId: number; tgUserId: number }
  | { type: "assistant-replied"; conversationId: number; tgUserId: number }
  | { type: "conversation-mode-changed"; conversationId: number }
  | { type: "kb-suggestion:created"; suggestionId: number; conversationId: number };

export interface WebhookDeps {
  db: Sql;
  telegram: TelegramClient;
  webhookSecret: string;
  /** Optional: when present, bot answers via RAG. Otherwise it sends a stub
   *  reply (useful when no LLM keys are configured yet). */
  rag?: RagDeps;
  /** Group chat where lead cards are auto-posted on intake_complete. */
  leadsChatId?: number | null;
  /** Group chat where the visa-submission package is posted (Phase 2C). */
  visaChatId?: number | null;
  /** Single sink for all dialog-state changes the webhook produces. The
   *  HTTP layer fans this out to AdminBus / WS subscribers. */
  onEvent?: (event: WebhookEvent) => void;
  /**
   * Handler for inline-keyboard clicks on lead cards in the ops chat
   * (`update.callback_query`). When unset, callback updates are silently
   * ignored — useful in tests / setups without the leads module wired in.
   */
  onCallbackQuery?: (query: import("./types.ts").TgCallbackQuery) => Promise<void>;
  /**
   * If true, the heavy part of processing (RAG + sendMessage + persist
   * assistant reply) is awaited inside the handler before the HTTP
   * response. Tests use this for deterministic assertions; production
   * leaves it false so we ack Telegram in <100ms and avoid retries.
   */
  awaitProcessing?: boolean;
}

export interface ProcessInboundDeps {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  kb: KbRepo;
  kbSuggestions: KbSuggestionsRepo;
  styles: StylesRepo;
  skills: SkillsRepo;
  experiments: ExperimentsRepo;
  users: UsersRepo;
  vacancies: VacanciesRepo;
  leads: LeadsRepo;
  telegram: TelegramClient;
  rag?: RagDeps;
  leadsChatId?: number | null;
  visaChatId?: number | null;
  conv: ConversationRow;
  user: UserRow;
  chatId: number;
  text: string;
  tgUserId: number;
  onEvent?: (event: WebhookEvent) => void;
}

/**
 * Detected media payload of an inbound Telegram message. Stored under
 * `messages.meta_json.media` so the intake auto-detector can count
 * photo / video uploads via SQL `json_extract`. Bare flag — we do NOT
 * download files in this layer; the file_id stays in case a later
 * phase wants to fetch the bytes.
 */
export type MediaInfo = {
  type: "photo" | "video" | "voice" | "document";
  file_id: string;
  file_size?: number;
  mime_type?: string;
};
