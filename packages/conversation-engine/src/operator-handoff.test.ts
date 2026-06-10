import { describe, expect, it } from "bun:test";
import type {
	Inbound,
	OperatorHandoffMeta,
	OutboundEnvelope,
} from "@chatman-media/channel-core";
import type { NotificationService } from "./notifications.ts";
import {
	collectOperatorHandoffMediaRefs,
	emitOperatorHandoffNotifications,
	formatOperatorHandoffMediaSummary,
	operatorMediaNotificationData,
} from "./operator-handoff.ts";
import type { PipelineEvent, PipelineSink } from "./types.ts";

function envelope(handoff?: OperatorHandoffMeta): OutboundEnvelope {
	return {
		channelId: "1",
		externalUserId: "client-1",
		parts: [{ kind: "text", text: "ответ" }],
		...(handoff ? { operatorHandoff: handoff } : {}),
	};
}

function handoffMeta(
	overrides: Partial<OperatorHandoffMeta> = {},
): OperatorHandoffMeta {
	return {
		reason: "kyc_review",
		title: "KYC review",
		action: "Проверить документы",
		...overrides,
	};
}

interface NotifyCall {
	tenantId: number;
	eventType: string;
	conversationId: number;
	contactId: number;
	data: Record<string, unknown>;
}

function makeNotifications(opts: { failWith?: unknown } = {}) {
	const calls: NotifyCall[] = [];
	const service = {
		notify: async (event: NotifyCall) => {
			calls.push(event);
			if (opts.failWith !== undefined) throw opts.failWith;
		},
	} as unknown as NotificationService;
	return { calls, service };
}

function makeSink() {
	const logs: Array<{
		level: string;
		msg: string;
		meta?: Record<string, unknown>;
	}> = [];
	const events: PipelineEvent[] = [];
	const sink: PipelineSink = {
		log: (level, msg, meta) => {
			logs.push({ level, msg, meta });
		},
		emit: (event) => {
			events.push(event);
		},
	};
	return { logs, events, sink };
}

const mediaInbound: Pick<Inbound, "parts"> = {
	parts: [
		{ kind: "text", text: "вот документы" },
		{
			kind: "photo",
			mediaRef: { channelId: "1", externalRef: "photo-1" },
			caption: "паспорт",
		},
		{
			kind: "document",
			mediaRef: { channelId: "1", externalRef: "doc-1" },
			mimeType: "application/pdf",
			fileName: "statement.pdf",
		},
		{
			kind: "voice",
			mediaRef: { channelId: "1", externalRef: "voice-1" },
			durationSec: 12,
		},
		{
			kind: "video_note",
			mediaRef: { channelId: "1", externalRef: "note-1" },
		},
		{ kind: "callback_query", data: "noop", originalMessageId: "5" },
	],
};

describe("collectOperatorHandoffMediaRefs", () => {
	it("null/undefined inbound → []", () => {
		expect(collectOperatorHandoffMediaRefs(null)).toEqual([]);
		expect(collectOperatorHandoffMediaRefs(undefined)).toEqual([]);
	});

	it("пропускает text и callback_query, собирает медиа с опц. полями", () => {
		const refs = collectOperatorHandoffMediaRefs(mediaInbound);
		expect(refs).toEqual([
			{
				kind: "photo",
				channelId: "1",
				externalRef: "photo-1",
				caption: "паспорт",
			},
			{
				kind: "document",
				channelId: "1",
				externalRef: "doc-1",
				mimeType: "application/pdf",
				fileName: "statement.pdf",
			},
			{
				kind: "voice",
				channelId: "1",
				externalRef: "voice-1",
				durationSec: 12,
			},
			{ kind: "video_note", channelId: "1", externalRef: "note-1" },
		]);
	});

	it("только текст → []", () => {
		expect(
			collectOperatorHandoffMediaRefs({
				parts: [{ kind: "text", text: "hi" }],
			}),
		).toEqual([]);
	});
});

describe("formatOperatorHandoffMediaSummary", () => {
	it("пустой список → пустая строка", () => {
		expect(formatOperatorHandoffMediaSummary([])).toBe("");
	});

	it("нумерует записи, детали в скобках только когда есть", () => {
		const summary = formatOperatorHandoffMediaSummary([
			{
				kind: "document",
				channelId: "1",
				externalRef: "doc-1",
				fileName: "statement.pdf",
				mimeType: "application/pdf",
			},
			{
				kind: "voice",
				channelId: "1",
				externalRef: "voice-1",
				durationSec: 12,
			},
			{ kind: "video_note", channelId: "1", externalRef: "note-1" },
		]);
		expect(summary.split("\n")).toEqual([
			"1. document (statement.pdf, application/pdf) · 1:doc-1",
			"2. voice (12s) · 1:voice-1",
			"3. video_note · 1:note-1",
		]);
	});
});

