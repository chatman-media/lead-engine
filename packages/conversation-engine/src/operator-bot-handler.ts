import {
	escapeHtml,
	objectValue,
	parseJsonObject,
	PAYOUT_CODE_TTL_SEC,
	type PendingOperatorDraft,
	pickupWindowFromDestination,
	stringValue,
} from "./operator-bot-shared.ts";
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



const PREVIEW_TTL_SEC = 10 * 60;


interface ExchangeQuickReplyDraft {
	title: string;
	text: string;
	metadata: Record<string, unknown>;
}

const EXCHANGE_QUICK_REPLIES: Record<
	OperatorBotExchangeAction,
	ExchangeQuickReplyDraft
> = {
	kyc_approved: {
		title: "KYC подтверждён",
		text: "✅ Верификация пройдена. Продолжаем обмен: сейчас подготовим следующий шаг по оплате.",
		metadata: { exchangeAction: "kyc_approved" },
	},
	kyc_request_materials: {
		title: "Запросить KYC материалы",
		text: "Нужно дослать материалы для проверки: фото/скан документа и короткое видео или кружок, где видно лицо. После этого оператор продолжит обмен.",
		metadata: { exchangeAction: "kyc_request_materials" },
	},
	kyc_rejected: {
		title: "KYC не прошёл",
		text: "По текущим материалам верификацию подтвердить не можем. Пришлите более чёткий документ и короткое видео, либо напишите оператору, если нужна помощь.",
		metadata: { exchangeAction: "kyc_rejected" },
	},
	payment_under_review: {
		title: "Оплата на проверке",
		text: `Чек получили. Проверяем поступление средств; как только платёж подтвердится, перейдём к выдаче ${QUOTE_CURRENCY.code}.`,
		metadata: { exchangeAction: "payment_under_review" },
	},
	payment_confirmed: {
		title: "Оплата подтверждена",
		text: `✅ Оплата подтверждена. Готовим выдачу ${QUOTE_CURRENCY.code}; оператор сейчас согласует способ и место получения.`,
		metadata: {
			exchangeAction: "payment_confirmed",
			patchLatestOrderStatus: "paid",
		},
	},
	payment_problem: {
		title: "Проблема с оплатой",
		text: "По оплате нужна дополнительная проверка: поступление пока не подтверждено. Проверьте, пожалуйста, сумму/банк/время платежа и пришлите чек ещё раз, если он был не виден.",
		metadata: { exchangeAction: "payment_problem" },
	},
	payout_ready: {
		title: "Выдача готовится",
		text: `Выдача ${QUOTE_CURRENCY.code} готовится. Сейчас оператор подтвердит финальные детали: способ, место или код получения.`,
		metadata: { exchangeAction: "payout_ready", issuePayoutCode: true },
	},
	office_details: {
		title: "Офис и время",
		text: "Получение в офисе возможно. Оператор подтвердит точный адрес, окно времени и порядок выдачи в этом диалоге.",
		metadata: { exchangeAction: "office_details" },
	},
	operator_reply: {
		title: "Оператор подключился",
		text: "Оператор подключился к диалогу и сейчас проверит заявку вручную. Ответим здесь, как только будет точное решение.",
		metadata: { exchangeAction: "operator_reply" },
	},
};


