import {
	conversationUrl,
	escapeHtml,
	objectValue,
	parseJsonObject,
	PAYOUT_CODE_TTL_SEC,
	type PendingOperatorDraft,
	pickupWindowFromDestination,
	stringValue,
} from "./operator-bot-shared.ts";
import { OperatorActionHandler } from "./operator-conversation-actions.ts";
import { DraftFlowHandler } from "./operator-draft-flow.ts";
import {
	extractConversationIdFromReply,
	previewOrderLine,
} from "./operator-draft-parsing.ts";
import {
	type ExchangeQuickReplyDraft,
	resolveExchangeActionScope,
	resolveExchangeQuickReply,
} from "./operator-exchange-quick-reply.ts";
import { translateOperatorReply } from "./operator-reply-translation.ts";
import {
	DIGEST_LABEL,
	DIGESTS,
	digestKeyboard,
	LEVEL_LABEL,
	LEVELS,
	levelKeyboard,
	TOPIC_LABEL,
	TOPICS,
	topicMap,
	topicsKeyboard,
} from "./operator-informer-ui.ts";
import { DraftStore } from "./operator-draft-store.ts";
import { InformerCommands } from "./operator-informer-commands.ts";
import { LinkingCommands } from "./operator-linking-commands.ts";
export { parseMuteSeconds } from "./operator-bot-shared.ts";
import {
	applyExchangeDraftSideEffects,
	applyKycDecisionSideEffect,
	applyOfficeDetailsSideEffect,
	applyPaymentConfirmedSideEffect,
	applyPayoutReadySideEffect,
	createPayoutCode,
	findExchangeOrderForDraft,
} from "./exchange-side-effects.ts";
import {
	TelegramClient,
	type TgCallbackQuery,
	type TgMessage,
	type TgReplyMarkup,
	type TgUpdate,
} from "@chatman-media/channel-telegram";
import {
	adminNotifications,
	auditLog,
	channelIdentities,
	channels,
	contacts,
	conversations,
	exchangeOrders,
	funnels,
	leadEvents,
	leads,
	messages,
	operatorActionDrafts,
	outboundQueue,
	stageDefinitions,
} from "@chatman-media/storage";
import type { ChatClient } from "@chatman-media/llm-router";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { ConversationsRepo } from "./dal/conversations.ts";
import type { NotificationsRepo } from "./dal/notifications.ts";
import type { Db } from "./dal/types.ts";
import { QUOTE_CURRENCY } from "./exchange-quote-currency.ts";
import { asSupportedLang, type Lang } from "./language.ts";
import { needsTranslation, OPERATOR_LANG, translateText } from "./translation.ts";
import {
	type OperatorActionPayload,
	type OperatorBotActionKind,
	type OperatorBotExchangeAction,
	operatorPreviewCallbackData,
	parseOperatorActionCallbackData,
	parseOperatorExchangeActionCallback,
	parseOperatorPreviewCallback,
} from "./operator-bot-actions.ts";
import { withTenant } from "./with-tenant.ts";

// ── Информер: справочники для команд ────────────────────────────────────────







export class OperatorBotHandler {
	private client: TelegramClient | null = null;
	private readonly draftStore: DraftStore;
	private readonly operatorActions: OperatorActionHandler;
	private readonly draftFlow: DraftFlowHandler;
	private readonly informer: InformerCommands;
	private readonly linking: LinkingCommands;

	constructor(
		private readonly repo: NotificationsRepo,
		botToken: string,
		private readonly actions: {
			db?: Db;
			appUrl?: string;
			nowEpoch?: () => number;
			// #731: переводчик ответа оператора (RU) на язык клиента. Не задан →
			// перевод выключен (back-compat: клиент получает текст как есть).
			resolveChat?: (tenantId: number) => ChatClient;
		} = {},
	) {
		if (botToken) {
			this.client = new TelegramClient({ token: botToken });
		}
		this.draftStore = new DraftStore(this.actions.db);
		this.operatorActions = new OperatorActionHandler(() => this.client, this.actions);
		this.draftFlow = new DraftFlowHandler(() => this.client, this.repo, this.draftStore, this.actions);
		this.informer = new InformerCommands(() => this.client, this.repo);
		this.linking = new LinkingCommands(() => this.client, this.repo);
	}