describe("operatorMediaNotificationData", () => {
	it("без медиа → {}", () => {
		expect(operatorMediaNotificationData(null)).toEqual({});
		expect(
			operatorMediaNotificationData({ parts: [{ kind: "text", text: "hi" }] }),
		).toEqual({});
	});

	it("с медиа → count + summary + сериализованные refs", () => {
		const data = operatorMediaNotificationData(mediaInbound);
		expect(data.mediaCount).toBe(4);
		expect(String(data.mediaSummary)).toContain("statement.pdf");
		const parsed = JSON.parse(String(data.mediaRefsJson)) as Array<
			Record<string, unknown>
		>;
		expect(parsed).toHaveLength(4);
		expect(parsed[0]).toMatchObject({ kind: "photo", caption: "паспорт" });
	});
});

describe("emitOperatorHandoffNotifications", () => {
	it("без operatorHandoff в envelope'ах ничего не делает", async () => {
		const { calls, service } = makeNotifications();
		const { events, sink } = makeSink();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [envelope(), envelope()],
			notifications: service,
			sink,
		});
		expect(calls).toEqual([]);
		expect(events).toEqual([]);
	});

	it("дедуплицирует handoff'ы по reason+contractId+orderId", async () => {
		const { calls, service } = makeNotifications();
		const { events, sink } = makeSink();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [
				envelope(handoffMeta({ contractId: "c-1", orderId: 7 })),
				envelope(handoffMeta({ contractId: "c-1", orderId: 7 })),
				envelope(handoffMeta({ reason: "payment_review", orderId: 8 })),
			],
			notifications: service,
			sink,
		});
		expect(calls).toHaveLength(2);
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({
			type: "conversation-escalated",
			tenantId: 1,
			conversationId: 2,
			reason: "kyc_review",
		});
		expect(events[1]).toMatchObject({ reason: "payment_review" });
	});

	it("заполняет data всеми полями handoff'а + media", async () => {
		const { calls, service } = makeNotifications();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			contactDisplayName: "Иван",
			userMessageText: "перевожу 100к",
			inbound: mediaInbound,
			envelopes: [
				envelope(
					handoffMeta({
						reason: "payment_review",
						title: "Чек на проверку",
						action: "Сверить поступление",
						contractId: "c-9",
						orderId: 42,
						stageSlug: "clear",
						priority: "high",
						accepted: "чек",
						pending: "зачисление",
						reviewPath: "/orders/42",
						context: "крупная сумма",
						urgency: "сегодня",
						amount: "100000 RUB",
						rail: "sbp",
						network: "-",
					}),
				),
			],
			notifications: service,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tenantId: 1,
			eventType: "operator_handoff_required",
			conversationId: 2,
			contactId: 3,
		});
		expect(calls[0]?.data).toMatchObject({
			displayName: "Иван",
			reason: "payment_review",
			title: "Чек на проверку",
			action: "Сверить поступление",
			contractId: "c-9",
			orderId: 42,
			stageSlug: "clear",
			priority: "high",
			accepted: "чек",
			pending: "зачисление",
			reviewPath: "/orders/42",
			context: "крупная сумма",
			urgency: "сегодня",
			amount: "100000 RUB",
			rail: "sbp",
			network: "-",
			text: "перевожу 100к",
			mediaCount: 4,
		});
	});

	it("подставляет дефолты для опциональных полей", async () => {
		const { calls, service } = makeNotifications();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			contactDisplayName: null,
			envelopes: [envelope(handoffMeta())],
			notifications: service,
		});
		expect(calls[0]?.data).toMatchObject({
			displayName: "Контакт #3",
			contractId: "",
			orderId: "",
			stageSlug: "",
			priority: "normal",
			accepted: "",
			pending: "",
			reviewPath: "",
			context: "",
			urgency: "",
			amount: "",
			rail: "",
			network: "",
			text: "",
		});
		expect(calls[0]?.data).not.toHaveProperty("mediaCount");
	});

	it("без notifications-сервиса только эмитит событие в sink", async () => {
		const { events, sink } = makeSink();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [envelope(handoffMeta())],
			sink,
		});
		expect(events).toHaveLength(1);
	});

	it("работает вообще без sink и notifications", async () => {
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [envelope(handoffMeta())],
		});
	});

	it("ошибка notify логируется warn'ом и не валит остальные handoff'ы", async () => {
		const { calls, service } = makeNotifications({
			failWith: new Error("tg down"),
		});
		const { logs, sink } = makeSink();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [
				envelope(handoffMeta()),
				envelope(handoffMeta({ reason: "payout_review" })),
			],
			notifications: service,
			sink,
		});
		expect(calls).toHaveLength(2);
		const warns = logs.filter(
			(l) =>
				l.level === "warn" && l.msg === "operator handoff notification failed",
		);
		expect(warns).toHaveLength(2);
		expect(warns[0]?.meta).toMatchObject({
			tenantId: 1,
			conversationId: 2,
			reason: "kyc_review",
			error: "tg down",
		});
	});

	it("не-Error отказ notify сериализуется через String()", async () => {
		const { service } = makeNotifications({ failWith: "boom" });
		const { logs, sink } = makeSink();
		await emitOperatorHandoffNotifications({
			tenantId: 1,
			conversationId: 2,
			contactId: 3,
			envelopes: [envelope(handoffMeta())],
			notifications: service,
			sink,
		});
		expect(logs[0]?.meta).toMatchObject({ error: "boom" });
	});
});
