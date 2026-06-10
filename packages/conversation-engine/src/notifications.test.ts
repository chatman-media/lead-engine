import { describe, expect, it } from "bun:test";
import type {
	TelegramClient,
	TgSendMessageResult,
} from "@chatman-media/channel-telegram";
import type { AdminInformer } from "./admin-informer.ts";
import type {
	NotificationRule,
	NotificationsRepo,
	NotificationTemplate,
	OperatorSettings,
} from "./dal/notifications.ts";
import {
	type NotificationEvent,
	NotificationService,
} from "./notifications.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
	return {
		id: 1,
		tenantId: 1,
		eventType: "stage_changed",
		conditionJson: "{}",
		channelType: "telegram_group",
		targetId: "group-100",
		priority: "normal",
		isActive: true,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeOperatorSettings(
	overrides: Partial<OperatorSettings> = {},
): OperatorSettings {
	return {
		id: 1,
		adminId: 10,
		tenantId: 1,
		telegramChatId: "chat-10",
		notifyOnAssignedOnly: false,
		linkToken: null,
		linkTokenExpiresAt: null,
		informerLevel: "important",
		informerTopics: null,
		informerDigest: "daily",
		informerDigestHour: 9,
		informerTz: "UTC",
		informerMutedUntil: null,
		informerLastDigestAt: null,
		informerQuietFrom: null,
		informerQuietTo: null,
		updatedAt: 0,
		...overrides,
	};
}

function makeRepo(
	rules: NotificationRule[] = [],
	settings: OperatorSettings[] = [],
	template: { body: string } | undefined = undefined,
): NotificationsRepo {
	return {
		findRulesByEvent: async () => rules,
		findOperatorSettingsByTenant: async () => settings,
		findTemplate: async () =>
			template
				? ({
						id: 1,
						tenantId: 1,
						slug: "stage_changed",
						body: template.body,
						updatedAt: 0,
					} satisfies NotificationTemplate)
				: undefined,
		// unused in NotificationService:
		findOperatorSettings: async () => undefined,
		findByLinkToken: async () => undefined,
		generateLinkToken: async () => "",
		linkChat: async () => {},
		upsertOperatorSettings: async () => {},
		listRules: async () => [],
		createRule: async (r: Parameters<NotificationsRepo["createRule"]>[0]) => ({
			...r,
			id: 1,
			createdAt: 0,
			updatedAt: 0,
		}),
		deleteRule: async () => {},
		upsertTemplate: async () => {},
		listTemplates: async () => [],
		deleteTemplate: async () => {},
	} as unknown as NotificationsRepo;
}

const BASE_EVENT: NotificationEvent = {
	tenantId: 1,
	eventType: "stage_changed",
	leadId: 42,
	data: { fromStage: "intake", toStage: "qualified" },
};

type SendMessageInput = Parameters<TelegramClient["sendMessage"]>[0];

function telegramResult(input: SendMessageInput): TgSendMessageResult {
	return {
		message_id: 1,
		chat: {
			id: typeof input.chatId === "number" ? input.chatId : 1,
			type: "private",
		},
		date: 0,
		text: input.text,
	};
}

function fakeTelegramClient(
	onSend: (input: SendMessageInput) => void | Promise<void>,
): TelegramClient {
	return {
		sendMessage: async (input: SendMessageInput) => {
			await onSend(input);
			return telegramResult(input);
		},
	} as unknown as TelegramClient;
}

// ── matchesCondition ───────────────────────────────────────────────────────────

describe("NotificationService.matchesCondition", () => {
	const svc = new NotificationService(makeRepo(), "", "http://app");

	it("returns true for empty condition", () => {
		expect(
			svc.matchesCondition(makeRule({ conditionJson: "{}" }), BASE_EVENT),
		).toBe(true);
	});

	it("returns true when all condition fields match event.data", () => {
		const rule = makeRule({
			conditionJson: JSON.stringify({ toStage: "qualified" }),
		});
		expect(svc.matchesCondition(rule, BASE_EVENT)).toBe(true);
	});

	it("returns false when a condition field does not match", () => {
		const rule = makeRule({
			conditionJson: JSON.stringify({ toStage: "won" }),
		});
		expect(svc.matchesCondition(rule, BASE_EVENT)).toBe(false);
	});

	it("returns true on malformed JSON (safe fallback)", () => {
		expect(
			svc.matchesCondition(makeRule({ conditionJson: "NOT JSON" }), BASE_EVENT),
		).toBe(true);
	});
});

// ── renderTemplate ─────────────────────────────────────────────────────────────

describe("NotificationService.renderTemplate", () => {
	const svc = new NotificationService(makeRepo(), "", "http://app");

	it("replaces known placeholders", () => {
		const result = svc.renderTemplate("Стадия: {{toStage}}", BASE_EVENT);
		expect(result).toBe("Стадия: qualified");
	});

	it("replaces leadId placeholder", () => {
		const result = svc.renderTemplate("Лид #{{leadId}}", BASE_EVENT);
		expect(result).toBe("Лид #42");
	});

	it("removes unused placeholders", () => {
		const result = svc.renderTemplate("{{unknown}} ok", BASE_EVENT);
		expect(result).toBe(" ok");
	});
});

// ── formatMessage ──────────────────────────────────────────────────────────────

describe("NotificationService.formatMessage", () => {
	const svc = new NotificationService(makeRepo(), "", "http://app");

	it("includes event emoji and title", () => {
		const msg = svc.formatMessage({
			tenantId: 1,
			eventType: "stage_changed",
			data: {},
		});
		expect(msg).toContain("🔄");
		expect(msg).toContain("Смена стадии");
	});

	it("includes both stages when fromStage and toStage present", () => {
		const msg = svc.formatMessage(BASE_EVENT);
		expect(msg).toContain("intake");
		expect(msg).toContain("qualified");
	});

	it("uses fallback emoji and title for unknown event", () => {
		const msg = svc.formatMessage({
			tenantId: 1,
			eventType: "mystery_event",
			data: {},
		});
		expect(msg).toContain("🔔");
		expect(msg).toContain("Уведомление");
	});

	it("renders media summary without dumping raw refs json", () => {
		const msg = svc.formatMessage({
			tenantId: 1,
			eventType: "verification_requested",
			conversationId: 55,
			data: {
				displayName: "KYC Client",
				mediaSummary: "1. video_note (7s) · tg-1:vn1",
				mediaRefsJson: '[{"kind":"video_note","externalRef":"vn1"}]',
				action: "Проверить видео.",
			},
		});
		expect(msg).toContain("Материалы");
		expect(msg).toContain("video_note");
		expect(msg).toContain("tg-1:vn1");
		expect(msg).not.toContain("mediaRefsJson");
		expect(msg).not.toContain("externalRef");
	});
});

// ── notify — routing ───────────────────────────────────────────────────────────

describe("NotificationService.notify", () => {
	it("does nothing when botToken is empty", async () => {
		const repo = makeRepo([makeRule()]);
		const svc = new NotificationService(repo, "", "http://app");
		// No error means no attempt to send
		await svc.notify(BASE_EVENT);
	});

	it("sends to rule targetId", async () => {
		const sent: string[] = [];
		const svc = new NotificationService(
			makeRepo([makeRule()]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify(BASE_EVENT);
		expect(sent).toEqual(["group-100"]);
	});

	it("skips rule when condition does not match", async () => {
		const sent: string[] = [];
		const rule = makeRule({
			conditionJson: JSON.stringify({ toStage: "won" }),
		});
		const svc = new NotificationService(
			makeRepo([rule]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify(BASE_EVENT);
		expect(sent).toEqual([]);
	});

	it("sends personal notification when notifyOnAssignedOnly=false", async () => {
		const sent: string[] = [];
		const settings = makeOperatorSettings({ notifyOnAssignedOnly: false });
		const svc = new NotificationService(
			makeRepo([], [settings]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify(BASE_EVENT);
		expect(sent).toContain("chat-10");
	});

	it("sends personal notification when lead is assigned to this admin", async () => {
		const sent: string[] = [];
		const settings = makeOperatorSettings({
			adminId: 10,
			notifyOnAssignedOnly: true,
		});
		const svc = new NotificationService(
			makeRepo([], [settings]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify({ ...BASE_EVENT, assignedAdminId: 10 });
		expect(sent).toContain("chat-10");
	});

	it("skips personal notification when notifyOnAssignedOnly=true and lead assigned to other admin", async () => {
		const sent: string[] = [];
		const settings = makeOperatorSettings({
			adminId: 10,
			notifyOnAssignedOnly: true,
		});
		const svc = new NotificationService(
			makeRepo([], [settings]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify({ ...BASE_EVENT, assignedAdminId: 99 });
		expect(sent).toEqual([]);
	});

	it("sends personal notification when assignedAdminId is undefined (no filter applied)", async () => {
		const sent: string[] = [];
		const settings = makeOperatorSettings({
			adminId: 10,
			notifyOnAssignedOnly: true,
		});
		const svc = new NotificationService(
			makeRepo([], [settings]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify({ ...BASE_EVENT, assignedAdminId: undefined });
		expect(sent).toContain("chat-10");
	});

	it("skips personal notification when telegramChatId is null", async () => {
		const sent: string[] = [];
		const settings = makeOperatorSettings({ telegramChatId: null });
		const svc = new NotificationService(
			makeRepo([], [settings]),
			"fake-token",
			"http://app",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify(BASE_EVENT);
		expect(sent).toEqual([]);
	});

	it("uses template body when available", async () => {
		const texts: string[] = [];
		const repo = makeRepo([makeRule()], [], {
			body: "Новая стадия: {{toStage}}",
		});
		const svc = new NotificationService(repo, "fake-token", "http://app");
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ text }) => texts.push(text));
		await svc.notify(BASE_EVENT);
		expect(texts[0]).toBe("Новая стадия: qualified");
	});

	it("operator handoff notification includes reactive operator buttons", async () => {
		const sent: SendMessageInput[] = [];
		const svc = new NotificationService(
			makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
			"fake-token",
			"https://app.example",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient((input) => sent.push(input));

		await svc.notify({
			tenantId: 1,
			eventType: "operator_handoff_required",
			conversationId: 109,
			contactId: 7,
			data: {
				displayName: "Сергей",
				reason: "kyc_review",
				title: "Проверить KYC клиента",
				action: "Проверить документы и видео.",
			},
		});

		const markup = sent[0]?.replyMarkup;
		expect(JSON.stringify(markup)).toContain("op:v1:open_chat:1:109");
		expect(JSON.stringify(markup)).toContain("op:v1:takeover:1:109");
		expect(JSON.stringify(markup)).toContain("op:v1:return_ai:1:109");
		expect(JSON.stringify(markup)).toContain("opx:kycok:109");
		expect(JSON.stringify(markup)).toContain("opx:kycmore:109");
		expect(JSON.stringify(markup)).toContain("opx:kycno:109");
	});

	it("payment handoff notification includes payment quick actions", async () => {
		const sent: SendMessageInput[] = [];
		const svc = new NotificationService(
			makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
			"fake-token",
			"https://app.example",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient((input) => sent.push(input));

		await svc.notify({
			tenantId: 1,
			eventType: "operator_handoff_required",
			conversationId: 110,
			contactId: 8,
			data: {
				displayName: "Анна",
				reason: "payment_review",
				title: "Проверить оплату",
				action: "Проверить чек.",
				orderId: 77,
			},
		});

		const markup = JSON.stringify(sent[0]?.replyMarkup);
		expect(markup).toContain("opx:payok:110:77");
		expect(markup).toContain("opx:paywait:110:77");
		expect(markup).toContain("opx:paybad:110:77");
	});

	it("office payout handoff notification includes office confirmation quick actions", async () => {
		const sent: SendMessageInput[] = [];
		const svc = new NotificationService(
			makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
			"fake-token",
			"https://app.example",
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient((input) => sent.push(input));

		await svc.notify({
			tenantId: 1,
			eventType: "operator_handoff_required",
			conversationId: 111,
			contactId: 9,
			data: {
				displayName: "Игорь",
				reason: "office_payout",
				title: "Подтвердить выдачу в офисе",
				action: "Подтвердить офис и время.",
				orderId: 78,
			},
		});

		const markup = JSON.stringify(sent[0]?.replyMarkup);
		expect(markup).toContain("opx:office:111:78");
		expect(markup).toContain("opx:payout:111:78");
	});

	it("with informer: skips owner in per-operator loop, still notifies other operators + calls informer", async () => {
		const sent: string[] = [];
		let emitted = 0;
		const owner = makeOperatorSettings({
			adminId: 10,
			telegramChatId: "owner-chat",
			notifyOnAssignedOnly: false,
		});
		const other = makeOperatorSettings({
			adminId: 11,
			telegramChatId: "other-chat",
			notifyOnAssignedOnly: false,
		});
		const informer = {
			resolveOwnerAdminId: async () => 10,
			emitNotificationEvent: async () => {
				emitted++;
			},
		} as unknown as AdminInformer;
		const svc = new NotificationService(
			makeRepo([], [owner, other]),
			"fake-token",
			"http://app",
			informer,
		);
		// @ts-expect-error patch private client
		svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
		await svc.notify(BASE_EVENT);
		expect(emitted).toBe(1); // владелец обслужен информером
		expect(sent).toContain("other-chat"); // не-владельцу шлём как раньше
		expect(sent).not.toContain("owner-chat"); // владельца пропустили (без дублей)
	});
});
