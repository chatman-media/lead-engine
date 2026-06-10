import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { z } from "zod";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";
import { LlmReplyStrategy, type LlmReplyStrategyOpts } from "./llm-reply.ts";

const TEMPLATE: VerticalTemplate = {
	slug: "test_v1",
	displayName: "Test",
	version: 1,
	funnelStages: [{ slug: "intake", kind: "intake", displayName: "Intake" }],
	systemPromptFragment: "Ты — тестовый бот вертикали.",
};

const EXCHANGE_TEMPLATE: VerticalTemplate = {
	...TEMPLATE,
	slug: "exchange_v1",
};

class CapturingChat implements ChatClient {
	lastCall: { messages: ChatMessage[]; opts: unknown } | null = null;
	constructor(public readonly reply: string) {}
	async complete(messages: ChatMessage[], opts?: unknown): Promise<string> {
		this.lastCall = { messages, opts };
		return this.reply;
	}
}

function fakeMessagesRepo(history: MessageRow[]) {
	return {
		recent: async () => history,
	} as unknown as MessagesRepo;
}

function row(
	id: number,
	role: "user" | "assistant" | "human" | "system",
	text: string,
): MessageRow {
	return {
		id,
		tenantId: 1,
		conversationId: 100,
		role,
		text,
		tgMessageId: null,
		metaJson: null,
		createdAt: 1700000000 + id,
		stage: null,
		deletedAt: null,
	};
}