export class OperatorBotHandler {
	private client: TelegramClient | null = null;
	private readonly draftStore: DraftStore;
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
			const handled = await this.handlePotentialDraftReply(
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
			const handled = await this.handleTopicReply(
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
			await this.handleOperatorAction(cq, s, operatorAction.payload);
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
			await this.handlePreviewAction(cq, s, previewAction);
			return;
		}
		const exchangeAction = parseOperatorExchangeActionCallback(cq.data);
		if (exchangeAction) {
			await this.handleExchangeAction(cq, s, exchangeAction);
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

	private async handlePotentialDraftReply(
		message: TgMessage,
		chatId: string,
		text: string,
	): Promise<boolean> {
		if (!this.client) return false;
		const conversationId = this.extractConversationIdFromReply(
			message.reply_to_message,
		);
		if (!conversationId) return false;

		const settings = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!settings) {
			await this.replyNotLinked(chatId);
			return true;
		}

		const draftText = text.trim();
		if (!draftText) return false;
		if (draftText.length > 4000) {
			await this.client.sendMessage({
				chatId,
				text: "Сообщение слишком длинное. Максимум 4000 символов.",
			});
			return true;
		}
		if (!this.actions.db) {
			await this.client.sendMessage({
				chatId,
				text: "Отправка из operator bot не настроена.",
			});
			return true;
		}

		// Своё сообщение оператора уходит клиенту НАПРЯМУЮ — без превью и
		// подтверждения (быстрый ответ из чата). Канны/коды (Оплата OK, Выдача)
		// по-прежнему через превью — там деньги/коды. dbId не задаём → отправка
		// без claim'а черновика.
		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const draft: PendingOperatorDraft = {
			draftId: this.draftStore.createDraftId(),
			tenantId: settings.tenantId,
			adminId: settings.adminId,
			chatId,
			conversationId,
			text: draftText,
			metadata: { source: "operator_bot_reply_direct" },
			createdAt: now,
			expiresAt: now + PREVIEW_TTL_SEC,
		};
		const result = await this.sendDraftToClient(draft);
		await this.client.sendMessage({
			chatId,
			parseMode: "HTML",
			text: result.messageHtml,
		});
		return true;
	}

	/**
	 * #651 — ответ оператора в ТОПИКЕ форум-группы. Сообщение приходит из чата
	 * группы (не из личного), поэтому tenant резолвим по форум-правилу
	 * (target_id = chat группы), а диалог — по треду
	 * (conversations.operator_thread_id). Дальше уходит клиенту тем же путём, что
	 * и быстрый reply (#649): sendDraftToClient, без превью.
	 *
	 * Возвращает true, если сообщение обработано как топик-ответ (даже при
	 * ошибке доставки — мы ответили оператору). false → это не форум-топик,
	 * caller продолжает обычную обработку.
	 */
	private async handleTopicReply(
		chatId: string,
		threadId: number,
		text: string,
	): Promise<boolean> {
		if (!this.client) return false;
		if (!this.actions.db) return false;

		// 1. tenant по форум-правилу группы. Нет правила → не наш форум-чат.
		const rule = await this.repo.findForumRuleByTargetId(chatId);
		if (!rule) return false;

		// 2. диалог по треду (tenant-scoped).
		const conversations = new ConversationsRepo({
			db: this.actions.db,
			tenantId: rule.tenantId,
		});
		const conversation =
			await conversations.findConversationByOperatorThread(threadId);
		if (!conversation) return false;

		const draftText = text.trim();
		if (!draftText) return false;
		if (draftText.length > 4000) {
			await this.client.sendMessage({
				chatId,
				messageThreadId: threadId,
				text: "Сообщение слишком длинное. Максимум 4000 символов.",
			});
			return true;
		}

		// adminId для аудита/ассайна: назначенный оператор диалога, иначе owner.
		const adminId =
			conversation.assignedAdminId ??
			(await this.resolveOwnerAdminId(rule.tenantId));
		if (adminId == null) {
			await this.client.sendMessage({
				chatId,
				messageThreadId: threadId,
				text: "Не удалось определить оператора для отправки. Привяжите аккаунт в админке.",
			});
			return true;
		}

		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const draft: PendingOperatorDraft = {
			draftId: this.draftStore.createDraftId(),
			tenantId: rule.tenantId,
			adminId,
			chatId,
			conversationId: conversation.id,
			text: draftText,
			metadata: {
				source: "operator_bot_topic_reply",
				operatorThreadId: threadId,
			},
			createdAt: now,
			expiresAt: now + PREVIEW_TTL_SEC,
		};
		const result = await this.sendDraftToClient(draft);
		// Ответ оператору — В ТОТ ЖЕ топик, чтобы статус был рядом с диалогом.
		await this.client.sendMessage({
			chatId,
			messageThreadId: threadId,
			parseMode: "HTML",
			text: result.messageHtml,
		});
		return true;
	}

	/** Owner (superadmin) tenant'а — fallback-оператор для топик-ответа. */
	private async resolveOwnerAdminId(tenantId: number): Promise<number | null> {
		const owner = await this.repo.resolveOwnerSettings(tenantId);
		return owner?.adminId ?? null;
	}

	private async handleExchangeAction(
		cq: TgCallbackQuery,
		settings: { adminId: number; tenantId: number },
		input: {
			action: OperatorBotExchangeAction;
			conversationId: number;
			orderId?: number;
		},
	): Promise<void> {
		if (!this.client) return;
		const chatId = String(cq.message?.chat.id ?? cq.from.id);

		// «Ответить» — не канна, а приглашение написать СВОЁ: open force-reply,
		// текст оператора уйдёт клиенту напрямую (handlePotentialDraftReply).
		if (input.action === "operator_reply") {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Напишите ответ — уйдёт клиенту",
			});
			await this.client.sendMessage({
				chatId,
				parseMode: "HTML",
				text:
					`✍️ <b>Ответ клиенту — диалог #${input.conversationId}</b>\n\n` +
					"Напишите сообщение ответом на это — оно сразу уйдёт клиенту (диалог перейдёт в работу оператора).",
				replyMarkup: {
					force_reply: true,
					input_field_placeholder: "Ваш ответ клиенту…",
				},
			});
			return;
		}

