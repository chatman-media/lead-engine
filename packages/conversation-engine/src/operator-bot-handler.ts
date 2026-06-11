import {
	TelegramClient,
	type TgCallbackQuery,
	type TgMessage,
	type TgReplyMarkup,
	type TgUpdate,
} from "@chatman-media/channel-telegram";
import {
	auditLog,
	channelIdentities,
	channels,
	contacts,
	conversations,
	exchangeOrders,
	leadEvents,
	leads,
	messages,
	operatorActionDrafts,
	outboundQueue,
	stageDefinitions,
} from "@chatman-media/storage";
import { and, desc, eq, gt } from "drizzle-orm";
import type { NotificationsRepo } from "./dal/notifications.ts";
import type { Db } from "./dal/types.ts";
import { QUOTE_CURRENCY } from "./exchange-quote-currency.ts";
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

const LEVELS = ["silent", "critical", "important", "all"] as const;
const LEVEL_LABEL: Record<string, string> = {
	silent: "🔕 Тихо",
	critical: "🔴 Только критичное",
	important: "🟡 Важное",
	all: "📢 Всё подряд",
};

const TOPICS = ["leads", "escalation", "orders", "system"] as const;
const TOPIC_LABEL: Record<string, string> = {
	leads: "🆕 Лиды",
	escalation: "🆘 Эскалации",
	orders: "💱 Заявки",
	system: "🛠 Система",
};

const DIGESTS = ["off", "daily", "shift"] as const;
const DIGEST_LABEL: Record<string, string> = {
	off: "Выкл",
	daily: "Раз в день",
	shift: "2×/день",
};

const SEV_EMOJI: Record<string, string> = {
	critical: "🔴",
	important: "🟡",
	info: "ℹ️",
};

const PREVIEW_TTL_SEC = 10 * 60;
const PAYOUT_CODE_TTL_SEC = 60 * 60;

interface PendingOperatorDraft {
	draftId: string;
	dbId?: number;
	tenantId: number;
	adminId: number;
	chatId: string;
	conversationId: number;
	text: string;
	metadata?: Record<string, unknown>;
	status?: string;
	createdAt: number;
	expiresAt: number;
}

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

function escapeHtml(v: string): string {
	return v
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function parseJsonObject(
	value: string | null | undefined,
): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function pickupWindowFromDestination(
	value: string | null | undefined,
): string | null {
	if (!value?.trim()) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		const obj = objectValue(parsed);
		return (
			stringValue(obj.pickupWindow) ??
			stringValue(obj.pickup_window) ??
			stringValue(obj.window) ??
			stringValue(obj.timeWindow) ??
			stringValue(obj.time_window) ??
			stringValue(obj.slot)
		);
	} catch {
		return null;
	}
}

/** "2h" / "30m" / "1d" → секунды; "off"/"0"/"" → 0; мусор → null. */
export function parseMuteSeconds(arg: string): number | null {
	const a = arg.trim().toLowerCase();
	if (!a || a === "off" || a === "0") return 0;
	const m = /^(\d+)\s*(m|h|d)$/.exec(a);
	if (!m) return null;
	const n = Number.parseInt(m[1] as string, 10);
	const unit = m[2];
	return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
}

export class OperatorBotHandler {
	private client: TelegramClient | null = null;
	private readonly pendingDrafts = new Map<string, PendingOperatorDraft>();

