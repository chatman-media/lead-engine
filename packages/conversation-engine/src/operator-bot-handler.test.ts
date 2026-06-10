import { describe, expect, it } from "bun:test";
import type { TgUpdate } from "@chatman-media/channel-telegram";
import {
	auditLog,
	channelIdentities,
	channels,
	contacts,
	conversations,
	exchangeOrders,
	messages,
	operatorActionDrafts,
	outboundQueue,
} from "@chatman-media/storage";
import type {
	AdminNotificationRow,
	NotificationsRepo,
	OperatorSettings,
} from "./dal/notifications.ts";
import {
	parseOperatorActionCallback,
	parseOperatorExchangeActionCallback,
	parseOperatorPreviewCallback,
} from "./operator-bot-actions.ts";
import {
	OperatorBotHandler,
	parseMuteSeconds,
} from "./operator-bot-handler.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeSettings(
	overrides: Partial<OperatorSettings> = {},
): OperatorSettings {
	return {
		id: 1,
		adminId: 10,
		tenantId: 1,
		telegramChatId: null,
		linkToken: null,
		linkTokenExpiresAt: null,
		notifyOnAssignedOnly: true,
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

type FakeReplyMarkup = {
	inline_keyboard?: Array<
		Array<{ text?: string; callback_data?: string; url?: string }>
	>;
};

type FakeRecentNotification = {
	id: number;
	severity: string;
	title: string;
	body: string;
	createdAt: number;
} & Partial<AdminNotificationRow>;

class FakeRepo implements Partial<NotificationsRepo> {
	linked: Array<{ adminId: number; chatId: string }> = [];
	prefs: Array<{ adminId: number } & Record<string, unknown>> = [];
	recent: FakeRecentNotification[] = [];
	private settings: OperatorSettings[];

	constructor(settings?: OperatorSettings | OperatorSettings[]) {
		this.settings = settings
			? Array.isArray(settings)
				? settings
				: [settings]
			: [];
	}

	setSettings(settings?: OperatorSettings | OperatorSettings[]) {
		this.settings = settings
			? Array.isArray(settings)
				? settings
				: [settings]
			: [];
	}

	async findByLinkToken(_token: string) {
		return this.settings[0];
	}
	async linkChat(adminId: number, chatId: string) {
		this.linked.push({ adminId, chatId });
	}
	async findOperatorSettings(adminId: number) {
		return this.settings.find((item) => item.adminId === adminId);
	}
	async upsertOperatorSettings(
		_s: Parameters<NotificationsRepo["upsertOperatorSettings"]>[0],
	) {}
	async findOperatorSettingsByChatId(chatId: string) {
		return (
			this.settings.find((item) => item.telegramChatId === chatId) ??
			(this.settings.length === 1 && !this.settings[0]?.telegramChatId
				? this.settings[0]
				: undefined)
		);
	}
	async updateInformerPrefs(adminId: number, p: Record<string, unknown>) {
		this.prefs.push({ adminId, ...p });
	}
	async listRecentNotifications() {
		return this.recent.map(
			(row): AdminNotificationRow => ({
				tenantId: 1,
				adminId: null,
				topic: "system",
				kind: "test",
				dedupKey: `fake-${row.id}`,
				targetChatId: null,
				deliveredAt: null,
				digestBatchId: null,
				readAt: null,
				...row,
			}),
		);
	}
}

class FakeClient {
	sent: Array<{ chatId: string; text: string; replyMarkup?: FakeReplyMarkup }> =
		[];
	edits: Array<{ messageId: number; text: string }> = [];
	answered: Array<{
		callbackQueryId: string;
		text?: string;
		showAlert?: boolean;
		url?: string;
	}> = [];
	async sendMessage(opts: {
		chatId: string;
		text: string;
		replyMarkup?: FakeReplyMarkup;
	}) {
		this.sent.push(opts);
	}
	async editMessageText(opts: { messageId: number; text: string }) {
		this.edits.push(opts);
	}
	async answerCallbackQuery(opts: {
		callbackQueryId: string;
		text?: string;
		showAlert?: boolean;
		url?: string;
	}) {
		this.answered.push(opts);
	}
}

function makeUpdate(text: string, chatId = 1000, isGroup = false): TgUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: 0,
			chat: {
				id: isGroup ? -chatId : chatId,
				type: isGroup ? "group" : "private",
				title: isGroup ? "Test Group" : undefined,
			},
			from: { id: 5, is_bot: false, first_name: "User" },
			text,
		},
	} as TgUpdate;
}

