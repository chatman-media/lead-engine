// Unit-тесты OpsAlertRouter/ResendEmailSender без Postgres: Telegram-клиент
// из botToken (mock global fetch), catch-ветка резолва владельца и тонкий
// Resend-транспорт. Маршрутизация по severity покрыта в
// ops-alerts.integration.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import {
	type OpsAlert,
	OpsAlertRouter,
	ResendEmailSender,
} from "./ops-alerts.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function alert(over: Partial<OpsAlert> = {}): OpsAlert {
	return {
		tenantId: 1,
		kind: "rate_anomaly",
		severity: "critical",
		title: "Курс <скакнул>",
		detail: "deviation & spike",
		dedupKey: `k-${Math.random().toString(36).slice(2)}`,
		...over,
	};
}

/**
 * Чейнящийся фейк Drizzle Db: каждый await терминального выражения
 * (select/update/insert/execute) забирает следующий элемент script.
 * Error-элемент → reject. transaction(fn) вызывает fn с тем же фейком.
 */
function scriptedDb(script: Array<unknown[] | Error>): Db {
	let i = 0;
	const next = (): Promise<unknown[]> => {
		const entry = script[i++];
		if (entry instanceof Error) return Promise.reject(entry);
		return Promise.resolve(entry ?? []);
	};
	const makeChain = () => {
		// biome-ignore lint/suspicious/noExplicitAny: фейковый query-builder
		const chain: any = {};
		for (const m of [
			"from",
			"where",
			"innerJoin",
			"leftJoin",
			"orderBy",
			"limit",
			"set",
			"values",
			"returning",
		]) {
			chain[m] = () => chain;
		}
		// biome-ignore lint/suspicious/noThenProperty: thenable нужен, чтобы await drizzle-чейна забирал script
		chain.then = (
			res: (v: unknown) => unknown,
			rej?: (e: unknown) => unknown,
		) => next().then(res, rej);
		return chain;
	};
	// biome-ignore lint/suspicious/noExplicitAny: фейковый Db
	const db: any = {
		select: () => makeChain(),
		insert: () => makeChain(),
		update: () => makeChain(),
		execute: () => next(),
		transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	};
	return db as Db;
}

function telegramOkResponse(): Response {
	return new Response(
		JSON.stringify({
			ok: true,
			result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("OpsAlertRouter", () => {
	it("botToken без telegram-override → шлёт через TelegramClient (fetch)", async () => {
		const fetchCalls: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
			fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
			return telegramOkResponse();
		}) as unknown as typeof fetch;

		const emails: Array<{ to: string; subject: string; html: string }> = [];
		const infos: unknown[] = [];
		const router = new OpsAlertRouter({
			db: scriptedDb([
				[], // withTenant: SET LOCAL
				[{ email: "owner@x.io", slug: "t1" }], // owner select
				[{ chatId: "42" }], // operator chats select
			]),
			botToken: "test-token",
			appUrl: "http://app",
			email: {
				send: async (opts) => {
					emails.push(opts);
				},
			},
			log: {
				info: (msg, ctx) => infos.push({ msg, ctx }),
			},
		});

		await router.emit(alert());

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toContain("/bottest-token/sendMessage");
		const body = JSON.parse(fetchCalls[0]?.body ?? "{}") as {
			chat_id?: unknown;
			chatId?: unknown;
			text?: string;
		};
		expect(String(body.text)).toContain("&lt;скакнул&gt;");
		expect(emails).toHaveLength(1);
		expect(emails[0]?.subject).toContain("[critical]");
		expect(emails[0]?.html).toContain("операционный алерт");
		expect(infos).toContainEqual(
			expect.objectContaining({
				msg: "[ops-alerts] routed",
				ctx: expect.objectContaining({
					telegramDelivered: true,
					emailDelivered: true,
				}),
			}),
		);
	});

	it("резолв владельца упал → warn и тихий выход", async () => {
		const warns: Array<{ msg: string; ctx: unknown }> = [];
		const router = new OpsAlertRouter({
			db: scriptedDb([new Error("pg down")]),
			botToken: "",
			appUrl: "http://app",
			telegram: null,
			log: {
				warn: (msg, ctx) => warns.push({ msg, ctx }),
			},
		});

		await router.emit(alert({ severity: "warning" }));

		expect(warns).toContainEqual(
			expect.objectContaining({ msg: "[ops-alerts] owner resolve failed" }),
		);
	});
});

describe("ResendEmailSender", () => {
	it("без apiKey → dry-run (без fetch)", async () => {
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await new ResendEmailSender("", "noreply@x.io").send({
			to: "a@b.c",
			subject: "s",
			html: "<b>h</b>",
		});
		expect(fetched).toBe(false);
	});

	it("с apiKey → POST на api.resend.com с Authorization", async () => {
		const calls: Array<{
			url: string;
			headers: Record<string, string>;
			body: string;
		}> = [];
		globalThis.fetch = (async (
			url: unknown,
			init?: { headers?: Record<string, string>; body?: unknown },
		) => {
			calls.push({
				url: String(url),
				headers: init?.headers ?? {},
				body: String(init?.body ?? ""),
			});
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await new ResendEmailSender("rk_test", "noreply@x.io").send({
			to: "owner@x.io",
			subject: "alert",
			html: "<b>h</b>",
		});

		expect(calls[0]?.url).toBe("https://api.resend.com/emails");
		expect(calls[0]?.headers.Authorization).toBe("Bearer rk_test");
		const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body.to).toEqual(["owner@x.io"]);
		expect(body.from).toBe("noreply@x.io");
	});

	it("non-2xx ответ → throw с кодом", async () => {
		globalThis.fetch = (async () =>
			new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

		await expect(
			new ResendEmailSender("rk_test", "noreply@x.io").send({
				to: "owner@x.io",
				subject: "alert",
				html: "<b>h</b>",
			}),
		).rejects.toThrow(/Resend error 429/);
	});
});