		const quickReply = EXCHANGE_QUICK_REPLIES[input.action];
		if (!quickReply) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Действие не поддержано",
				showAlert: true,
			});
			return;
		}

		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const scope = await this.resolveExchangeActionScope({
			tenantId: settings.tenantId,
			conversationId: input.conversationId,
			orderId: input.orderId,
		});
		if (scope.kind === "blocked") {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: scope.toast,
				showAlert: true,
			});
			return;
		}

		// KYC OK — один тап: засчитываем верификацию, двигаем воронку и
		// возвращаем диалог в AI (бот продолжает сам). Без превью и без
		// отдельного сообщения клиенту — следующий шаг бот выдаёт сам.
		if (input.action === "kyc_approved") {
			await this.applyInstantKycApproved(cq, chatId, settings, input, now);
			return;
		}

		const resolved = await this.resolveExchangeQuickReply({
			tenantId: settings.tenantId,
			conversationId: input.conversationId,
			orderId: input.orderId,
			action: input.action,
			quickReply,
			now,
		});
		if (resolved.kind === "blocked") {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: resolved.toast,
				showAlert: true,
			});
			return;
		}
		const draft = await this.draftStore.createPendingDraft({
			draftId: this.draftStore.createDraftId(),
			tenantId: settings.tenantId,
			adminId: settings.adminId,
			chatId,
			conversationId: input.conversationId,
			text: resolved.quickReply.text,
			metadata: {
				source: "operator_bot_exchange_action",
				...(input.orderId ? { orderId: input.orderId } : {}),
				...resolved.quickReply.metadata,
			},
			createdAt: now,
			expiresAt: now + PREVIEW_TTL_SEC,
		});

		await this.client.answerCallbackQuery({
			callbackQueryId: cq.id,
			text: "Preview готов",
		});
		await this.sendDraftPreview(chatId, draft, resolved.quickReply.title);
	}

	/**
	 * KYC OK в один тап: верификация засчитывается сразу (как при отправке
	 * черновика), воронка двигается дальше (applyKycDecisionSideEffect), а диалог
	 * возвращается в AI-режим — бот продолжает обмен сам. Клиенту отдельное
	 * сообщение НЕ шлём: следующий шаг (оплата) выдаёт бот.
	 */
	private async applyInstantKycApproved(
		cq: TgCallbackQuery,
		chatId: string,
		settings: { adminId: number; tenantId: number },
		input: { conversationId: number; orderId?: number },
		now: number,
	): Promise<void> {
		if (!this.client) return;
		const db = this.actions.db;
		if (!db) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Действия не настроены",
				showAlert: true,
			});
			return;
		}

		const draft: PendingOperatorDraft = {
			draftId: this.draftStore.createDraftId(),
			tenantId: settings.tenantId,
			adminId: settings.adminId,
			chatId,
			conversationId: input.conversationId,
			text: "",
			metadata: {
				source: "operator_bot_exchange_action",
				exchangeAction: "kyc_approved",
				...(input.orderId ? { orderId: input.orderId } : {}),
			},
			createdAt: now,
			expiresAt: now + PREVIEW_TTL_SEC,
		};

		const outcome = await withTenant(db, settings.tenantId, async (tx) => {
			const [conv] = await tx
				.select({ contactId: conversations.userId, mode: conversations.mode })
				.from(conversations)
				.where(
					and(
						eq(conversations.tenantId, settings.tenantId),
						eq(conversations.id, input.conversationId),
					),
				)
				.limit(1);
			if (!conv) return { kind: "not_found" } as const;

			await applyKycDecisionSideEffect(
				tx,
				draft,
				now,
				conv.contactId,
				"kyc_approved",
			);

			// Возвращаем диалог боту, чтобы он продолжил обмен. Снимаем метку
			// эскалации — KYC одобрен, оператор больше не нужен.
			if (conv.mode !== "ai") {
				await tx
					.update(conversations)
					.set({ mode: "ai", lastMessageAt: now, escalatedAt: null })
					.where(
						and(
							eq(conversations.tenantId, settings.tenantId),
							eq(conversations.id, input.conversationId),
						),
					);
			}
			return { kind: "ok" } as const;
		});

		if (outcome.kind === "not_found") {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Диалог не найден",
				showAlert: true,
			});
			return;
		}

		await this.client.answerCallbackQuery({
			callbackQueryId: cq.id,
			text: "✅ KYC подтверждён",
		});
		await this.client.sendMessage({
			chatId,
			parseMode: "HTML",
			text: `✅ <b>KYC подтверждён</b>\nДиалог #${input.conversationId}: верификация засчитана, диалог вернулся в AI — бот продолжит обмен сам.`,
			replyMarkup: {
				inline_keyboard: [
					[
						{
							text: "👁 Открыть чат",
							url: this.conversationUrl(input.conversationId),
						},
					],
				],
			},
		});
	}

	private async resolveExchangeActionScope(input: {
		tenantId: number;
		conversationId: number;
		orderId?: number;
	}): Promise<{ kind: "ready" } | { kind: "blocked"; toast: string }> {
		if (!this.actions.db) return { kind: "ready" };
		return withTenant(this.actions.db, input.tenantId, async (tx) => {
			const [conversation] = await tx
				.select({ id: conversations.id })
				.from(conversations)
				.where(
					and(
						eq(conversations.tenantId, input.tenantId),
						eq(conversations.id, input.conversationId),
					),
				)
				.limit(1);
			if (!conversation) {
				return { kind: "blocked", toast: "Диалог не найден" } as const;
			}
			if (!input.orderId) return { kind: "ready" } as const;

			const [order] = await tx
				.select({ id: exchangeOrders.id })
				.from(exchangeOrders)
				.where(
					and(
						eq(exchangeOrders.tenantId, input.tenantId),
						eq(exchangeOrders.conversationId, input.conversationId),
						eq(exchangeOrders.id, input.orderId),
					),
				)
				.limit(1);
			if (!order) {
				return { kind: "blocked", toast: "Заявка не найдена" } as const;
			}
			return { kind: "ready" } as const;
		});
	}

	private async resolveExchangeQuickReply(input: {
		tenantId: number;
		conversationId: number;
		orderId?: number;
		action: OperatorBotExchangeAction;
		quickReply: ExchangeQuickReplyDraft;
		now: number;
	}): Promise<
		| { kind: "ready"; quickReply: ExchangeQuickReplyDraft }
		| { kind: "blocked"; toast: string }
	> {
		if (!input.orderId || !this.actions.db) {
			return { kind: "ready", quickReply: input.quickReply };
		}
		const orderId = input.orderId;

		if (input.action === "office_details") {
			const [order] = await withTenant(
				this.actions.db,
				input.tenantId,
				async (tx) =>
					tx
						.select({
							id: exchangeOrders.id,
							payoutMethod: exchangeOrders.payoutMethod,
							payoutLocation: exchangeOrders.payoutLocation,
							payoutDestinationJson: exchangeOrders.payoutDestinationJson,
						})
						.from(exchangeOrders)
						.where(
							and(
								eq(exchangeOrders.tenantId, input.tenantId),
								eq(exchangeOrders.conversationId, input.conversationId),
								eq(exchangeOrders.id, orderId),
							),
						)
						.limit(1),
			);
			if (!order) return { kind: "blocked", toast: "Заявка не найдена" };
			const location = order.payoutLocation?.trim() || "выбранный офис";
			const pickupWindow = pickupWindowFromDestination(
				order.payoutDestinationJson,
			);
			return {
				kind: "ready",
				quickReply: {
					title: "Офис и время",
					text:
						`🏢 Получение в офисе: ${location}. ` +
						(pickupWindow
							? `Окно получения: ${pickupWindow}. `
							: "Окно получения подтвердит оператор. ") +
						"Оператор фиксирует готовность и отправит финальные инструкции здесь.",
					metadata: {
						...input.quickReply.metadata,
						orderId: order.id,
						payoutMethod: order.payoutMethod,
						payoutLocation: order.payoutLocation,
						...(pickupWindow ? { pickupWindow } : {}),
					},
				},
			};
		}

		if (input.action !== "payout_ready") {
			return { kind: "ready", quickReply: input.quickReply };
		}

		const [order] = await withTenant(
			this.actions.db,
			input.tenantId,
			async (tx) =>
				tx
					.select({
						id: exchangeOrders.id,
						status: exchangeOrders.status,
						payoutCode: exchangeOrders.payoutCode,
						payoutCodeExpiresAt: exchangeOrders.payoutCodeExpiresAt,
						payoutLocation: exchangeOrders.payoutLocation,
						payoutMethod: exchangeOrders.payoutMethod,
					})
					.from(exchangeOrders)
					.where(
						and(
							eq(exchangeOrders.tenantId, input.tenantId),
							eq(exchangeOrders.conversationId, input.conversationId),
							eq(exchangeOrders.id, orderId),
						),
					)
					.limit(1),
		);
		if (!order) return { kind: "blocked", toast: "Заявка не найдена" };
		if (order.status !== "paid" && order.status !== "payout") {
			return {
				kind: "blocked",
				toast: `Выдача недоступна: статус ${order.status}`,
			};
		}

		const code = order.payoutCode ?? createPayoutCode(order.id);
		const expiresAt =
			order.payoutCodeExpiresAt && order.payoutCodeExpiresAt > input.now
				? order.payoutCodeExpiresAt
				: input.now + PAYOUT_CODE_TTL_SEC;
		const minutes = Math.max(1, Math.round((expiresAt - input.now) / 60));
		const location = order.payoutLocation
			? ` Место: ${order.payoutLocation}.`
			: "";
		const method = order.payoutMethod ? ` Способ: ${order.payoutMethod}.` : "";
		return {
			kind: "ready",
			quickReply: {
				title: `Код выдачи ${QUOTE_CURRENCY.code}`,
				text: `🔐 Код выдачи: ${code}.${location}${method} Код действует ${minutes} мин.`,
				metadata: {
					...input.quickReply.metadata,
					orderId: order.id,
					payoutCode: code,
					payoutCodeExpiresAt: expiresAt,
					payoutCodeGenerated: !order.payoutCode,
				},
			},
		};
	}

	private async sendDraftPreview(
		chatId: string,
		draft: PendingOperatorDraft,
		title: string,
	): Promise<void> {
		if (!this.client) return;
		await this.client.sendMessage({
			chatId,
			parseMode: "HTML",
			text:
				`🧾 <b>${escapeHtml(title)}</b>\n\n` +
				`Диалог: #${draft.conversationId}\n\n` +
				this.previewOrderLine(draft) +
				`<b>Текст:</b>\n${escapeHtml(draft.text)}\n\n` +
				"После отправки сообщение попадёт в историю, уйдёт клиенту в активный канал, а диалог останется в human mode.",
			replyMarkup: {
				inline_keyboard: [
					[
						{
							text: "Отправить клиенту",
							callback_data: operatorPreviewCallbackData("send", draft.draftId),
						},
					],
					[
						{
							text: "Отмена",
							callback_data: operatorPreviewCallbackData(
								"cancel",
								draft.draftId,
							),
						},
					],
				],
			},
		});
	}

	private previewOrderLine(draft: PendingOperatorDraft): string {
		const rawOrderId = draft.metadata?.orderId;
		const orderId =
			typeof rawOrderId === "number" && Number.isInteger(rawOrderId)
				? rawOrderId
				: typeof rawOrderId === "string"
					? Number.parseInt(rawOrderId, 10)
					: null;
		return orderId && orderId > 0 ? `Заявка: #${orderId}\n\n` : "";
	}

	private extractConversationIdFromReply(
		message: TgMessage | undefined,
	): number | null {
		if (!message) return null;
		const rows = message.reply_markup?.inline_keyboard ?? [];
		for (const row of rows) {
			for (const button of row) {
				const action = parseOperatorActionCallbackData(button.callback_data);
				if (action.ok) return action.payload.conversationId;
				const urlMatch = button.url?.match(/\/conversations\/(\d+)(?:\D|$)/);
				if (urlMatch?.[1]) return Number.parseInt(urlMatch[1], 10);
			}
		}
		const textMatch = message.text?.match(/(?:Диалог|чат)\s*#?(\d+)/i);
		return textMatch?.[1] ? Number.parseInt(textMatch[1], 10) : null;
	}

	private async handlePreviewAction(
		cq: TgCallbackQuery,
		settings: { adminId: number; tenantId: number },
		input: { action: "send" | "cancel"; draftId: string },
	): Promise<void> {
		if (!this.client) return;
		const chatId = String(cq.message?.chat.id ?? cq.from.id);
		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const draft = await this.draftStore.findPendingDraft(input.draftId, settings.tenantId);
		if (
			!draft ||
			draft.tenantId !== settings.tenantId ||
			draft.adminId !== settings.adminId ||
			draft.chatId !== chatId ||
			draft.status !== "pending" ||
			now >= draft.expiresAt
		) {
			if (draft && now >= draft.expiresAt && draft.status === "pending") {
				await this.draftStore.expireDraft(draft, now);
			}
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Preview истёк или уже обработан",
				showAlert: true,
			});
			return;
		}

		if (input.action === "cancel") {
			await this.draftStore.cancelDraft(draft, now);
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Отменено",
			});
			await this.client.sendMessage({
				chatId,
				text: `Отменено. Клиенту ничего не отправлено по диалогу #${draft.conversationId}.`,
			});
			return;
		}

		if (!this.actions.db) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Отправка не настроена",
				showAlert: true,
			});
			return;
		}

		const result = await this.sendDraftToClient(draft);
		if (result.kind === "sent") {
			this.draftStore.deletePending(input.draftId);
		}
		await this.client.answerCallbackQuery({
			callbackQueryId: cq.id,
			text: result.toast,
			showAlert: result.kind !== "sent",
		});
		await this.client.sendMessage({
			chatId,
			parseMode: "HTML",
			text: result.messageHtml,
			replyMarkup: {
				inline_keyboard: [
					[
						{
							text: "👁 Открыть чат",
							url: this.conversationUrl(draft.conversationId),
						},
					],
				],
			},
		});
	}

	/**
	 * #731: переводит ответ оператора (RU) на язык клиента ДО открытия tx
	 * (LLM-вызов нельзя внутри withTenant). Канны (exchangeAction — коды/
	 * реквизиты) и ru-диалоги не переводим. Нет resolveChat / ошибка → null.
	 */
	private async translateOperatorReply(
		draft: PendingOperatorDraft,
		db: Db,
	): Promise<{ text: string; lang: Lang } | null> {
		const resolveChat = this.actions.resolveChat;
		if (!resolveChat) return null;
		if (draft.metadata?.exchangeAction) return null;
		if (!draft.text?.trim()) return null;
		const lang = await withTenant(db, draft.tenantId, async (tx) => {
			const [conv] = await tx
				.select({ detectedLang: conversations.detectedLang })
				.from(conversations)
				.where(
					and(
						eq(conversations.tenantId, draft.tenantId),
						eq(conversations.id, draft.conversationId),
					),
				)
				.limit(1);
			return asSupportedLang(conv?.detectedLang);
		});
		if (!lang || !needsTranslation(OPERATOR_LANG, lang)) return null;
		const translated = await translateText({
			chat: resolveChat(draft.tenantId),
			text: draft.text,
			targetLang: lang,
			onWarn: (m) => console.warn(m),
		});
		return translated === draft.text ? null : { text: translated, lang };
	}

	private async sendDraftToClient(draft: PendingOperatorDraft): Promise<{
		kind: "sent" | "not_found" | "no_channel" | "already_handled";
		toast: string;
		messageHtml: string;
	}> {
		const db = this.actions.db;
		if (!db) {
			return {
				kind: "not_found",
				toast: "Отправка не настроена",
				messageHtml: "⚠️ Отправка из operator bot не настроена.",
			};
		}
		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		// #731: перевод RU→язык клиента ВНЕ tx (LLM нельзя внутри withTenant).
		const translation = await this.translateOperatorReply(draft, db);
		const outcome = await withTenant(db, draft.tenantId, async (tx) => {
			const [conv] = await tx
				.select({ id: conversations.id, contactId: conversations.userId })
				.from(conversations)
				.where(
					and(
						eq(conversations.tenantId, draft.tenantId),
						eq(conversations.id, draft.conversationId),
					),
				)
				.limit(1);
			if (!conv) return { kind: "not_found" } as const;

			const [identity] = await tx
				.select({
					channelDbId: channels.id,
					channelKind: channels.kind,
					externalUserId: channelIdentities.externalUserId,
				})
				.from(channelIdentities)
				.innerJoin(channels, eq(channels.id, channelIdentities.channelId))
				.where(
					and(
						eq(channelIdentities.contactId, conv.contactId),
						eq(channels.status, "active"),
					),
				)
				.orderBy(desc(channels.id))
				.limit(1);
			if (!identity) return { kind: "no_channel" } as const;

			let claimedDraftId: number | null = null;
			if (draft.dbId) {
				const [claimed] = await tx
					.update(operatorActionDrafts)
					.set({
						status: "sent",
						handledAt: now,
						updatedAt: now,
					})
					.where(
						and(
							eq(operatorActionDrafts.id, draft.dbId),
							eq(operatorActionDrafts.tenantId, draft.tenantId),
							eq(operatorActionDrafts.status, "pending"),
							eq(operatorActionDrafts.chatId, draft.chatId),
							gt(operatorActionDrafts.expiresAt, now),
						),
					)
					.returning({ id: operatorActionDrafts.id });
				if (!claimed) return { kind: "already_handled" } as const;
				claimedDraftId = claimed.id;
			}

			const [msg] = await tx
				.insert(messages)
				.values({
					tenantId: draft.tenantId,
					conversationId: draft.conversationId,
					role: "human",
					text: draft.text,
					...(translation
						? {
								origLang: OPERATOR_LANG,
								translatedText: translation.text,
								translatedLang: translation.lang,
							}
						: {}),
					metaJson: JSON.stringify({
						adminId: draft.adminId,
						sentVia: "operator-bot-preview",
						...(draft.metadata ?? {}),
					}),
					createdAt: now,
				})
				.returning({ id: messages.id });
			if (!msg) {
				throw new Error("operator bot send: message insert returned no row");
			}

			const exchangeSideEffects = await applyExchangeDraftSideEffects(
				tx,
				draft,
				now,
				conv.contactId,
			);

			const envelope = {
				channelId: String(identity.channelDbId),
				externalUserId: identity.externalUserId,
				parts: [{ kind: "text", text: translation?.text ?? draft.text }],
			};
			const [queued] = await tx
				.insert(outboundQueue)
				.values({
					tenantId: draft.tenantId,
					channelId: identity.channelDbId,
					conversationId: draft.conversationId,
					payloadJson: JSON.stringify(envelope),
					idempotencyKey: `operator-bot-reply-${draft.draftId}`,
					scheduledAt: now,
					createdAt: now,
				})
				.returning({ id: outboundQueue.id });

			if (claimedDraftId) {
				await tx
					.update(operatorActionDrafts)
					.set({
						messageId: msg.id,
						outboundQueueId: queued?.id ?? null,
						updatedAt: now,
					})
					.where(eq(operatorActionDrafts.id, claimedDraftId));
			}

			await tx
				.update(conversations)
				.set({
					mode: "human",
					lastMessageAt: now,
					lastMessageText: draft.text.slice(0, 200),
					assignedAdminId: draft.adminId,
					unreadCount: 0,
				})
				.where(eq(conversations.id, draft.conversationId));

			await tx.insert(auditLog).values({
				tenantId: draft.tenantId,
				adminId: draft.adminId,
				action: "conversation.reply.operator_bot",
				targetKind: "conversation",
				targetId: String(draft.conversationId),
				detailsJson: JSON.stringify({
					messageId: msg.id,
					channelKind: identity.channelKind,
					textLength: draft.text.length,
					source: "operator_bot_preview",
					...(exchangeSideEffects ? { exchangeSideEffects } : {}),
				}),
				createdAt: now,
			});

			return { kind: "sent", channelKind: identity.channelKind } as const;
		});

		if (outcome.kind === "not_found") {
			return {
				kind: "not_found",
				toast: "Диалог не найден",
				messageHtml: `⚠️ Диалог #${draft.conversationId} не найден или недоступен.`,
			};
		}
		if (outcome.kind === "no_channel") {
			return {
				kind: "no_channel",
				toast: "Нет канала клиента",
				messageHtml: `⚠️ У диалога #${draft.conversationId} нет активного канала для доставки клиенту.`,
			};
		}
		if (outcome.kind === "already_handled") {
			return {
				kind: "already_handled",
				toast: "Preview уже обработан",
				messageHtml: `ℹ️ Preview по диалогу #${draft.conversationId} уже обработан или истёк. Дубль клиенту не отправлен.`,
			};
		}
		return {
			kind: "sent",
			toast: "Отправлено клиенту",
			messageHtml: `✅ <b>Отправлено клиенту</b>\n\nДиалог #${draft.conversationId} переведён в human mode. Сообщение добавлено в историю и поставлено в очередь доставки.`,
		};
	}

	private async handleOperatorAction(
		cq: TgCallbackQuery,
		settings: { adminId: number; tenantId: number },
		input: OperatorActionPayload,
	): Promise<void> {
		if (!this.client) return;
		if (input.tenantId > 0 && input.tenantId !== settings.tenantId) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Нет доступа к этому чату",
				showAlert: true,
			});
			return;
		}
		if (input.action === "open_chat") {
			const appUrl = this.actions.appUrl?.replace(/\/+$/, "");
			await this.client.answerCallbackQuery(
				appUrl
					? {
							callbackQueryId: cq.id,
							url: `${appUrl}/conversations/${input.conversationId}`,
						}
					: {
							callbackQueryId: cq.id,
							text: `Откройте чат #${input.conversationId} в админке`,
							showAlert: true,
						},
			);
			return;
		}
		if (!this.actions.db) {
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Действия оператора ещё не настроены",
				showAlert: true,
			});
			return;
		}

		const result = await this.applyConversationModeAction({
			tenantId: settings.tenantId,
			adminId: settings.adminId,
			conversationId: input.conversationId,
			action: input.action,
		});

		await this.client.answerCallbackQuery({
			callbackQueryId: cq.id,
			text: result.toast,
			showAlert: result.kind === "not_found" || result.kind === "error",
		});
		await this.client.sendMessage({
			chatId: String(cq.message?.chat.id ?? cq.from.id),
			parseMode: "HTML",
			text: result.messageHtml,
			replyMarkup: {
				inline_keyboard: [
					[
						{
							text: "👁 Открыть чат",
							url: this.conversationUrl(input.conversationId),
						},
					],
				],
			},
		});
	}

	private async applyConversationModeAction(input: {
		tenantId: number;
		adminId: number;
		conversationId: number;
		action: OperatorBotActionKind;
	}): Promise<{
		kind: "changed" | "noop" | "not_found" | "error";
		toast: string;
		messageHtml: string;
	}> {
		const db = this.actions.db;
		if (!db) {
			return {
				kind: "error",
				toast: "Действия не настроены",
				messageHtml: "⚠️ Действия оператора ещё не настроены.",
			};
		}
		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const nextMode = input.action === "takeover" ? "human" : "ai";
		const actionName =
			input.action === "takeover"
				? "conversation.mode.takeover.operator_bot"
				: "conversation.mode.return_to_ai.operator_bot";

		const outcome = await withTenant(db, input.tenantId, async (tx) => {
			const [existing] = await tx
				.select({ mode: conversations.mode })
				.from(conversations)
				.where(
					and(
						eq(conversations.tenantId, input.tenantId),
						eq(conversations.id, input.conversationId),
					),
				)
				.limit(1);
			if (!existing) return { kind: "not_found" } as const;
			if (existing.mode === nextMode) {
				return { kind: "noop", from: existing.mode, to: nextMode } as const;
			}

			await tx
				.update(conversations)
				.set({
					mode: nextMode,
					lastMessageAt: now,
					...(nextMode === "human"
						? { assignedAdminId: input.adminId, unreadCount: 0 }
						: {}),
				})
				.where(eq(conversations.id, input.conversationId));

			await tx.insert(auditLog).values({
				tenantId: input.tenantId,
				adminId: input.adminId,
				action: actionName,
				targetKind: "conversation",
				targetId: String(input.conversationId),
				detailsJson: JSON.stringify({
					from: existing.mode,
					to: nextMode,
					source: "operator_bot",
				}),
				createdAt: now,
			});

			return { kind: "changed", from: existing.mode, to: nextMode } as const;
		});

		if (outcome.kind === "not_found") {
			return {
				kind: "not_found",
				toast: "Диалог не найден",
				messageHtml: `⚠️ Диалог #${input.conversationId} не найден или недоступен вашему tenant.`,
			};
		}
		if (outcome.kind === "noop") {
			const label =
				nextMode === "human"
					? "уже в работе оператора"
					: "уже под управлением AI";
			return {
				kind: "noop",
				toast: "Уже актуально",
				messageHtml: `ℹ️ Диалог #${input.conversationId} ${label}.`,
			};
		}

		const text =
			nextMode === "human"
				? `✅ <b>Взято в работу</b>\n\nДиалог #${input.conversationId} переведён в human mode. AI больше не отвечает, пока оператор не вернёт управление.`
				: `🤖 <b>AI снова активен</b>\n\nДиалог #${input.conversationId} возвращён под управление AI.`;
		return {
			kind: "changed",
			toast: nextMode === "human" ? "Взято в работу" : "AI включён",
			messageHtml: text,
		};
	}

	private conversationUrl(conversationId: number): string {
		const appUrl = this.actions.appUrl?.replace(/\/+$/, "");
		return appUrl
			? `${appUrl}/conversations/${conversationId}`
			: `/conversations/${conversationId}`;
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

	private async replyNotLinked(chatId: string): Promise<void> {
		await this.client?.sendMessage({
			chatId,
			text: "Сначала привяжите аккаунт: Админка → Уведомления → «Подключить Telegram».",
		});
	}
}