function makeSendDraftDb(
	opts: {
		contactAttributesJson?: string | null;
		order?: {
			id: number;
			status: string;
			verificationId: string | null;
			payoutCode: string | null;
			payoutCodeExpiresAt: number | null;
		};
		conversationId?: number;
		contactId?: number;
		draftStatus?: "pending" | "sent" | "cancelled" | "expired" | "failed";
	} = {},
) {
	let contactAttributesJson = opts.contactAttributesJson ?? null;
	let draftStatus = opts.draftStatus ?? "pending";
	const order = opts.order ? { ...opts.order } : null;
	const conversationId = opts.conversationId ?? 109;
	const contactId = opts.contactId ?? 55;
	const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
	const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
	const audits: Array<Record<string, unknown>> = [];

	function tableName(table: unknown): string {
		if (table === contacts) return "contacts";
		if (table === conversations) return "conversations";
		if (table === channelIdentities) return "channel_identities";
		if (table === exchangeOrders) return "exchange_orders";
		if (table === operatorActionDrafts) return "operator_action_drafts";
		if (table === messages) return "messages";
		if (table === outboundQueue) return "outbound_queue";
		if (table === auditLog) return "audit_log";
		if (table === channels) return "channels";
		return "unknown";
	}

	const tx = {
		execute: async () => {},
		select: () => ({
			from: (table: unknown) => {
				if (table === conversations) {
					return {
						where: () => ({
							limit: async () => [{ id: conversationId, contactId }],
						}),
					};
				}
				if (table === channelIdentities) {
					return {
						innerJoin: () => ({
							where: () => ({
								orderBy: () => ({
									limit: async () => [
										{
											channelDbId: 3,
											channelKind: "telegram_bot",
											externalUserId: "client-telegram-id",
										},
									],
								}),
							}),
						}),
					};
				}
				if (table === contacts) {
					return {
						where: () => ({
							limit: async () => [{ attributesJson: contactAttributesJson }],
						}),
					};
				}
				if (table === exchangeOrders) {
					const rows = async () => (order ? [order] : []);
					return {
						where: () => ({
							limit: rows,
							orderBy: () => ({ limit: rows }),
						}),
					};
				}
				return {
					where: () => ({
						limit: async () => [],
					}),
				};
			},
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => {
				updates.push({ table: tableName(table), values });
				if (table === contacts && typeof values.attributesJson === "string") {
					contactAttributesJson = values.attributesJson;
				}
				if (table === exchangeOrders && order) {
					Object.assign(order, values);
				}
				return {
					where: () => ({
						returning: async () => {
							if (table === operatorActionDrafts && values.status === "sent") {
								if (draftStatus !== "pending") return [];
								draftStatus = "sent";
								return [{ id: 700 }];
							}
							return [];
						},
					}),
				};
			},
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				inserts.push({ table: tableName(table), values });
				if (table === auditLog) audits.push(values);
				return {
					returning: async () => {
						if (table === messages) return [{ id: 501 }];
						if (table === outboundQueue) return [{ id: 601 }];
						return [];
					},
				};
			},
		}),
	};
	const db = {
		transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
	};
	return {
		audits,
		db,
		inserts,
		order,
		updates,
		draftStatus: () => draftStatus,
		contactAttributes: () =>
			JSON.parse(contactAttributesJson ?? "{}") as Record<string, unknown>,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("OperatorBotHandler", () => {
	it("does nothing when botToken is empty", async () => {
		const repo = new FakeRepo();
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"",
		);
		await handler.handleUpdate(makeUpdate("/start abc"));
		expect(repo.linked).toEqual([]);
	});

	it("does nothing when update has no message", async () => {
		const repo = new FakeRepo();
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;
		await handler.handleUpdate({ update_id: 1 } as TgUpdate);
		expect(client.sent).toEqual([]);
	});

	describe("/start <token>", () => {
		it("links chatId when token is valid", async () => {
			const settings = makeSettings({ adminId: 10 });
			const repo = new FakeRepo(settings);
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
			);
			const client = new FakeClient();
			// @ts-expect-error patch private
			handler.client = client;

			await handler.handleUpdate(makeUpdate("/start valid-token", 777));

			expect(repo.linked).toEqual([{ adminId: 10, chatId: "777" }]);
			expect(client.sent[0]?.text).toContain("✅");
		});

		it("replies with error when token not found", async () => {
			const repo = new FakeRepo(undefined); // token resolves to undefined
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
			);
			const client = new FakeClient();
			// @ts-expect-error patch private
			handler.client = client;

			await handler.handleUpdate(makeUpdate("/start bad-token", 777));

			expect(repo.linked).toEqual([]);
			expect(client.sent[0]?.text).toContain("❌");
		});
	});

	describe("/start without token", () => {
		it("replies with greeting", async () => {
			const repo = new FakeRepo();
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
			);
			const client = new FakeClient();
			// @ts-expect-error patch private
			handler.client = client;

			await handler.handleUpdate(makeUpdate("/start", 777));

			expect(client.sent[0]?.text).toContain("Привет");
		});
	});

	describe("/setup", () => {
		it("rejects setup in private chat", async () => {
			const repo = new FakeRepo();
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
			);
			const client = new FakeClient();
			// @ts-expect-error patch private
			handler.client = client;

			await handler.handleUpdate(makeUpdate("/setup", 777, false));

			expect(client.sent[0]?.text).toContain(
				"/setup работает только в группах",
			);
		});

		it("replies with group ID in group chat", async () => {
			const repo = new FakeRepo();
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
			);
			const client = new FakeClient();
			// @ts-expect-error patch private
			handler.client = client;

			await handler.handleUpdate(makeUpdate("/setup", 500, true));

			const reply = client.sent[0];
			expect(reply?.text).toContain("-500");
		});
	});
});