	constructor(
		private readonly repo: NotificationsRepo,
		botToken: string,
		private readonly actions: {
			db?: Db;
			appUrl?: string;
			nowEpoch?: () => number;
		} = {},
	) {
		if (botToken) {
			this.client = new TelegramClient({ token: botToken });
		}
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

		// 1. Личная привязка по /start <token>
		if (text.startsWith("/start ")) {
			const token = text.split(" ")[1];
			if (token) {
				await this.handleLinkToken(token, chatId);
				return;
			}
		}

		// 2. Привязка группы по /setup <token>
		if (text.startsWith("/setup ")) {
			const token = text.split(" ")[1];
			if (token) {
				await this.handleGroupLinkToken(
					token,
					message.chat.id,
					message.chat.title || "группа",
				);
				return;
			}
		}

		// 2b. /setup без токена — показать ID группы
		if (text === "/setup" || text.startsWith("/setup@")) {
			await this.handleSetupGroup(
				message.chat.id,
				message.chat.title || "эту группу",
			);
			return;
		}

		// 3. Команды информера (личный чат владельца/оператора).
		if (text === "/status") return this.cmdStatus(chatId);
		if (text === "/level") return this.cmdLevel(chatId);
		if (text === "/topics") return this.cmdTopics(chatId);
		if (text === "/digest") return this.cmdDigest(chatId);
		if (text === "/mute" || text.startsWith("/mute "))
			return this.cmdMute(chatId, text);
		if (text === "/last" || text.startsWith("/last "))
			return this.cmdLast(chatId, text);

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

	private async cmdStatus(chatId: string): Promise<void> {
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		const now = Math.floor(Date.now() / 1000);
		const muted =
			s.informerMutedUntil && s.informerMutedUntil > now
				? `вкл (ещё ${Math.ceil((s.informerMutedUntil - now) / 60)} мин)`
				: "выкл";
		const map = this.topicMap(s.informerTopics);
		const topicsLine = TOPICS.map(
			(t) => `${map[t] ? "✅" : "⬜"} ${TOPIC_LABEL[t]}`,
		).join("\n");
		await this.client?.sendMessage({
			chatId,
			parseMode: "HTML",
			text:
				"⚙️ <b>Информер</b>\n\n" +
				`Уровень: <b>${LEVEL_LABEL[s.informerLevel] ?? s.informerLevel}</b>\n` +
				`Дайджест: <b>${DIGEST_LABEL[s.informerDigest] ?? s.informerDigest}</b> ` +
				`(${s.informerDigestHour}:00 ${s.informerTz})\n` +
				`Мут: <b>${muted}</b>\n\n` +
				`Темы:\n${topicsLine}\n\n` +
				"Изменить: /level · /topics · /digest · /mute",
		});
	}

	private async cmdLevel(chatId: string): Promise<void> {
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		await this.client?.sendMessage({
			chatId,
			text: "Насколько громко информировать?",
			replyMarkup: this.levelKeyboard(s.informerLevel),
		});
	}

	private async cmdTopics(chatId: string): Promise<void> {
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		await this.client?.sendMessage({
			chatId,
			text: "Темы (нажми, чтобы вкл/выкл):",
			replyMarkup: this.topicsKeyboard(this.topicMap(s.informerTopics)),
		});
	}

	private async cmdDigest(chatId: string): Promise<void> {
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		await this.client?.sendMessage({
			chatId,
			text: "Как часто слать сводку?",
			replyMarkup: this.digestKeyboard(s.informerDigest),
		});
	}

	private async cmdMute(chatId: string, text: string): Promise<void> {
		const arg = text.split(/\s+/)[1] ?? "";
		const sec = parseMuteSeconds(arg);
		if (sec === null) {
			await this.client?.sendMessage({
				chatId,
				text: "Формат: /mute 30m · /mute 2h · /mute 1d · /mute off",
			});
			return;
		}
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		const until = sec === 0 ? null : Math.floor(Date.now() / 1000) + sec;
		await this.repo.updateInformerPrefs(s.adminId, {
			informerMutedUntil: until,
		});
		await this.client?.sendMessage({
			chatId,
			text: until
				? `🔇 Заглушено на ${Math.round(sec / 60)} мин. Реалтайм вернётся, события всё равно попадут в дайджест.`
				: "🔔 Мут снят.",
		});
	}

	private async cmdLast(chatId: string, text: string): Promise<void> {
		const s = await this.repo.findOperatorSettingsByChatId(chatId);
		if (!s) return this.replyNotLinked(chatId);
		const arg = Number.parseInt(text.split(/\s+/)[1] ?? "", 10);
		const limit = Number.isFinite(arg) ? Math.min(Math.max(arg, 1), 20) : 10;
		const rows = await this.repo.listRecentNotifications(
			s.tenantId,
			s.adminId,
			limit,
		);
		if (rows.length === 0) {
			await this.client?.sendMessage({
				chatId,
				text: "Пока пусто — событий ещё не было.",
			});
			return;
		}
		let msg = `🗒 <b>Последние ${rows.length}:</b>`;
		for (const r of rows) {
			const when = new Date(r.createdAt * 1000)
				.toISOString()
				.slice(5, 16)
				.replace("T", " ");
			msg += `\n\n${SEV_EMOJI[r.severity] ?? ""} <b>${escapeHtml(r.title)}</b> · ${when}`;
			if (r.body) msg += `\n${escapeHtml(r.body)}`;
		}
		await this.client?.sendMessage({ chatId, parseMode: "HTML", text: msg });
	}

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
				this.levelKeyboard(val as string),
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
				this.digestKeyboard(val as string),
			);
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: DIGEST_LABEL[val as string],
			});
			return;
		}
		if (kind === "tpc" && (TOPICS as readonly string[]).includes(val ?? "")) {
			const map = this.topicMap(s.informerTopics);
			map[val as string] = !map[val as string];
			await this.repo.updateInformerPrefs(s.adminId, {
				informerTopics: JSON.stringify(map),
			});
			await this.editKeyboard(
				cq,
				"Темы (нажми, чтобы вкл/выкл):",
				this.topicsKeyboard(map),
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

		const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
		const draftId = this.createDraftId();
		const draft = await this.createPendingDraft({
			draftId,
			tenantId: settings.tenantId,
			adminId: settings.adminId,
			chatId,
			conversationId,
			text: draftText,
			metadata: { source: "telegram_reply_preview" },
			createdAt: now,
			expiresAt: now + PREVIEW_TTL_SEC,
		});

		await this.sendDraftPreview(chatId, draft, "Preview сообщения клиенту");
		return true;
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
		const draft = await this.createPendingDraft({
			draftId: this.createDraftId(),
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

		const code = order.payoutCode ?? this.createPayoutCode(order.id);
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
		const draft = await this.findPendingDraft(input.draftId, settings.tenantId);
		if (
			!draft ||
			draft.tenantId !== settings.tenantId ||
			draft.adminId !== settings.adminId ||
			draft.chatId !== chatId ||
			draft.status !== "pending" ||
			now >= draft.expiresAt
		) {
			if (draft && now >= draft.expiresAt && draft.status === "pending") {
				await this.expireDraft(draft, now);
			}
			await this.client.answerCallbackQuery({
				callbackQueryId: cq.id,
				text: "Preview истёк или уже обработан",
				showAlert: true,
			});
			return;
		}

		if (input.action === "cancel") {
			await this.cancelDraft(draft, now);
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
			this.pendingDrafts.delete(input.draftId);
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

			const exchangeSideEffects = await this.applyExchangeDraftSideEffects(
				tx,
				draft,
				now,
				conv.contactId,
			);

			const envelope = {
				channelId: String(identity.channelDbId),
				externalUserId: identity.externalUserId,
				parts: [{ kind: "text", text: draft.text }],
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

	private async applyExchangeDraftSideEffects(
		tx: Db,
		draft: PendingOperatorDraft,
		now: number,
		contactId: number,
	): Promise<Record<string, unknown> | null> {
		const action = stringValue(draft.metadata?.exchangeAction);
		if (
			action === "kyc_approved" ||
			action === "kyc_request_materials" ||
			action === "kyc_rejected"
		) {
			return this.applyKycDecisionSideEffect(tx, draft, now, contactId, action);
		}
		if (action === "payment_confirmed") {
			return this.applyPaymentConfirmedSideEffect(tx, draft, now);
		}
		if (action === "payout_ready") {
			return this.applyPayoutReadySideEffect(tx, draft, now);
		}
		if (action === "office_details") {
			return this.applyOfficeDetailsSideEffect(tx, draft);
		}
		return null;
	}

	private async findExchangeOrderForDraft(
		tx: Db,
		draft: PendingOperatorDraft,
	): Promise<{
		id: number;
		leadId: number | null;
		status: string;
		payoutCode: string | null;
		payoutCodeExpiresAt: number | null;
		verificationId: string | null;
		payoutMethod: string | null;
		payoutLocation: string | null;
		payoutDestinationJson: string | null;
	} | null> {
		const orderId = this.metadataOrderId(draft.metadata);
		const selection = {
			id: exchangeOrders.id,
			leadId: exchangeOrders.leadId,
			status: exchangeOrders.status,
			payoutCode: exchangeOrders.payoutCode,
			payoutCodeExpiresAt: exchangeOrders.payoutCodeExpiresAt,
			verificationId: exchangeOrders.verificationId,
			payoutMethod: exchangeOrders.payoutMethod,
			payoutLocation: exchangeOrders.payoutLocation,
			payoutDestinationJson: exchangeOrders.payoutDestinationJson,
		};
		if (orderId) {
			const [order] = await tx
				.select(selection)
				.from(exchangeOrders)
				.where(
					and(
						eq(exchangeOrders.tenantId, draft.tenantId),
						eq(exchangeOrders.conversationId, draft.conversationId),
						eq(exchangeOrders.id, orderId),
					),
				)
				.limit(1);
			return order ?? null;
		}
		const [order] = await tx
			.select(selection)
			.from(exchangeOrders)
			.where(
				and(
					eq(exchangeOrders.tenantId, draft.tenantId),
					eq(exchangeOrders.conversationId, draft.conversationId),
				),
			)
			.orderBy(desc(exchangeOrders.createdAt))
			.limit(1);
		return order ?? null;
	}

	private async applyKycDecisionSideEffect(
		tx: Db,
		draft: PendingOperatorDraft,
		now: number,
		contactId: number,
		action: "kyc_approved" | "kyc_request_materials" | "kyc_rejected",
	): Promise<Record<string, unknown>> {
		const decision =
			action === "kyc_approved"
				? {
						status: "verified",
						verified: true,
						needsVerification: false,
					}
				: action === "kyc_rejected"
					? {
							status: "rejected",
							verified: false,
							needsVerification: true,
						}
					: {
							status: "materials_requested",
							verified: false,
							needsVerification: true,
						};
		const [contact] = await tx
			.select({ attributesJson: contacts.attributesJson })
			.from(contacts)
			.where(
				and(eq(contacts.tenantId, draft.tenantId), eq(contacts.id, contactId)),
			)
			.limit(1);
		if (!contact) {
			return {
				action,
				contactId,
				contactFound: false,
				statusPatched: false,
			};
		}

		const attrs = parseJsonObject(contact.attributesJson);
		const currentKyc = objectValue(attrs.exchangeKyc);
		const existingVerificationId = stringValue(currentKyc.verificationId);
		const verificationId = decision.verified
			? (existingVerificationId ??
				`operator-bot-${draft.conversationId}-${now}`)
			: null;
		const nextKyc = {
			...currentKyc,
			status: decision.status,
			verified: decision.verified,
			needsVerification: decision.needsVerification,
			verificationId,
			reviewedByAdminId: draft.adminId,
			reviewedAt: now,
			source: "operator_bot",
		};
		const nextAttrs = {
			...attrs,
			exchangeKyc: nextKyc,
			verificationStatus: decision.status,
			kycStatus: decision.status,
			isVerified: decision.verified,
		};

		await tx
			.update(contacts)
			.set({
				attributesJson: JSON.stringify(nextAttrs),
				updatedAt: now,
			})
			.where(
				and(eq(contacts.tenantId, draft.tenantId), eq(contacts.id, contactId)),
			);

		let orderId: number | null = null;
		let orderVerificationPatched = false;
		const order = await this.findExchangeOrderForDraft(tx, draft);
		if (order) {
			orderId = order.id;
			const patchableStatuses = new Set(["quote", "awaiting_payment"]);
			const nextOrderVerificationId = decision.verified ? verificationId : null;
			if (
				patchableStatuses.has(order.status) &&
				order.verificationId !== nextOrderVerificationId
			) {
				await tx
					.update(exchangeOrders)
					.set({
						verificationId: nextOrderVerificationId,
						updatedAt: now,
					})
					.where(
						and(
							eq(exchangeOrders.tenantId, draft.tenantId),
							eq(exchangeOrders.id, order.id),
						),
					);
				orderVerificationPatched = true;
			}
		}

		const leadAdvance = decision.verified
			? await this.advanceExchangeLeadAfterKycApproved(
					tx,
					draft,
					now,
					contactId,
					order?.leadId ?? null,
				)
			: null;

		return {
			action,
			contactId,
			status: decision.status,
			verified: decision.verified,
			verificationId,
			statusPatched: true,
			...(orderId ? { orderId, orderVerificationPatched } : {}),
			...(leadAdvance ? { leadAdvance } : {}),
		};
	}

	private async advanceExchangeLeadAfterKycApproved(
		tx: Db,
		draft: PendingOperatorDraft,
		now: number,
		contactId: number,
		orderLeadId: number | null,
	): Promise<Record<string, unknown>> {
		const leadFilter =
			orderLeadId != null
				? eq(leads.id, orderLeadId)
				: eq(leads.userId, contactId);
		const [lead] = await tx
			.select({
				id: leads.id,
				state: leads.state,
				stageDefinitionId: leads.stageDefinitionId,
				stageSlug: stageDefinitions.slug,
				stageFunnelId: stageDefinitions.funnelId,
				stagePosition: stageDefinitions.position,
				stageNextStages: stageDefinitions.nextStages,
			})
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
			.where(and(eq(leads.tenantId, draft.tenantId), leadFilter))
			.orderBy(desc(leads.updatedAt), desc(leads.id))
			.limit(1);
		if (!lead) {
			return {
				advanced: false,
				reason: "lead_not_found",
				...(orderLeadId != null ? { leadId: orderLeadId } : {}),
			};
		}

		const currentSlug = lead.stageSlug ?? lead.state;
		if (
			currentSlug !== "verification_check" &&
			currentSlug !== "kyc_collection"
		) {
			return {
				leadId: lead.id,
				advanced: false,
				reason: "stage_not_eligible",
				stage: currentSlug,
			};
		}
		if (lead.stageFunnelId == null || lead.stagePosition == null) {
			return {
				leadId: lead.id,
				advanced: false,
				reason: "stage_context_missing",
				stage: currentSlug,
			};
		}
		const nextStages = lead.stageNextStages ?? [];
		if (nextStages.length > 0 && !nextStages.includes("risk_review")) {
			return {
				leadId: lead.id,
				advanced: false,
				reason: "transition_not_allowed",
				stage: currentSlug,
			};
		}

		const [target] = await tx
			.select({
				id: stageDefinitions.id,
				slug: stageDefinitions.slug,
				position: stageDefinitions.position,
			})
			.from(stageDefinitions)
			.where(
				and(
					eq(stageDefinitions.tenantId, draft.tenantId),
					eq(stageDefinitions.funnelId, lead.stageFunnelId),
					eq(stageDefinitions.slug, "risk_review"),
				),
			)
			.limit(1);
		if (!target) {
			return {
				leadId: lead.id,
				advanced: false,
				reason: "target_stage_not_found",
				stage: currentSlug,
			};
		}
		if (target.position <= lead.stagePosition) {
			return {
				leadId: lead.id,
				advanced: false,
				reason: "target_not_ahead",
				stage: currentSlug,
				targetStage: target.slug,
			};
		}

		await tx
			.update(leads)
			.set({
				stageDefinitionId: target.id,
				state: target.slug,
				updatedAt: now,
			})
			.where(and(eq(leads.tenantId, draft.tenantId), eq(leads.id, lead.id)));
		await tx.insert(leadEvents).values({
			tenantId: draft.tenantId,
			leadId: lead.id,
			fromState: lead.state,
			toState: target.slug,
			byAdminId: draft.adminId,
			notes: JSON.stringify({
				type: "operator_bot_kyc_approved",
				conversationId: draft.conversationId,
			}),
			createdAt: now,
		});

		return {
			leadId: lead.id,
			advanced: true,
			fromState: lead.state,
			toState: target.slug,
			stageDefinitionId: target.id,
		};
	}

	private async applyPaymentConfirmedSideEffect(
		tx: Db,
		draft: PendingOperatorDraft,
		now: number,
	): Promise<Record<string, unknown>> {
		const orderId = this.metadataOrderId(draft.metadata);
		const order = await this.findExchangeOrderForDraft(tx, draft);
		if (!order) {
			return {
				action: "payment_confirmed",
				...(orderId ? { orderId } : {}),
				orderFound: false,
				statusPatched: false,
			};
		}

		const terminal = new Set([
			"paid",
			"payout",
			"completed",
			"cancelled",
			"expired",
		]);
		if (terminal.has(order.status)) {
			return {
				action: "payment_confirmed",
				orderId: order.id,
				previousStatus: order.status,
				statusPatched: false,
			};
		}

		await tx
			.update(exchangeOrders)
			.set({ status: "paid", updatedAt: now })
			.where(
				and(
					eq(exchangeOrders.tenantId, draft.tenantId),
					eq(exchangeOrders.id, order.id),
				),
			);
		return {
			action: "payment_confirmed",
			orderId: order.id,
			previousStatus: order.status,
			nextStatus: "paid",
			statusPatched: true,
		};
	}

	private async applyPayoutReadySideEffect(
		tx: Db,
		draft: PendingOperatorDraft,
		now: number,
	): Promise<Record<string, unknown>> {
		const orderId = this.metadataOrderId(draft.metadata);
		const order = await this.findExchangeOrderForDraft(tx, draft);
		if (!order) {
			return {
				action: "payout_ready",
				...(orderId ? { orderId } : {}),
				orderFound: false,
				statusPatched: false,
			};
		}
		if (order.status !== "paid" && order.status !== "payout") {
			return {
				action: "payout_ready",
				orderId: order.id,
				previousStatus: order.status,
				statusPatched: false,
				reason: "invalid_status",
			};
		}

		const metadataCode = stringValue(draft.metadata?.payoutCode);
		const code =
			order.payoutCode ?? metadataCode ?? this.createPayoutCode(order.id);
		const metadataExpiresAt = this.numericMetadata(
			draft.metadata?.payoutCodeExpiresAt,
		);
		const expiresAt =
			order.payoutCodeExpiresAt && order.payoutCodeExpiresAt > now
				? order.payoutCodeExpiresAt
				: metadataExpiresAt && metadataExpiresAt > now
					? metadataExpiresAt
					: now + PAYOUT_CODE_TTL_SEC;
		await tx
			.update(exchangeOrders)
			.set({
				status: "payout",
				payoutCode: code,
				payoutCodeExpiresAt: expiresAt,
				updatedAt: now,
			})
			.where(
				and(
					eq(exchangeOrders.tenantId, draft.tenantId),
					eq(exchangeOrders.id, order.id),
				),
			);
		return {
			action: "payout_ready",
			orderId: order.id,
			previousStatus: order.status,
			nextStatus: "payout",
			payoutCodeIssued: true,
			statusPatched: order.status !== "payout",
		};
	}

	private async applyOfficeDetailsSideEffect(
		tx: Db,
		draft: PendingOperatorDraft,
	): Promise<Record<string, unknown>> {
		const orderId = this.metadataOrderId(draft.metadata);
		const order = await this.findExchangeOrderForDraft(tx, draft);
		if (!order) {
			return {
				action: "office_details",
				...(orderId ? { orderId } : {}),
				orderFound: false,
				confirmationState: "not_recorded",
			};
		}
		const pickupWindow =
			stringValue(draft.metadata?.pickupWindow) ??
			pickupWindowFromDestination(order.payoutDestinationJson);
		return {
			action: "office_details",
			orderId: order.id,
			confirmationState: "operator_confirmed",
			payoutMethod: order.payoutMethod,
			payoutLocation: order.payoutLocation,
			...(pickupWindow ? { pickupWindow } : {}),
			statusPatched: false,
		};
	}

	private metadataOrderId(
		metadata: Record<string, unknown> | undefined,
	): number | null {
		const raw = metadata?.orderId;
		if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
			return raw;
		}
		if (typeof raw !== "string" || !raw.trim()) return null;
		const parsed = Number.parseInt(raw, 10);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
	}

	private numericMetadata(value: unknown): number | null {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return Math.floor(value);
		}
		if (typeof value !== "string" || !value.trim()) return null;
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}

	private async createPendingDraft(
		draft: PendingOperatorDraft,
	): Promise<PendingOperatorDraft> {
		const db = this.actions.db;
		if (!db) {
			this.pendingDrafts.set(draft.draftId, { ...draft, status: "pending" });
			return { ...draft, status: "pending" };
		}
		const [row] = await withTenant(db, draft.tenantId, async (tx) =>
			tx
				.insert(operatorActionDrafts)
				.values({
					tenantId: draft.tenantId,
					adminId: draft.adminId,
					conversationId: draft.conversationId,
					draftKey: draft.draftId,
					chatId: draft.chatId,
					kind: "client_reply",
					status: "pending",
					text: draft.text,
					metadataJson: JSON.stringify(draft.metadata ?? {}),
					createdAt: draft.createdAt,
					expiresAt: draft.expiresAt,
					updatedAt: draft.createdAt,
				})
				.returning({ id: operatorActionDrafts.id }),
		);
		return {
			...draft,
			dbId: row?.id,
			status: "pending",
		};
	}

	private async findPendingDraft(
		draftId: string,
		tenantId: number,
	): Promise<PendingOperatorDraft | null> {
		const db = this.actions.db;
		if (!db) return this.pendingDrafts.get(draftId) ?? null;
		const [row] = await withTenant(db, tenantId, async (tx) =>
			tx
				.select({
					id: operatorActionDrafts.id,
					tenantId: operatorActionDrafts.tenantId,
					adminId: operatorActionDrafts.adminId,
					conversationId: operatorActionDrafts.conversationId,
					draftKey: operatorActionDrafts.draftKey,
					chatId: operatorActionDrafts.chatId,
					status: operatorActionDrafts.status,
					text: operatorActionDrafts.text,
					metadataJson: operatorActionDrafts.metadataJson,
					createdAt: operatorActionDrafts.createdAt,
					expiresAt: operatorActionDrafts.expiresAt,
				})
				.from(operatorActionDrafts)
				.where(
					and(
						eq(operatorActionDrafts.tenantId, tenantId),
						eq(operatorActionDrafts.draftKey, draftId),
					),
				)
				.limit(1),
		);
		if (!row || row.adminId === null) return null;
		return {
			draftId: row.draftKey,
			dbId: row.id,
			tenantId: row.tenantId,
			adminId: row.adminId,
			chatId: row.chatId,
			conversationId: row.conversationId,
			text: row.text,
			metadata: parseJsonObject(row.metadataJson),
			status: row.status,
			createdAt: row.createdAt,
			expiresAt: row.expiresAt,
		};
	}

	private async cancelDraft(
		draft: PendingOperatorDraft,
		now: number,
	): Promise<void> {
		const db = this.actions.db;
		if (!db || !draft.dbId) {
			this.pendingDrafts.delete(draft.draftId);
			return;
		}
		await withTenant(db, draft.tenantId, async (tx) => {
			await tx
				.update(operatorActionDrafts)
				.set({ status: "cancelled", handledAt: now, updatedAt: now })
				.where(
					and(
						eq(operatorActionDrafts.id, draft.dbId as number),
						eq(operatorActionDrafts.tenantId, draft.tenantId),
						eq(operatorActionDrafts.status, "pending"),
					),
				);
		});
	}

	private async expireDraft(
		draft: PendingOperatorDraft,
		now: number,
	): Promise<void> {
		const db = this.actions.db;
		if (!db || !draft.dbId) {
			this.pendingDrafts.delete(draft.draftId);
			return;
		}
		await withTenant(db, draft.tenantId, async (tx) => {
			await tx
				.update(operatorActionDrafts)
				.set({ status: "expired", handledAt: now, updatedAt: now })
				.where(
					and(
						eq(operatorActionDrafts.id, draft.dbId as number),
						eq(operatorActionDrafts.tenantId, draft.tenantId),
						eq(operatorActionDrafts.status, "pending"),
					),
				);
		});
	}

	private createDraftId(): string {
		for (let i = 0; i < 5; i++) {
			const id =
				globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16) ??
				Math.random().toString(36).slice(2, 14);
			if (id.length >= 6 && !this.pendingDrafts.has(id)) return id;
		}
		return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	private createPayoutCode(orderId: number): string {
		const suffix =
			globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 6) ??
			Math.random().toString(36).slice(2, 8);
		return `CODE-${orderId}-${suffix.toUpperCase()}`;
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

	// ── Клавиатуры / хелперы ───────────────────────────────────────────────

	private levelKeyboard(current: string): TgReplyMarkup {
		return {
			inline_keyboard: LEVELS.map((l) => [
				{
					text: `${l === current ? "• " : ""}${LEVEL_LABEL[l]}`,
					callback_data: `lvl:${l}`,
				},
			]),
		};
	}

	private digestKeyboard(current: string): TgReplyMarkup {
		return {
			inline_keyboard: DIGESTS.map((d) => [
				{
					text: `${d === current ? "• " : ""}${DIGEST_LABEL[d]}`,
					callback_data: `dig:${d}`,
				},
			]),
		};
	}

	private topicsKeyboard(map: Record<string, boolean>): TgReplyMarkup {
		return {
			inline_keyboard: TOPICS.map((t) => [
				{
					text: `${map[t] ? "✅" : "⬜"} ${TOPIC_LABEL[t]}`,
					callback_data: `tpc:${t}`,
				},
			]),
		};
	}

	/** JSON-карта тоглов → полная карта {topic:bool} с дефолтом true. */
	private topicMap(raw: string | null): Record<string, boolean> {
		const base: Record<string, boolean> = {
			leads: true,
			escalation: true,
			orders: true,
			system: true,
		};
		if (!raw) return base;
		try {
			const m = JSON.parse(raw) as Record<string, boolean>;
			for (const t of TOPICS) if (m[t] === false) base[t] = false;
			return base;
		} catch {
			return base;
		}
	}

	private async replyNotLinked(chatId: string): Promise<void> {
		await this.client?.sendMessage({
			chatId,
			text: "Сначала привяжите аккаунт: Админка → Уведомления → «Подключить Telegram».",
		});
	}

	// ── Привязка (без изменений) ───────────────────────────────────────────

	private async handleLinkToken(token: string, chatId: string): Promise<void> {
		if (!this.client) return;

		const settings = await this.repo.findByLinkToken(token);
		if (!settings) {
			await this.client.sendMessage({
				chatId,
				text: "❌ Ссылка недействительна или истекла. Пожалуйста, сгенерируйте новую в Админке.",
			});
			return;
		}

		await this.repo.linkChat(settings.adminId, chatId);

		await this.client.sendMessage({
			chatId,
			text: "✅ Аккаунт привязан! Здесь будут важные уведомления. Настрой громкость: /level · /topics · /digest",
		});
	}

	private async handleGroupLinkToken(
		token: string,
		chatId: number,
		title: string,
	): Promise<void> {
		if (!this.client) return;
		const isGroup = chatId < 0;
		if (!isGroup) {
			await this.client.sendMessage({
				chatId: String(chatId),
				text: "❌ /setup с токеном работает только в группах. Добавьте бота в группу и отправьте там эту команду.",
			});
			return;
		}
		const groupToken = await this.repo.findGroupLinkToken(token);
		if (!groupToken) {
			await this.client.sendMessage({
				chatId: String(chatId),
				text: "❌ Токен недействителен или истёк. Сгенерируйте новый в Админке → Уведомления.",
			});
			return;
		}
		await this.repo.createRule({
			tenantId: groupToken.tenantId,
			eventType: groupToken.eventType,
			conditionJson: "{}",
			channelType: "telegram_group",
			targetId: String(chatId),
			priority: "normal",
			isActive: true,
		});
		await this.repo.deleteGroupLinkToken(token);
		await this.client.sendMessage({
			chatId: String(chatId),
			text: `✅ Группа <b>${title}</b> подключена к Lead Engine!\n\nОтсюда вы будете получать уведомления о событиях: <b>${groupToken.eventType}</b>.`,
			parseMode: "HTML",
		});
	}

	private async handleSetupGroup(chatId: number, title: string): Promise<void> {
		if (!this.client) return;

		const isGroup = chatId < 0;
		if (!isGroup) {
			await this.client.sendMessage({
				chatId: String(chatId),
				text: "команда /setup работает только в группах. Добавьте меня в группу и напишите там /setup.",
			});
			return;
		}

		await this.client.sendMessage({
			chatId: String(chatId),
			text: `🏗 <b>Настройка группы "${title}"</b>\n\nID этой группы: <code>${chatId}</code>\n\nСкопируйте этот ID и вставьте его в настройки уведомлений в Админке, чтобы бот мог присылать сюда алерты.`,
			parseMode: "HTML",
		});
	}
}
