import {
	TelegramClient,
	type TgInlineKeyboardButton,
} from "@chatman-media/channel-telegram";
import type { AdminInformer } from "./admin-informer.ts";
import type {
	NotificationRule,
	NotificationsRepo,
} from "./dal/notifications.ts";
import {
	buildOperatorActionCallbackData,
	isOperatorHandoffEvent,
	operatorExchangeActionCallbackData,
	type OperatorBotExchangeAction,
} from "./operator-bot-actions.ts";

export interface NotificationEvent {
	tenantId: number;
	eventType: string;
	leadId?: number;
	conversationId?: number;
	contactId?: number;
	/** assignedAdminId — если задан, проверяется notifyOnAssignedOnly */
	assignedAdminId?: number;
	data: Record<string, unknown>;
}

type TelegramButtonRows = TgInlineKeyboardButton[][];

function numericId(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export class NotificationService {
	private client: TelegramClient | null = null;

	constructor(
		private readonly repo: NotificationsRepo,
		private readonly botToken: string,
		private readonly appUrl: string,
		/**
		 * Если задан — владелец (superadmin) обслуживается информером (уровни +
		 * дайджест + лента) и пропускается в per-operator-рассылке ниже, чтобы не
		 * было дублей. Операторские правила/группы — без изменений.
		 */
		private readonly informer?: AdminInformer,
	) {
		if (botToken) {
			this.client = new TelegramClient({ token: botToken });
		}
	}

	async notify(event: NotificationEvent): Promise<void> {
		// Владелец — через информер (уровни/дайджест/лента), отдельно от операторов.
		const ownerAdminId = this.informer
			? await this.informer.resolveOwnerAdminId(event.tenantId)
			: null;
		if (this.informer) {
			await this.informer.emitNotificationEvent(event);
		}

		if (!this.client) return;

		const [rules, operatorSettingsList] = await Promise.all([
			this.repo.findRulesByEvent(event.tenantId, event.eventType),
			this.repo.findOperatorSettingsByTenant(event.tenantId),
		]);

		const template = await this.repo.findTemplate(
			event.tenantId,
			event.eventType,
		);
		const text = template
			? this.renderTemplate(template.body, event)
			: this.formatMessage(event);
		const buttons = this.formatButtons(event);

		// 1. Групповые/канальные правила
		const matchedRules = rules.filter((rule) =>
			this.matchesCondition(rule, event),
		);
		for (const rule of matchedRules) {
			try {
				await this.sendMessage(rule.targetId, text, buttons);
			} catch (err) {
				console.error(
					`[NotificationService] rule ${rule.id} send failed:`,
					err,
				);
			}
		}

		// 2. Личные уведомления операторам через operator_settings
		for (const settings of operatorSettingsList) {
			if (!settings.telegramChatId) continue;
			// Владельца обслуживает информер — пропускаем, чтобы не дублировать.
			if (ownerAdminId !== null && settings.adminId === ownerAdminId) continue;
			// Фильтр по назначению: пропускаем если флаг включён, а лид назначен другому
			if (
				settings.notifyOnAssignedOnly &&
				event.assignedAdminId !== undefined &&
				event.assignedAdminId !== settings.adminId
			) {
				continue;
			}
			try {
				await this.sendMessage(settings.telegramChatId, text, buttons);
			} catch (err) {
				console.error(
					`[NotificationService] personal send to admin ${settings.adminId} failed:`,
					err,
				);
			}
		}
	}

	async sendTestMessage(
		chatId: string,
	): Promise<{ ok: boolean; error?: string }> {
		if (!this.client)
			return { ok: false, error: "Бот не настроен (нет токена)" };
		try {
			await this.client.sendMessage({
				chatId,
				text: "🧪 <b>Тестовое уведомление</b>\n\nПравило активно — сообщения доходят корректно.",
				parseMode: "HTML",
			});
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async sendDirectMessage(
		chatId: string,
		htmlText: string,
	): Promise<{ ok: boolean; error?: string }> {
		if (!this.client)
			return { ok: false, error: "Бот не настроен (нет токена)" };
		try {
			await this.sendMessage(chatId, htmlText, null);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async sendMessage(
		chatId: string,
		text: string,
		buttons: TelegramButtonRows | null,
	): Promise<void> {
		await this.client!.sendMessage({
			chatId,
			text,
			parseMode: "HTML",
			replyMarkup: buttons ? { inline_keyboard: buttons } : undefined,
		});
	}

	matchesCondition(rule: NotificationRule, event: NotificationEvent): boolean {
		if (!rule.conditionJson || rule.conditionJson === "{}") return true;
		try {
			const condition = JSON.parse(rule.conditionJson) as Record<
				string,
				unknown
			>;
			for (const [key, value] of Object.entries(condition)) {
				if (event.data[key] !== value) return false;
			}
			return true;
		} catch {
			return true;
		}
	}

	renderTemplate(body: string, event: NotificationEvent): string {
		const vars: Record<string, unknown> = {
			...event.data,
			leadId: event.leadId,
			conversationId: event.conversationId,
			tenantId: event.tenantId,
		};
		let result = body;
		for (const [key, value] of Object.entries(vars)) {
			result = result.replace(
				new RegExp(`\\{\\{${key}\\}\\}`, "g"),
				String(value ?? ""),
			);
		}
		return result.replace(/\{\{.{0,200}?\}\}/g, "");
	}

	formatMessage(event: NotificationEvent): string {
		const emoji = this.getEventEmoji(event.eventType);
		let msg = `${emoji} <b>${this.getEventTitle(event.eventType)}</b>\n\n`;

		if (event.data.displayName) {
			msg += `👤 <b>Клиент:</b> ${event.data.displayName}\n`;
		}
		if (event.data.mediaSummary) {
			msg += `📎 <b>Материалы:</b>\n${this.escape(String(event.data.mediaSummary))}\n`;
		}

		for (const [key, value] of Object.entries(event.data)) {
			if (
				[
					"displayName",
					"toStage",
					"fromStage",
					"mediaRefsJson",
					"mediaSummary",
				].includes(key)
			) {
				continue;
			}
			msg += `🔹 <b>${this.formatKey(key)}:</b> ${value}\n`;
		}

		if (event.data.fromStage && event.data.toStage) {
			msg += `\n🔄 <b>Стадия:</b> ${event.data.fromStage} ➡️ ${event.data.toStage}\n`;
		} else if (event.data.toStage) {
			msg += `\n📍 <b>Стадия:</b> ${event.data.toStage}\n`;
		}

		return msg;
	}

	private formatButtons(
		event: NotificationEvent,
	): TelegramButtonRows | null {
		if (isOperatorHandoffEvent(event)) {
			const conversationId = event.conversationId as number;
			const baseRows: TelegramButtonRows = [
				[
					{
						text: "👁 Открыть чат",
						url: this.conversationUrl(conversationId),
					},
				],
				[
					{
						text: "✋ Взять",
						callback_data: buildOperatorActionCallbackData({
							action: "takeover",
							tenantId: event.tenantId,
							conversationId,
						}),
					},
					{
						text: "🤖 Вернуть AI",
						callback_data: buildOperatorActionCallbackData({
							action: "return_ai",
							tenantId: event.tenantId,
							conversationId,
						}),
					},
				],
			];
			const exchangeRows = this.exchangeActionRows(event);
			return [...baseRows, ...exchangeRows];
		}
		if (event.leadId) {
			return [
				[{ text: "👁 Посмотреть", url: `${this.appUrl}/leads/${event.leadId}` }],
			];
		}
		if (event.conversationId) {
			return [
				[
					{
						text: "👁 Чат",
						url: `${this.appUrl}/conversations/${event.conversationId}`,
					},
				],
			];
		}
		return null;
	}

	private exchangeActionRows(event: NotificationEvent): TelegramButtonRows {
		if (!event.conversationId) return [];
		const reason = String(event.data.reason ?? "");
		const orderId = numericId(event.data.orderId);
		const row = (
			items: Array<{ text: string; action: OperatorBotExchangeAction }>,
		): TgInlineKeyboardButton[] =>
			items.map((item) => ({
				text: item.text,
				callback_data: operatorExchangeActionCallbackData(
					item.action,
					event.conversationId as number,
					orderId,
				),
			}));

		if (reason === "kyc_review") {
			return [
				row([
					{ text: "✅ KYC OK", action: "kyc_approved" },
					{ text: "📎 Дослать", action: "kyc_request_materials" },
					{ text: "⛔ Отклонить", action: "kyc_rejected" },
				]),
			];
		}
		if (reason === "payment_review") {
			return [
				row([
					{ text: "✅ Оплата OK", action: "payment_confirmed" },
					{ text: "⏳ Проверяем", action: "payment_under_review" },
					{ text: "⚠️ Проблема", action: "payment_problem" },
				]),
			];
		}
		if (reason === "office_payout") {
			return [
				row([
					{ text: "🏢 Офис/время", action: "office_details" },
					{ text: "🔐 Выдача", action: "payout_ready" },
				]),
			];
		}
		if (reason === "payout_review") {
			return [
				row([
					{ text: "🔐 Выдача", action: "payout_ready" },
					{ text: "🏢 Офис/время", action: "office_details" },
				]),
			];
		}
		if (reason === "operator_request") {
			return [
				row([{ text: "✍️ Ответить", action: "operator_reply" }]),
			];
		}
		return [];
	}

	private conversationUrl(conversationId: number): string {
		return `${this.appUrl.replace(/\/+$/, "")}/conversations/${conversationId}`;
	}

	private getEventEmoji(type: string): string {
		const map: Record<string, string> = {
			lead_intake_complete: "🆕",
			stage_changed: "🔄",
			human_takeover: "🆘",
			operator_handoff_required: "✋",
			verification_requested: "🪪",
			document_uploaded: "📸",
			high_value_deal: "💎",
			lead_stale: "⏰",
			operator_confirm_needed: "✋",
			provider_request_send_failed: "⚠️",
		};
		return map[type] ?? "🔔";
	}

	private getEventTitle(type: string): string {
		const map: Record<string, string> = {
			lead_intake_complete: "Новый лид",
			stage_changed: "Смена стадии",
			human_takeover: "Нужна помощь оператора",
			operator_handoff_required: "Нужно действие оператора",
			verification_requested: "Нужна верификация клиента",
			document_uploaded: "Загружен документ",
			high_value_deal: "Крупная сделка",
			lead_stale: "Лид завис",
			operator_confirm_needed: "Нужно подтверждение оператора",
			provider_request_send_failed: "Ошибка отправки провайдеру",
		};
		return map[type] ?? "Уведомление";
	}

	private escape(value: string): string {
		return value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	}

	private formatKey(key: string): string {
			const map: Record<string, string> = {
				amount: "Сумма",
				action: "Действие",
				asset: "Актив",
				accepted: "Принято",
				contractId: "Contract",
				context: "Контекст",
				network: "Сеть",
				pending: "Ожидает",
				phone: "Телефон",
				priority: "Приоритет",
				rail: "Платёжный канал",
				reviewPath: "Путь проверки",
				email: "Email",
				text: "Сообщение",
				urgency: "Срочность",
			};
		return map[key] ?? key;
	}
}