describe("parseMuteSeconds", () => {
	it("единицы m/h/d", () => {
		expect(parseMuteSeconds("30m")).toBe(1800);
		expect(parseMuteSeconds("2h")).toBe(7200);
		expect(parseMuteSeconds("1d")).toBe(86400);
	});
	it("off/0/пусто → 0 (снять мут)", () => {
		expect(parseMuteSeconds("off")).toBe(0);
		expect(parseMuteSeconds("0")).toBe(0);
		expect(parseMuteSeconds("")).toBe(0);
	});
	it("мусор → null", () => {
		expect(parseMuteSeconds("soon")).toBeNull();
		expect(parseMuteSeconds("5x")).toBeNull();
	});
});

describe("operator action callbacks", () => {
	it("parses short operator callback payloads", () => {
		expect(parseOperatorActionCallback("op:take:109")).toEqual({
			action: "takeover",
			conversationId: 109,
		});
		expect(parseOperatorActionCallback("op:ai:109")).toEqual({
			action: "return_ai",
			conversationId: 109,
		});
		expect(parseOperatorActionCallback("op:take:not-a-number")).toBeNull();
		expect(parseOperatorActionCallback("lvl:all")).toBeNull();
		expect(parseOperatorPreviewCallback("opm:s:abc123")).toEqual({
			action: "send",
			draftId: "abc123",
		});
		expect(parseOperatorPreviewCallback("opm:c:abc123")).toEqual({
			action: "cancel",
			draftId: "abc123",
		});
		expect(parseOperatorExchangeActionCallback("opx:payok:109")).toEqual({
			action: "payment_confirmed",
			conversationId: 109,
		});
		expect(parseOperatorExchangeActionCallback("opx:payok:109:77")).toEqual({
			action: "payment_confirmed",
			conversationId: 109,
			orderId: 77,
		});
		expect(parseOperatorExchangeActionCallback("opx:kycmore:109")).toEqual({
			action: "kyc_request_materials",
			conversationId: 109,
		});
		expect(parseOperatorExchangeActionCallback("opx:payok:nope")).toBeNull();
		expect(
			parseOperatorExchangeActionCallback("opx:payok:109:nope"),
		).toBeNull();
	});

	it("callback op:take moves the conversation to human mode", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const writes: Array<Record<string, unknown>> = [];
		const audits: Array<Record<string, unknown>> = [];
		let mode = "ai";
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ mode }],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					writes.push(values);
					if (typeof values.mode === "string") mode = values.mode;
					return { where: async () => [] };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					audits.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 5,
			callback_query: {
				id: "cb-op",
				from: { id: 5 },
				data: "op:take:109",
				message: {
					message_id: 9,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(mode).toBe("human");
		expect(writes[0]).toMatchObject({
			mode: "human",
			assignedAdminId: 10,
			unreadCount: 0,
			lastMessageAt: 123,
		});
		expect(audits[0]).toMatchObject({
			tenantId: 3,
			adminId: 10,
			action: "conversation.mode.takeover.operator_bot",
			targetKind: "conversation",
			targetId: "109",
		});
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-op",
			text: "Взято в работу",
		});
		expect(client.sent[0]?.text).toContain("Взято в работу");
		expect(JSON.stringify(client.sent[0]?.replyMarkup)).toContain(
			"https://app.example/conversations/109",
		);

		await handler.handleUpdate({
			update_id: 6,
			callback_query: {
				id: "cb-op-again",
				from: { id: 5 },
				data: "op:take:109",
				message: {
					message_id: 10,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(writes).toHaveLength(1);
		expect(audits).toHaveLength(1);
		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-op-again",
			text: "Уже актуально",
		});
		expect(client.sent.at(-1)?.text).toContain("уже в работе оператора");
	});

	it("tenant-scoped operator callbacks reject mismatched tenant before db writes", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		let transactionCalls = 0;
		const db = {
			transaction: async () => {
				transactionCalls++;
				throw new Error("db should not be touched for wrong tenant callback");
			},
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 6,
			callback_query: {
				id: "cb-wrong-tenant",
				from: { id: 5 },
				data: "op:v1:takeover:99:109",
				message: {
					message_id: 10,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(transactionCalls).toBe(0);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-wrong-tenant",
			text: "Нет доступа к этому чату",
			showAlert: true,
		});
		expect(client.sent).toHaveLength(0);
	});

	it("return_ai callback is idempotent when conversation is already in AI mode", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const writes: Array<Record<string, unknown>> = [];
		const audits: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ mode: "ai" }],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					writes.push(values);
					return { where: async () => [] };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					audits.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 7,
			callback_query: {
				id: "cb-ai-noop",
				from: { id: 5 },
				data: "op:v1:return_ai:3:109",
				message: {
					message_id: 11,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(writes).toHaveLength(0);
		expect(audits).toHaveLength(0);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-ai-noop",
			text: "Уже актуально",
		});
		expect(client.sent[0]?.text).toContain("уже под управлением AI");
	});

	it("callback with mismatched tenant payload is rejected before db writes", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const writes: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ mode: "ai" }],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					writes.push(values);
					return { where: async () => [] };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					writes.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{ db: db as never },
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 6,
			callback_query: {
				id: "cb-wrong-tenant",
				from: { id: 5 },
				data: "op:v1:takeover:999:109",
				message: {
					message_id: 10,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(writes).toEqual([]);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-wrong-tenant",
			text: "Нет доступа к этому чату",
			showAlert: true,
		});
		expect(client.sent).toEqual([]);
	});

	it("repeated takeover callback is a noop without duplicate audit", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const updates: Array<Record<string, unknown>> = [];
		const audits: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ mode: "human" }],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					return { where: async () => [] };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					audits.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 7,
			callback_query: {
				id: "cb-noop",
				from: { id: 5 },
				data: "op:take:109",
				message: {
					message_id: 11,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(updates).toEqual([]);
		expect(audits).toEqual([]);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-noop",
			text: "Уже актуально",
		});
		expect(client.sent[0]?.text).toContain("уже в работе оператора");
	});

	it("repeated return-AI callback is a noop without duplicate audit", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const updates: Array<Record<string, unknown>> = [];
		const audits: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ mode: "ai" }],
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					return { where: async () => [] };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					audits.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 8,
			callback_query: {
				id: "cb-return-ai-noop",
				from: { id: 5 },
				data: "op:ai:109",
				message: {
					message_id: 12,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(updates).toEqual([]);
		expect(audits).toEqual([]);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-return-ai-noop",
			text: "Уже актуально",
		});
		expect(client.sent[0]?.text).toContain("уже под управлением AI");
	});

	it("reply to an action card creates preview and send confirmation enqueues client message", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const inserts: Array<Record<string, unknown>> = [];
		const updates: Array<Record<string, unknown>> = [];
		const draftRows: Array<Record<string, unknown>> = [];
		let insertIndex = 0;
		const tx = {
			execute: async () => {},
			select: (fields?: Record<string, unknown>) => ({
				from: () => ({
					where: () => ({
						limit: async () => {
							if (fields && "draftKey" in fields) return draftRows;
							return [{ id: 109, contactId: 55 }];
						},
					}),
					innerJoin: () => ({
						where: () => ({
							orderBy: () => ({
								limit: async () => [
									{
										channelDbId: 3,
										channelKind: "telegram_bot",
										externalUserId: "client-telegram-id",
									},
								],
							}),
						}),
					}),
				}),
			}),
			insert: () => {
				const current = insertIndex++;
				return {
					values: (values: Record<string, unknown>) => {
						inserts.push({ current, ...values });
						if (typeof values.draftKey === "string") {
							draftRows[0] = {
								id: 700,
								...values,
								draftKey: values.draftKey,
							};
						}
						return { returning: async () => [{ id: 501 }] };
					},
				};
			},
			update: () => ({
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					if (typeof values.status === "string" && draftRows[0]) {
						draftRows[0] = { ...draftRows[0], ...values };
					}
					return {
						where: () => ({
							returning: async () => [{ id: draftRows[0]?.id ?? 700 }],
						}),
					};
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				appUrl: "https://app.example",
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 6,
			message: {
				message_id: 20,
				date: 0,
				chat: { id: 777, type: "private" },
				from: { id: 5, is_bot: false, first_name: "Operator" },
				text: "Проверка пройдена, можете оплатить по реквизитам.",
				reply_to_message: {
					message_id: 9,
					date: 0,
					chat: { id: 777, type: "private" },
					text: "Нужно действие оператора",
					reply_markup: {
						inline_keyboard: [
							[{ text: "Взять", callback_data: "op:take:109" }],
						],
					},
				},
			},
		} as unknown as TgUpdate);

		expect(client.sent[0]?.text).toContain("Preview сообщения клиенту");
		expect(client.sent[0]?.text).toContain("Проверка пройдена");
		const sendCallback = client.sent[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]
			?.callback_data as string;
		expect(sendCallback).toMatch(/^opm:s:/);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatchObject({
			tenantId: 3,
			adminId: 10,
			conversationId: 109,
			status: "pending",
			text: "Проверка пройдена, можете оплатить по реквизитам.",
			expiresAt: 723,
		});

		await handler.handleUpdate({
			update_id: 7,
			callback_query: {
				id: "cb-send",
				from: { id: 5 },
				data: sendCallback,
				message: {
					message_id: 21,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(inserts[1]).toMatchObject({
			tenantId: 3,
			conversationId: 109,
			role: "human",
			text: "Проверка пройдена, можете оплатить по реквизитам.",
		});
		expect(JSON.stringify(inserts[2])).toContain("client-telegram-id");
		expect(JSON.stringify(inserts[2])).toContain("operator-bot-reply-");
		expect(inserts[3]).toMatchObject({
			tenantId: 3,
			adminId: 10,
			action: "conversation.reply.operator_bot",
			targetId: "109",
		});
		expect(updates.some((row) => row.status === "sent")).toBe(true);
		expect(updates.some((row) => row.messageId === 501)).toBe(true);
		expect(updates.at(-1)).toMatchObject({
			mode: "human",
			assignedAdminId: 10,
			lastMessageAt: 123,
		});
		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-send",
			text: "Отправлено клиенту",
		});
		expect(client.sent.at(-1)?.text).toContain("Отправлено клиенту");

		const insertsAfterFirstConfirm = inserts.length;
		await handler.handleUpdate({
			update_id: 8,
			callback_query: {
				id: "cb-send-again",
				from: { id: 5 },
				data: sendCallback,
				message: {
					message_id: 22,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(inserts).toHaveLength(insertsAfterFirstConfirm);
		expect(updates.filter((row) => row.status === "sent")).toHaveLength(1);
		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-send-again",
			text: "Preview истёк или уже обработан",
			showAlert: true,
		});
	});

	it("durable preview send is scoped to original admin and chat", async () => {
		const repo = new FakeRepo([
			makeSettings({
				adminId: 10,
				tenantId: 3,
				telegramChatId: "777",
			}),
			makeSettings({
				adminId: 20,
				tenantId: 3,
				telegramChatId: "888",
			}),
		]);
		const writes: Array<Record<string, unknown>> = [];
		const draftRow = {
			id: 700,
			tenantId: 3,
			adminId: 10,
			conversationId: 109,
			draftKey: "abc123",
			chatId: "777",
			status: "pending",
			text: "Не должен уйти клиенту",
			metadataJson: "{}",
			createdAt: 123,
			expiresAt: 723,
		};
		const tx = {
			execute: async () => {},
			select: () => ({
				from: (table: unknown) => {
					if (table === operatorActionDrafts) {
						return {
							where: () => ({
								limit: async () => [draftRow],
							}),
						};
					}
					return {
						where: () => ({
							limit: async () => [],
						}),
					};
				},
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					writes.push(values);
					return { where: () => ({ returning: async () => [] }) };
				},
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					writes.push(values);
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 9,
			callback_query: {
				id: "cb-cross-admin-send",
				from: { id: 5 },
				data: "opm:s:abc123",
				message: {
					message_id: 23,
					date: 0,
					chat: { id: 888, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(writes).toEqual([]);
		expect(client.answered[0]).toMatchObject({
			callbackQueryId: "cb-cross-admin-send",
			text: "Preview истёк или уже обработан",
			showAlert: true,
		});
		expect(client.sent).toEqual([]);
	});

	it("reply preview can be cancelled without sending to client", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{ nowEpoch: () => 123 },
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 8,
			message: {
				message_id: 20,
				date: 0,
				chat: { id: 777, type: "private" },
				from: { id: 5, is_bot: false, first_name: "Operator" },
				text: "Не отправлять.",
				reply_to_message: {
					message_id: 9,
					date: 0,
					chat: { id: 777, type: "private" },
					reply_markup: {
						inline_keyboard: [
							[{ text: "Взять", callback_data: "op:take:109" }],
						],
					},
				},
			},
		} as unknown as TgUpdate);
		const cancelCallback = client.sent[0]?.replyMarkup
			?.inline_keyboard?.[1]?.[0]?.callback_data as string;
		expect(cancelCallback).toMatch(/^opm:c:/);

		await handler.handleUpdate({
			update_id: 9,
			callback_query: {
				id: "cb-cancel",
				from: { id: 5 },
				data: cancelCallback,
				message: {
					message_id: 21,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-cancel",
			text: "Отменено",
		});
		expect(client.sent.at(-1)?.text).toContain("ничего не отправлено");
	});

	it("preview confirm is scoped to the original operator chat and admin", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{ nowEpoch: () => 123 },
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 10,
			message: {
				message_id: 20,
				date: 0,
				chat: { id: 777, type: "private" },
				from: { id: 5, is_bot: false, first_name: "Operator" },
				text: "Ответить клиенту.",
				reply_to_message: {
					message_id: 9,
					date: 0,
					chat: { id: 777, type: "private" },
					reply_markup: {
						inline_keyboard: [
							[{ text: "Взять", callback_data: "op:take:109" }],
						],
					},
				},
			},
		} as unknown as TgUpdate);
		const sendCallback = client.sent[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]
			?.callback_data as string;

		await handler.handleUpdate({
			update_id: 11,
			callback_query: {
				id: "cb-wrong-chat",
				from: { id: 5 },
				data: sendCallback,
				message: {
					message_id: 21,
					date: 0,
					chat: { id: 888, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-wrong-chat",
			text: "Preview истёк или уже обработан",
			showAlert: true,
		});
		expect(client.sent).toHaveLength(1);

		repo.setSettings(
			makeSettings({
				adminId: 11,
				tenantId: 3,
				telegramChatId: "777",
			}),
		);
		await handler.handleUpdate({
			update_id: 12,
			callback_query: {
				id: "cb-wrong-admin",
				from: { id: 5 },
				data: sendCallback,
				message: {
					message_id: 22,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-wrong-admin",
			text: "Preview истёк или уже обработан",
			showAlert: true,
		});
		expect(client.sent).toHaveLength(1);
	});

	it("expired preview confirm fails safely and sends nothing", async () => {
		let now = 123;
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{ nowEpoch: () => now },
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 13,
			message: {
				message_id: 20,
				date: 0,
				chat: { id: 777, type: "private" },
				from: { id: 5, is_bot: false, first_name: "Operator" },
				text: "Истекающий preview.",
				reply_to_message: {
					message_id: 9,
					date: 0,
					chat: { id: 777, type: "private" },
					reply_markup: {
						inline_keyboard: [
							[{ text: "Взять", callback_data: "op:take:109" }],
						],
					},
				},
			},
		} as unknown as TgUpdate);
		const sendCallback = client.sent[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]
			?.callback_data as string;
		now = 723;

		await handler.handleUpdate({
			update_id: 14,
			callback_query: {
				id: "cb-expired",
				from: { id: 5 },
				data: sendCallback,
				message: {
					message_id: 21,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-expired",
			text: "Preview истёк или уже обработан",
			showAlert: true,
		});
		expect(client.sent).toHaveLength(1);
	});

	it("durable draft double confirm sends only one client message and outbound entry", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const { db, draftStatus, inserts } = makeSendDraftDb();
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);
		const draft = {
			draftId: "abc123",
			dbId: 700,
			tenantId: 3,
			adminId: 10,
			chatId: "777",
			conversationId: 109,
			text: "Отправить один раз.",
			metadata: { source: "telegram_reply_preview" },
			createdAt: 123,
			expiresAt: 723,
		};

		// @ts-expect-error private method
		const first = await handler.sendDraftToClient(draft);
		// @ts-expect-error private method
		const second = await handler.sendDraftToClient(draft);

		expect(first.kind).toBe("sent");
		expect(second.kind).toBe("already_handled");
		expect(draftStatus()).toBe("sent");
		expect(inserts.filter((row) => row.table === "messages")).toHaveLength(1);
		expect(
			inserts.filter((row) => row.table === "outbound_queue"),
		).toHaveLength(1);
		expect(inserts.filter((row) => row.table === "audit_log")).toHaveLength(1);
	});

	it("exchange quick action creates a send/cancel preview draft", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{ nowEpoch: () => 123 },
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 10,
			callback_query: {
				id: "cb-exchange",
				from: { id: 5 },
				data: "opx:payok:109:77",
				message: {
					message_id: 22,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-exchange",
			text: "Preview готов",
		});
		expect(client.sent.at(-1)?.text).toContain("Оплата подтверждена");
		expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
		expect(
			client.sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text,
		).toBe("Отправить клиенту");
		expect(
			client.sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data,
		).toMatch(/^opm:s:/);
	});

	it("exchange quick action with db blocks inaccessible conversations before preview", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const drafts: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [],
					}),
				}),
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					drafts.push(values);
					return { returning: async () => [{ id: 700 }] };
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 11,
			callback_query: {
				id: "cb-exchange-missing-conversation",
				from: { id: 5 },
				data: "opx:payok:999:77",
				message: {
					message_id: 23,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(drafts).toEqual([]);
		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-exchange-missing-conversation",
			text: "Диалог не найден",
			showAlert: true,
		});
		expect(client.sent).toEqual([]);
	});

	it("exchange quick action persists order-scoped draft metadata when db is configured", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const drafts: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: (table: unknown) => {
					if (table === exchangeOrders) {
						return {
							where: () => ({
								limit: async () => [{ id: 77 }],
							}),
						};
					}
					return {
						where: () => ({
							limit: async () => [{ id: 109 }],
						}),
					};
				},
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					drafts.push(values);
					return { returning: async () => [{ id: 700 }] };
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 11,
			callback_query: {
				id: "cb-exchange-db",
				from: { id: 5 },
				data: "opx:payok:109:77",
				message: {
					message_id: 23,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(drafts[0]).toMatchObject({
			tenantId: 3,
			adminId: 10,
			conversationId: 109,
			status: "pending",
			expiresAt: 723,
		});
		expect(JSON.parse(String(drafts[0]?.metadataJson))).toMatchObject({
			source: "operator_bot_exchange_action",
			exchangeAction: "payment_confirmed",
			orderId: 77,
		});
		expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
	});

	it("payout quick action generates order-scoped payout code preview", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const drafts: Array<Record<string, unknown>> = [];
		const tx = {
			execute: async () => {},
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{
								id: 77,
								status: "paid",
								payoutCode: null,
								payoutCodeExpiresAt: null,
								payoutLocation: "Phuket Old Town",
								payoutMethod: "office_cash",
							},
						],
					}),
				}),
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					drafts.push(values);
					return { returning: async () => [{ id: 701 }] };
				},
			}),
		};
		const db = {
			transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
		};
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;

		await handler.handleUpdate({
			update_id: 12,
			callback_query: {
				id: "cb-payout",
				from: { id: 5 },
				data: "opx:payout:109:77",
				message: {
					message_id: 24,
					date: 0,
					chat: { id: 777, type: "private" },
				},
			},
		} as unknown as TgUpdate);

		expect(client.answered.at(-1)).toMatchObject({
			callbackQueryId: "cb-payout",
			text: "Preview готов",
		});
		expect(drafts[0]?.text).toContain("Код выдачи");
		expect(String(drafts[0]?.text)).toContain("Phuket Old Town");
		const metadata = JSON.parse(String(drafts[0]?.metadataJson));
		expect(metadata).toMatchObject({
			source: "operator_bot_exchange_action",
			exchangeAction: "payout_ready",
			orderId: 77,
			payoutCodeExpiresAt: 3723,
			payoutCodeGenerated: true,
		});
		expect(String(metadata.payoutCode)).toMatch(/^CODE-77-[A-Z0-9]{6}$/);
		expect(client.sent.at(-1)?.text).toContain("Код выдачи");
		expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
	});

	it("confirmed KYC OK preview persists verified contact state", async () => {
		const settings = makeSettings({
			adminId: 10,
			tenantId: 3,
			telegramChatId: "777",
		});
		const repo = new FakeRepo(settings);
		const { audits, db, order, contactAttributes } = makeSendDraftDb({
			contactAttributesJson: JSON.stringify({
				city: "Bangkok",
				exchangeKyc: { status: "pending" },
			}),
			order: {
				id: 77,
				status: "quote",
				verificationId: null,
				payoutCode: null,
				payoutCodeExpiresAt: null,
			},
		});
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
			{
				db: db as never,
				nowEpoch: () => 123,
			},
		);

		// @ts-expect-error private method
		const result = await handler.sendDraftToClient({
			draftId: "abc123",
			dbId: 700,
			tenantId: 3,
			adminId: 10,
			chatId: "777",
			conversationId: 109,
			text: "✅ Верификация пройдена.",
			metadata: {
				source: "operator_bot_exchange_action",
				exchangeAction: "kyc_approved",
				orderId: 77,
			},
			createdAt: 123,
			expiresAt: 723,
		});

		expect(result.kind).toBe("sent");
		const attrs = contactAttributes();
		expect(attrs.city).toBe("Bangkok");
		expect(attrs.isVerified).toBe(true);
		expect(attrs.exchangeKyc).toMatchObject({
			status: "verified",
			verified: true,
			needsVerification: false,
			reviewedByAdminId: 10,
			reviewedAt: 123,
			source: "operator_bot",
		});
		const kyc = attrs.exchangeKyc as Record<string, unknown>;
		expect(String(kyc.verificationId)).toBe("operator-bot-109-123");
		expect(order?.verificationId).toBe("operator-bot-109-123");

		const details = JSON.parse(String(audits[0]?.detailsJson)) as Record<
			string,
			unknown
		>;
		expect(details.exchangeSideEffects).toMatchObject({
			action: "kyc_approved",
			contactId: 55,
			status: "verified",
			verified: true,
			orderId: 77,
			orderVerificationPatched: true,
		});
	});

	it("confirmed KYC non-approval previews keep contact unverified", async () => {
		for (const [action, expectedStatus] of [
			["kyc_request_materials", "materials_requested"],
			["kyc_rejected", "rejected"],
		] as const) {
			const settings = makeSettings({
				adminId: 10,
				tenantId: 3,
				telegramChatId: "777",
			});
			const repo = new FakeRepo(settings);
			const { db, order, contactAttributes } = makeSendDraftDb({
				contactAttributesJson: JSON.stringify({
					city: "Phuket",
					isVerified: true,
					exchangeKyc: {
						status: "verified",
						verificationId: "old-verification",
					},
				}),
				order: {
					id: 77,
					status: "awaiting_payment",
					verificationId: "old-verification",
					payoutCode: null,
					payoutCodeExpiresAt: null,
				},
			});
			const handler = new OperatorBotHandler(
				repo as unknown as NotificationsRepo,
				"token",
				{
					db: db as never,
					nowEpoch: () => 123,
				},
			);

			// @ts-expect-error private method
			const result = await handler.sendDraftToClient({
				draftId: `${action.replaceAll("_", "")}1`,
				dbId: 700,
				tenantId: 3,
				adminId: 10,
				chatId: "777",
				conversationId: 109,
				text: "KYC decision",
				metadata: {
					source: "operator_bot_exchange_action",
					exchangeAction: action,
					orderId: 77,
				},
				createdAt: 123,
				expiresAt: 723,
			});

			expect(result.kind).toBe("sent");
			const attrs = contactAttributes();
			expect(attrs.city).toBe("Phuket");
			expect(attrs.isVerified).toBe(false);
			expect(attrs.verificationStatus).toBe(expectedStatus);
			expect(attrs.kycStatus).toBe(expectedStatus);
			expect(attrs.exchangeKyc).toMatchObject({
				status: expectedStatus,
				verified: false,
				needsVerification: true,
				verificationId: null,
				reviewedByAdminId: 10,
				source: "operator_bot",
			});
			expect(order?.verificationId).toBeNull();
		}
	});
});