describe("LlmReplyStrategy", () => {
	it("отправляет system + history + текущее в ChatClient, возвращает text envelope", async () => {
		const chat = new CapturingChat("Привет! Чем помочь?");
		const repo = fakeMessagesRepo([
			row(1, "user", "Здравствуйте"),
			row(2, "assistant", "Добрый день!"),
			row(3, "user", "Расскажите про условия"),
		]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);

		const envelopes = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 7,
			inbound: { externalUserId: "u1" },
			userMessageText: "Расскажите про условия",
		});

		expect(envelopes).not.toBeNull();
		expect(envelopes![0]?.parts).toEqual([
			{ kind: "text", text: "Привет! Чем помочь?" },
		]);
		expect(envelopes![0]?.externalUserId).toBe("u1");

		// System prompt состоит из base + template fragment.
		const sent = chat.lastCall!.messages;
		expect(sent[0]?.role).toBe("system");
		expect(sent[0]?.content).toContain("Ты — операционный бот");
		expect(sent[0]?.content).toContain("Ты — тестовый бот вертикали.");
		// История правильно конвертится: user/assistant роли.
		expect(sent.slice(1)).toEqual([
			{ role: "user", content: "Здравствуйте" },
			{ role: "assistant", content: "Добрый день!" },
			{ role: "user", content: "Расскажите про условия" },
		]);
	});

	it("конвертит role='human' (operator) в 'assistant' для LLM", async () => {
		const chat = new CapturingChat("ok");
		const repo = fakeMessagesRepo([
			row(1, "user", "?"),
			row(2, "human", "Отвечу через 5 минут"),
		]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
		await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "?",
		});
		const sent = chat.lastCall!.messages;
		expect(sent.find((m) => m.content === "Отвечу через 5 минут")?.role).toBe(
			"assistant",
		);
	});

	it("injects brokered order context into the system prompt", async () => {
		const chat = new CapturingChat("Контекст учту.");
		const repo = fakeMessagesRepo([]);
		const strategy = new LlmReplyStrategy(
			{
				template: TEMPLATE,
				resolveChat: () => chat,
				resolveServiceOrderContext: () =>
					"BROKERED ORDER CONTEXT\n- order #12 service=massage status=offer_ready amount=1,200 THB",
			},
			() => repo,
		);

		await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 7,
			inbound: { externalUserId: "u1" },
			userMessageText: "что по заявке?",
		});

		const system = chat.lastCall?.messages[0]?.content ?? "";
		expect(system).toContain("BROKERED ORDER CONTEXT");
		expect(system).toContain("order #12");
		expect(system).toContain("status=offer_ready");
	});

	it("пропускает пустой userMessageText (null = бот молчит)", async () => {
		const chat = new CapturingChat("never called");
		const repo = fakeMessagesRepo([]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "",
		});
		expect(result).toBeNull();
		expect(chat.lastCall).toBeNull();
	});

	it("пропускает пустой ответ LLM (null вместо envelope с whitespace)", async () => {
		const chat = new CapturingChat("   ");
		const repo = fakeMessagesRepo([row(1, "user", "?")]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "?",
		});
		expect(result).toBeNull();
	});

	it("exchange: неподкреплённый курс заменяет safe fallback", async () => {
		const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
		const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
		const strategy = new LlmReplyStrategy(
			{ template: EXCHANGE_TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "сколько за 335 usdt?",
		});
		expect(result).not.toBeNull();
		expect((result![0]!.parts[0] as { text: string }).text).toBe(
			EXCHANGE_SAFE_FALLBACK,
		);
	});

	it("exchange: явное подтверждение после quote вызывает create order вместо повторения quote", async () => {
		const chat = new CapturingChat("не должен вызываться");
		let createArgs: Record<string, unknown> | null = null;
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу обменять 500 USDT TRC20 на баты"),
			row(
				2,
				"assistant",
				"Обмен USDT — THB\nКурс: 31.5\n\nОтдаёте: 500 USDT\nПолучаете: 15750 THB\n\nЕсли курс подходит, напишите «подтверждаю», и я оформлю заявку.",
			),
			row(3, "user", "Подтверждаю. Что дальше?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [
					{
						name: "create_exchange_order",
						description: "create",
						parameters: z.object({}),
						execute: async (args) => {
							createArgs = args;
							return {
								ok: false,
								needsVerification: true,
								instructions:
									"Для обмена нужно пройти верификацию: пришлите документ и видео.",
							};
						},
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Подтверждаю. Что дальше?",
		});

		expect(chat.lastCall).toBeNull();
		expect(createArgs).toMatchObject({
			asset: "USDT",
			amount: 500,
			network: "TRC20",
		});
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("верификацию");
		expect(text).not.toContain("Если курс подходит");
	});

	it("exchange: после KYC-вопроса про банк не откатывается в quote-card", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Подтверждаю"),
			row(
				2,
				"assistant",
				"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО.",
			),
			row(
				3,
				"user",
				"А на какие реквизиты будет перевод батов? На карту тайского банка?",
			),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async () => {
							throw new Error("quote must not be called");
						},
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText:
				"А на какие реквизиты будет перевод батов? На карту тайского банка?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Сначала нужно пройти верификацию");
		expect(text).not.toContain("Курс:");
	});

	it("exchange: видео для KYC передаёт оператору, не имитирует проверку", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Подтверждаю"),
			row(
				2,
				"assistant",
				"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО.",
			),
			row(3, "user", "Вот видео."),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async () => {
							throw new Error("quote must not be called");
						},
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Вот видео.",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Принял документ/видео");
		expect(text).toContain("Проверку делает");
		expect(text).not.toMatch(/проверил|подтвержд/iu);
		expect(result![0]!.operatorHandoff).toMatchObject({
			reason: "kyc_review",
			contractId: "kyc_submitted",
		});
	});

	it("exchange: policy guard блокирует LLM-имитацию проверки KYC", async () => {
		const chat = new CapturingChat(
			"Я проверил видео, KYC подтверждён. Продолжаем.",
		);
		const repo = fakeMessagesRepo([
			row(
				1,
				"assistant",
				"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО.",
			),
			row(2, "user", "Проверяйте"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Проверяйте",
		});

		expect(chat.lastCall).not.toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Передаю верификацию оператору");
		expect(text).not.toContain("KYC подтверждён");
	});

	it("exchange: injects answer-quality state pack into LLM system prompt", async () => {
		const chat = new CapturingChat("Передаю оператору, он проверит заявку.");
		const repo = fakeMessagesRepo([row(1, "user", "что по заявке?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					stageSlug: "payment",
					verification: {
						verified: true,
						status: "verified",
						needsVerification: false,
						verificationId: "ver_1",
					},
					order: {
						id: 42,
						status: "awaiting_payment",
						assetFrom: "RUB",
						network: "",
						amountMode: "source_amount",
						amountFrom: 100000,
						rate: 0.4,
						amountToThb: 40000,
						paymentMethod: "card_transfer",
						payoutMethod: "office_cash",
						payoutLocation: "Bangkok office",
						requisitesIssued: true,
						paymentProofReceived: false,
						paymentVerified: false,
						payoutReady: false,
						payoutCompleted: false,
						payoutCodeIssued: false,
						verificationId: "ver_1",
					},
				}),
			},
			() => repo,
		);

		await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "что по заявке?",
		});

		const system = chat.lastCall!.messages[0]!.content;
		expect(system).toContain("EXCHANGE OPS STATE PACK");
		expect(system).toContain("response_contract: payment_requisites");
		expect(system).toContain("order: #42 status=awaiting_payment");
		expect(system).toContain("pair=100000 RUB -> 40000 THB");
		expect(system).toContain("known_fields:");
		expect(system).toContain("paymentVerified=no");
		expect(system).toContain("payoutLocation=Bangkok office");
		expect(system).toContain("missing_fields: payment_proof");
		expect(system).toContain("allowed_next_actions:");
		expect(system).toContain("refer_to_existing_requisites");
		expect(system).toContain("request_payment_proof");
		expect(system).toContain("forbidden_claims:");
		expect(system).toContain("payment_verified_without_state");
		expect(system).toContain("forbidden:");
	});

	it("exchange: payment proof goes to review without auto-confirming payment", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([row(1, "user", "Вот чек, оплатил рублями")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					order: {
						id: 7,
						status: "awaiting_payment",
						assetFrom: "RUB",
						amountFrom: 100000,
						amountToThb: 40000,
						paymentMethod: "card_transfer",
						payoutMethod: "office_cash",
						requisitesIssued: true,
						paymentProofReceived: false,
						paymentVerified: false,
						payoutReady: false,
						payoutCompleted: false,
						payoutCodeIssued: false,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Вот чек, оплатил рублями",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Принял чек/скрин оплаты");
		expect(text).toContain("не подтверждаю оплату автоматически");
		expect(text).not.toMatch(/оплата\s+(?:получена|подтверждена)/iu);
	});

	it("exchange: office pickup request with pending KYC stays on verification", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([row(1, "user", "получить в офисе можно?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					stageSlug: "verification_check",
					verification: {
						verified: false,
						status: "pending",
						needsVerification: true,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "получить в офисе можно?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Сначала нужно пройти верификацию");
		expect(text).not.toContain("Курс:");
	});

	it("exchange: policy guard использует persisted order state для оплаты", async () => {
		const chat = new CapturingChat(
			"Оплата получена и подтверждена, готовлю выдачу.",
		);
		const repo = fakeMessagesRepo([row(1, "user", "что дальше?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					order: {
						id: 1,
						status: "awaiting_payment",
						requisitesIssued: true,
						paymentProofReceived: true,
						paymentVerified: false,
						payoutReady: false,
						payoutCompleted: false,
						payoutCodeIssued: false,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "что дальше?",
		});

		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Чек/скрин уже принят");
		expect(text).toContain("не подтверждаю оплату автоматически");
		expect(text).not.toContain("Оплата получена");
	});

	it("exchange: persisted paid state returns deterministic payout handoff", async () => {
		const chat = new CapturingChat(
			"Оплата получена и подтверждена, готовлю выдачу.",
		);
		const repo = fakeMessagesRepo([row(1, "user", "что по оплате?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					order: {
						id: 1,
						status: "paid",
						requisitesIssued: true,
						paymentProofReceived: true,
						paymentVerified: true,
						payoutReady: false,
						payoutCompleted: false,
						payoutCodeIssued: false,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "что по оплате?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Оплата отмечена как проверенная");
		expect(text).toContain("Передаю заявку оператору");
		expect(text).not.toContain("Оплата получена");
		expect(result![0]!.operatorHandoff).toMatchObject({
			reason: "payout_review",
			contractId: "payout",
		});
	});

	it("exchange: отказ после KYC закрывает диалог без повторного давления", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Подтверждаю"),
			row(
				2,
				"assistant",
				"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО.",
			),
			row(3, "user", "Я не готов проходить верификацию, отказываюсь от обмена"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async () => {
							throw new Error("quote must not be called");
						},
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText:
				"Я не готов проходить верификацию, отказываюсь от обмена",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("обмен не оформляю");
		expect(text).not.toContain("пришлите документ");
	});

	it("exchange: supportMode не глушит безопасный quote tool-response", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу 500 USDT TRC20 поменять на баты. Какой курс?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: TEMPLATE,
				resolveTemplate: () => EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveIsSupport: async () => true,
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async () => ({
							asset: "USDT",
							amountFrom: 500,
							amountToThb: 15750,
							rate: 31.5,
						}),
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Хочу 500 USDT TRC20 поменять на баты. Какой курс?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Курс: 31.5");
		expect(text).toContain("Получаете: 15750 THB");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			tenantId: 1,
			conversationId: 100,
			contactId: 1,
			assistantText: text,
		});
		expect(recorded[0]?.telemetry.toolCalls?.[0]).toMatchObject({
			name: "compute_exchange_quote",
			args: {
				asset: "USDT",
				amount: 500,
				amountMode: "source_amount",
				network: "TRC20",
			},
			result: {
				asset: "USDT",
				amountFrom: 500,
				amountToThb: 15750,
				rate: 31.5,
			},
			cycle: 0,
		});
	});

	it("exchange: уточнение 'на руки сколько' после quote использует контекст", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу 500 USDT TRC20 поменять на баты"),
			row(
				2,
				"assistant",
				"Обмен USDT — THB\nКурс: 31.5\n\nОтдаёте: 500 USDT\nПолучаете: 15750 THB\n\nЕсли курс подходит, напишите «подтверждаю», и я оформлю заявку.",
			),
			row(3, "user", "А на руки сколько?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveIsSupport: async () => true,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async (args) => ({
							asset: args.asset,
							amountFrom: args.amount,
							amountToThb: 15750,
							rate: 31.5,
						}),
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "А на руки сколько?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("Получаете: 15750 THB");
	});

	it("exchange: возражение по курсу после quote не уходит в молчание", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу 500 USDT TRC20 поменять на баты"),
			row(
				2,
				"assistant",
				"Обмен USDT — THB\nКурс: 31.5\n\nОтдаёте: 500 USDT\nПолучаете: 15750 THB\n\nЕсли курс подходит, напишите «подтверждаю», и я оформлю заявку.",
			),
			row(3, "user", "Почему так мало? У других выгоднее."),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveIsSupport: async () => true,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async (args) => ({
							asset: args.asset,
							amountFrom: args.amount,
							amountToThb: 15750,
							rate: 31.5,
						}),
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Почему так мало? У других выгоднее.",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("курс 31.5");
		expect(text).toContain("15750 THB");
		expect(text).toContain("подтверждаю");
	});

	it("exchange: уточнение предложенного курса после quote получает ответ", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу 500 USDT TRC20 поменять на баты"),
			row(
				2,
				"assistant",
				"Обмен USDT — THB\nКурс: 31.5\n\nОтдаёте: 500 USDT\nПолучаете: 15750 THB\n\nЕсли курс подходит, напишите «подтверждаю», и я оформлю заявку.",
			),
			row(3, "user", "Вы мне предлагаете 31.5 за USDT?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveIsSupport: async () => true,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async (args) => ({
							asset: args.asset,
							amountFrom: args.amount,
							amountToThb: 15750,
							rate: 31.5,
						}),
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "Вы мне предлагаете 31.5 за USDT?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("курс 31.5");
		expect(text).toContain("подтверждаю");
	});

	it("exchange: вопрос про комиссию после quote получает ответ по сути", async () => {
		const chat = new CapturingChat("не должен вызываться");
		const repo = fakeMessagesRepo([
			row(1, "user", "Хочу 500 USDT TRC20 поменять на баты"),
			row(
				2,
				"assistant",
				"Обмен USDT — THB\nКурс: 31.5\n\nОтдаёте: 500 USDT\nПолучаете: 15750 THB\n\nЕсли курс подходит, напишите «подтверждаю», и я оформлю заявку.",
			),
			row(3, "user", "15750 THB это уже чистая сумма или будут комиссии?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveIsSupport: async () => true,
				resolveTools: () => [
					{
						name: "compute_exchange_quote",
						description: "quote",
						parameters: z.object({}),
						execute: async (args) => ({
							asset: args.asset,
							amountFrom: args.amount,
							amountToThb: 15750,
							rate: 31.5,
						}),
					},
				],
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "15750 THB это уже чистая сумма или будут комиссии?",
		});

		expect(chat.lastCall).toBeNull();
		const text = (result![0]!.parts[0] as { text: string }).text;
		expect(text).toContain("сумма к выдаче");
		expect(text).toContain("Дополнительной комиссии обменника");
		expect(text).toContain("подтверждаю");
	});

	it("резолвит ChatClient per-call с tenantId — позволяет invalidate router", async () => {
		const c1 = new CapturingChat("from-client-1");
		const c2 = new CapturingChat("from-client-2");
		const resolved: ChatClient[] = [c1, c2];
		const resolveChat = (_: number) => resolved.shift() ?? c1;
		const repo = fakeMessagesRepo([row(1, "user", "hi")]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat },
			() => repo,
		);

		const first = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "hi",
		});
		const second = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "hi",
		});
		expect(
			(first as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!
				.parts[0]!.text,
		).toBe("from-client-1");
		expect(
			(second as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!
				.parts[0]!.text,
		).toBe("from-client-2");
	});
});