	async handleUpdate(update: TgUpdate): Promise<void> {
		if (!this.client) return;

		// Нажатия inline-кнопок (настройки информера).
		if (update.callback_query) {
			await this.handleCallback(update.callback_query);
			return;
		}

		if (!update.message) return;
		const { message } = update;
		const text = message.text || message.caption || "";
		const chatId = String(message.chat.id);

		if (text && !text.startsWith("/") && message.reply_to_message) {
			const handled = await this.draftFlow.handlePotentialDraftReply(
				message,
				chatId,
				text,
			);
			if (handled) return;
		}

		// #651 — оператор пишет в топике форум-группы (без reply_to_message):
		// маршрутизируем его текст клиенту, чей диалог привязан к этому треду.
		if (
			text &&
			!text.startsWith("/") &&
			!message.reply_to_message &&
			message.message_thread_id !== undefined
		) {
			const handled = await this.draftFlow.handleTopicReply(
				chatId,
				message.message_thread_id,
				text,
			);
			if (handled) return;
		}

		// 1. Личная привязка по /start <token>
		if (text.startsWith("/start ")) {
			const token = text.split(" ")[1];
			if (token) {
				await this.linking.handleLinkToken(token, chatId);
				return;
			}
		}

		// 2. Привязка группы по /setup <token>
		if (text.startsWith("/setup ")) {
			const token = text.split(" ")[1];
			if (token) {
				await this.linking.handleGroupLinkToken(
					token,
					message.chat.id,
					message.chat.title || "группа",
					// #651: форум-группа (топики включены) → правило получает
					// target_is_forum, дальше 1 топик на диалог.
					message.chat.is_forum === true,
				);
				return;
			}
		}

		// 2b. /setup без токена — показать ID группы
		if (text === "/setup" || text.startsWith("/setup@")) {
			await this.linking.handleSetupGroup(
				message.chat.id,
				message.chat.title || "эту группу",
			);
			return;
		}

		// 3. Команды информера (личный чат владельца/оператора).
		if (text === "/status") return this.informer.cmdStatus(chatId);
		if (text === "/level") return this.informer.cmdLevel(chatId);
		if (text === "/topics") return this.informer.cmdTopics(chatId);
		if (text === "/digest") return this.informer.cmdDigest(chatId);
		if (text === "/mute" || text.startsWith("/mute "))
			return this.informer.cmdMute(chatId, text);
		if (text === "/last" || text.startsWith("/last "))
			return this.informer.cmdLast(chatId, text);

		// 4. Базовый /start без параметров
		if (text === "/start") {
			await this.client.sendMessage({
				chatId,
				parseMode: "HTML",
				text:
					"👋 Привет! Я бот-информер Lead Engine.\n\n" +
					"Чтобы привязать аккаунт — Админка → Уведомления → «Подключить Telegram».\n\n" +
					"Когда привязан, настраивай прямо здесь:\n" +
					"• /status — текущие настройки\n" +
					"• /level — насколько громко информировать\n" +
					"• /topics — какие темы слать\n" +
					"• /digest — сводка (выкл/раз в день/2×)\n" +
					"• /mute 2h — заглушить на время\n" +
					"• /last — последние события",
			});
		}
	}

	// ── Команды информера ──────────────────────────────────────────────────

	// ── Callback (нажатия кнопок) ──────────────────────────────────────────

	private async handleCallback(cq: TgCallbackQuery): Promise<void> {
		if (!this.client) return;
		const chatId = String(cq.message?.chat.id ?? cq.from.id);
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Аккаунт не привязан",
			});
			return;
		}
		const operatorAction = parseOperatorActionCallbackData(cq.data);
		if (operatorAction.ok) {
			await this.operatorActions.handleOperatorAction(cq, s, operatorAction.payload);
			return;
		}
		if (operatorAction.reason === "malformed") {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Кнопка устарела",
				showAlert: true,
			});
			return;
		}
		const previewAction = parseOperatorPreviewCallback(cq.data);
		if (previewAction) {
			await this.draftFlow.handlePreviewAction(cq, s, previewAction);
			return;
		}
		const exchangeAction = parseOperatorExchangeActionCallback(cq.data);
		if (exchangeAction) {
			await this.draftFlow.handleExchangeAction(cq, s, exchangeAction);
			return;
		}

		const [kind, val] = (cq.data ?? "").split(":");
		if (kind === "lvl" && (LEVELS as readonly string[]).includes(val ?? "")) {
			await this.repo.updateInformerPrefs(s.adminId, { informerLevel: val });
			await this.editKeyboard(
				cq,
				"Насколько громко информировать?",
				levelKeyboard(val as string),
			);
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: LEVEL_LABEL[val as string],
			});
			return;
		}
		if (kind === "dig" && (DIGESTS as readonly string[]).includes(val ?? "")) {
			await this.repo.updateInformerPrefs(s.adminId, { informerDigest: val });
			await this.editKeyboard(
				cq,
				"Как часто слать сводку?",
				digestKeyboard(val as string),
			);
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: DIGEST_LABEL[val as string],
			});
			return;
		}
		if (kind === "tpc" && (TOPICS as readonly string[]).includes(val ?? "")) {
			const map = topicMap(s.informerTopics);
			map[val as string] = !map[val as string];
			await this.repo.updateInformerPrefs(s.adminId, {
				informerTopics: JSON.stringify(map),
			});
			await this.editKeyboard(
				cq,
				"Темы (нажми, чтобы вкл/выкл):",
				topicsKeyboard(map),
			);
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: `${TOPIC_LABEL[val as string]}: ${map[val as string] ? "вкл" : "выкл"}`,
			});
			return;
		}
		await this.client.answerCallbackQuery({ callbackQueryId: cq.id });
	}

	private async editKeyboard(
		cq: TgCallbackQuery,
		text: string,
		markup: TgReplyMarkup,
	): Promise<void> {
		if (!this.client || !cq.message) return;
		await this.client
			.editMessageText({
				chatId: cq.message.chat.id,
				messageId: cq.message.message_id,
				text,
				replyMarkup: markup,
			})
			.catch(() => {});
	}

}
