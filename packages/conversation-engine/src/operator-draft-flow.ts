// Поток операторских ответов и exchange-действий, вынесенный из
// operator-bot-handler в отдельный sub-handler. Принимает реплаи оператора
// (reply/топик), exchange-quick-reply действия и превью черновиков, отправляет
// клиенту с переводом и применяет side-effects заявки. Коллабораторы: client
// (лениво) + repo + draftStore + actions.

import type { TelegramClient, TgCallbackQuery, TgMessage } from "@chatman-media/channel-telegram";
import type { ChatClient } from "@chatman-media/llm-router";
import {
	auditLog,
	channelIdentities,
	channels,
	conversations,
	messages,
	operatorActionDrafts,
	outboundQueue,
} from "@chatman-media/storage";
import { and, desc, eq, gt } from "drizzle-orm";
import { ConversationsRepo } from "./dal/conversations.ts";
import type { NotificationsRepo } from "./dal/notifications.ts";
import type { Db } from "./dal/types.ts";
import { applyExchangeDraftSideEffects, applyKycDecisionSideEffect } from "./exchange-side-effects.ts";
import { QUOTE_CURRENCY } from "./exchange-quote-currency.ts";
import {
	type OperatorBotExchangeAction,
	operatorPreviewCallbackData,
} from "./operator-bot-actions.ts";
import { conversationUrl, escapeHtml, type PendingOperatorDraft } from "./operator-bot-shared.ts";
import type { DraftStore } from "./operator-draft-store.ts";
import { extractConversationIdFromReply, previewOrderLine } from "./operator-draft-parsing.ts";
import {
	type ExchangeQuickReplyDraft,
	resolveExchangeActionScope,
	resolveExchangeQuickReply,
} from "./operator-exchange-quick-reply.ts";
import { translateOperatorReply } from "./operator-reply-translation.ts";
import { OPERATOR_LANG } from "./translation.ts";
import { withTenant } from "./with-tenant.ts";

const PREVIEW_TTL_SEC = 10 * 60;

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


export interface DraftFlowDeps {
	db?: Db;
	appUrl?: string;
	nowEpoch?: () => number;
	resolveChat?: (tenantId: number) => ChatClient;
}

export class DraftFlowHandler {
	constructor(
		private readonly getClient: () => TelegramClient | null,
		private readonly repo: NotificationsRepo,
		private readonly draftStore: DraftStore,
		private readonly actions: DraftFlowDeps,
	) {}

	private get client(): TelegramClient | null {
		return this.getClient();
	}

	async handlePotentialDraftReply(
		message: TgMessage,
		chatId: string,
		text: string,
	): Promise<boolean> {
		if (!this.client) return false;
		const conversationId = extractConversationIdFromReply(
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
	async handleTopicReply(
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

	async handleExchangeAction(
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
		const scope = await resolveExchangeActionScope(this.actions.db, {
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

		const resolved = await resolveExchangeQuickReply(this.actions.db, {
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
							url: conversationUrl(this.actions.appUrl, input.conversationId),
						},
					],
				],
			},
		});
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
				previewOrderLine(draft) +
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

	async handlePreviewAction(
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
							url: conversationUrl(this.actions.appUrl, draft.conversationId),
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
		const translation = await translateOperatorReply(this.actions.resolveChat, draft, db);
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


	private async replyNotLinked(chatId: string): Promise<void> {
		await this.client?.sendMessage({
			chatId,
			text: "Сначала привяжите аккаунт: Админка → Уведомления → «Подключить Telegram».",
		});
	}

}