describe("informer commands", () => {
	function wire(settings?: OperatorSettings) {
		const repo = new FakeRepo(settings);
		const handler = new OperatorBotHandler(
			repo as unknown as NotificationsRepo,
			"token",
		);
		const client = new FakeClient();
		// @ts-expect-error patch private
		handler.client = client;
		return { repo, handler, client };
	}

	it("/level показывает клавиатуру с текущим уровнем", async () => {
		const { handler, client } = wire(
			makeSettings({ telegramChatId: "777", informerLevel: "important" }),
		);
		await handler.handleUpdate(makeUpdate("/level", 777));
		const msg = client.sent[0];
		expect(msg?.replyMarkup?.inline_keyboard?.length).toBe(4);
		const flat = JSON.stringify(msg?.replyMarkup);
		expect(flat).toContain("lvl:important");
		expect(flat).toContain("• "); // текущий помечен
	});

	it("/mute 2h пишет informerMutedUntil", async () => {
		const { repo, handler } = wire(
			makeSettings({ telegramChatId: "777", adminId: 10 }),
		);
		await handler.handleUpdate(makeUpdate("/mute 2h", 777));
		expect(repo.prefs.length).toBe(1);
		expect(repo.prefs[0]?.adminId).toBe(10);
		expect(typeof repo.prefs[0]?.informerMutedUntil).toBe("number");
	});

	it("/mute off снимает мут (null)", async () => {
		const { repo, handler } = wire(makeSettings({ telegramChatId: "777" }));
		await handler.handleUpdate(makeUpdate("/mute off", 777));
		expect(repo.prefs[0]?.informerMutedUntil).toBeNull();
	});

	it("команды без привязки → подсказка", async () => {
		const { handler, client } = wire(undefined);
		await handler.handleUpdate(makeUpdate("/level", 777));
		expect(client.sent[0]?.text).toContain("привяжите");
	});

	it("callback lvl:all обновляет уровень и редактирует клавиатуру", async () => {
		const { repo, handler, client } = wire(
			makeSettings({ telegramChatId: "777", adminId: 10 }),
		);
		const cb = {
			update_id: 2,
			callback_query: {
				id: "cb1",
				from: { id: 5 },
				data: "lvl:all",
				message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
			},
		} as unknown as TgUpdate;
		await handler.handleUpdate(cb);
		expect(repo.prefs[0]).toMatchObject({ adminId: 10, informerLevel: "all" });
		expect(client.edits.length).toBe(1);
		expect(client.answered.map((x) => x.callbackQueryId)).toContain("cb1");
	});

	it("callback tpc:orders тоглит тему", async () => {
		const { repo, handler } = wire(
			makeSettings({ telegramChatId: "777", informerTopics: null }),
		);
		const cb = {
			update_id: 3,
			callback_query: {
				id: "cb2",
				from: { id: 5 },
				data: "tpc:orders",
				message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
			},
		} as unknown as TgUpdate;
		await handler.handleUpdate(cb);
		// дефолт all-on → первый тогл выключает orders
		expect(repo.prefs[0]?.informerTopics).toBe(
			'{"leads":true,"escalation":true,"orders":false,"system":true}',
		);
	});

	it("/status показывает уровень, дайджест и темы", async () => {
		const { handler, client } = wire(
			makeSettings({
				telegramChatId: "777",
				informerLevel: "important",
				informerDigest: "daily",
				informerTopics: '{"orders":false}',
			}),
		);
		await handler.handleUpdate(makeUpdate("/status", 777));
		const text = client.sent[0]?.text ?? "";
		expect(text).toContain("Информер");
		expect(text).toContain("Важное");
		expect(text).toContain("⬜ 💱 Заявки"); // выключенная тема
		expect(text).toContain("✅ 🆕 Лиды"); // включённая
	});

	it("/topics показывает тоглы тем с галочками", async () => {
		const { handler, client } = wire(
			makeSettings({
				telegramChatId: "777",
				informerTopics: '{"system":false}',
			}),
		);
		await handler.handleUpdate(makeUpdate("/topics", 777));
		const flat = JSON.stringify(client.sent[0]?.replyMarkup);
		expect(client.sent[0]?.replyMarkup?.inline_keyboard?.length).toBe(4);
		expect(flat).toContain("tpc:system");
		expect(flat).toContain("⬜ 🛠 Система"); // выключена
		expect(flat).toContain("✅ 🆕 Лиды"); // включена
	});

	it("/digest показывает клавиатуру расписания", async () => {
		const { handler, client } = wire(
			makeSettings({ telegramChatId: "777", informerDigest: "daily" }),
		);
		await handler.handleUpdate(makeUpdate("/digest", 777));
		const flat = JSON.stringify(client.sent[0]?.replyMarkup);
		expect(flat).toContain("dig:off");
		expect(flat).toContain("dig:daily");
		expect(flat).toContain("dig:shift");
		expect(flat).toContain("• "); // текущий помечен
	});

	it("callback dig:shift обновляет расписание", async () => {
		const { repo, handler } = wire(
			makeSettings({ telegramChatId: "777", adminId: 10 }),
		);
		const cb = {
			update_id: 4,
			callback_query: {
				id: "cb3",
				from: { id: 5 },
				data: "dig:shift",
				message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
			},
		} as unknown as TgUpdate;
		await handler.handleUpdate(cb);
		expect(repo.prefs[0]).toMatchObject({
			adminId: 10,
			informerDigest: "shift",
		});
	});

	it("/last рендерит ленту последних событий", async () => {
		const { repo, handler, client } = wire(
			makeSettings({ telegramChatId: "777" }),
		);
		repo.recent = [
			{
				id: 2,
				severity: "critical",
				title: "Канал упал",
				body: "telegram_bot #1",
				createdAt: 1_700_000_000,
			},
			{
				id: 1,
				severity: "info",
				title: "Новый лид",
				body: "",
				createdAt: 1_699_999_000,
			},
		];
		await handler.handleUpdate(makeUpdate("/last", 777));
		const text = client.sent[0]?.text ?? "";
		expect(text).toContain("Последние 2");
		expect(text).toContain("Канал упал");
		expect(text).toContain("🔴");
	});

	it("/last на пустой ленте → подсказка", async () => {
		const { repo, handler, client } = wire(
			makeSettings({ telegramChatId: "777" }),
		);
		repo.recent = [];
		await handler.handleUpdate(makeUpdate("/last", 777));
		expect(client.sent[0]?.text).toContain("пусто");
	});
});
