/**
 * Unit tests for partner-ping callback token sign/verify.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	firePartnerPing,
	makeCallbackToken,
	type PartnerPingOpts,
	verifyCallbackToken,
} from "./partner-ping.ts";

const SECRET = "test-secret-32-bytes-long-enough";
const originalFetch = globalThis.fetch;

function basePing(overrides: Partial<PartnerPingOpts> = {}): PartnerPingOpts {
	return {
		webhookUrl: "https://partner.test/handoff",
		webhookMode: "await_callback",
		tenantId: 2,
		leadId: 42,
		stageId: 7,
		tenantSlug: "demo",
		stageSlug: "partner_stage",
		stageDisplayName: "Partner stage",
		contactDisplayName: "Alice",
		leadFields: { service: "visa", empty: "", tenantId: 1 },
		appUrl: "https://app.test",
		operatorBotToken: "123:token",
		callbackSecret: SECRET,
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("partner-ping token", () => {
	it("roundtrips sign → verify", async () => {
		const payload = { tenantId: 2, leadId: 42, stageId: 7, ts: 1_700_000_000 };
		const token = await makeCallbackToken(payload, SECRET);
		expect(typeof token).toBe("string");
		expect(token.includes(".")).toBe(true);

		const result = await verifyCallbackToken(token, SECRET);
		expect(result).toEqual(payload);
	});

	it("rejects tampered token", async () => {
		const token = await makeCallbackToken(
			{ tenantId: 1, leadId: 1, stageId: 2, ts: 100 },
			SECRET,
		);
		// flip one char in the HMAC part
		const parts = token.split(".");
		const hmac = parts[1];
		if (!hmac) throw new Error("token HMAC part missing");
		parts[1] = hmac.slice(0, -1) + (hmac.endsWith("a") ? "b" : "a");
		const tampered = parts.join(".");
		const result = await verifyCallbackToken(tampered, SECRET);
		expect(result).toBeNull();
	});

	it("rejects empty string", async () => {
		expect(await verifyCallbackToken("", SECRET)).toBeNull();
	});

	it("rejects token with wrong secret", async () => {
		const token = await makeCallbackToken(
			{ tenantId: 1, leadId: 1, stageId: 2, ts: 100 },
			SECRET,
		);
		expect(await verifyCallbackToken(token, "different-secret")).toBeNull();
	});

	it("rejects legacy payload without tenantId", async () => {
		const header = Buffer.from(
			JSON.stringify({ leadId: 1, stageId: 2, ts: 100 }),
			"utf8",
		).toString("base64url");
		const { signWebhookPayload } = await import("./webhook-sign.ts");
		const token = `${header}.${await signWebhookPayload(header, SECRET)}`;
		expect(await verifyCallbackToken(token, SECRET)).toBeNull();
	});
});

describe("firePartnerPing", () => {
	it("HTTP transport posts signed callback payload", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		const result = await firePartnerPing(basePing());

		expect(result.transport).toBe("http");
		expect(await verifyCallbackToken(result.token, SECRET)).toMatchObject({
			tenantId: 2,
			leadId: 42,
			stageId: 7,
		});
		expect(calls).toHaveLength(1);
		const call = calls.at(0);
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe("https://partner.test/handoff");
		expect(call.init?.method).toBe("POST");
		expect(call.init?.headers).toMatchObject({
			"Content-Type": "application/json",
			"User-Agent": "LeadEngine-PartnerPing/1.0",
		});
		const body = JSON.parse(String(call.init?.body)) as {
			event: string;
			callbackUrl: string;
			actions: { confirm: string; cancel: string };
			callbackToken: string;
			fields: Record<string, unknown>;
		};
		expect(body.event).toBe("lead.partner_handoff");
		expect(body.callbackUrl).toBe(
			`https://app.test/api/partner/cb/${result.token}`,
		);
		expect(body.actions.confirm).toBe(
			`https://app.test/api/partner/cb/${result.token}?a=confirm`,
		);
		expect(body.actions.cancel).toBe(
			`https://app.test/api/partner/cb/${result.token}?a=cancel`,
		);
		expect(body.callbackToken).toBe(result.token);
		expect(body.fields.service).toBe("visa");
	});

	it("HTTP transport throws on non-ok response with response text", async () => {
		globalThis.fetch = (async () =>
			new Response("bad partner", { status: 503 })) as unknown as typeof fetch;

		await expect(firePartnerPing(basePing())).rejects.toThrow(
			"Partner webhook responded 503: bad partner",
		);
	});

	it("Telegram transport sends formatted message with action buttons", async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({
				url: String(url),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return Response.json({ ok: true });
		}) as typeof fetch;

		const result = await firePartnerPing(
			basePing({ webhookUrl: "tg://-100123456" }),
		);

		expect(result.transport).toBe("telegram");
		expect(calls).toHaveLength(1);
		const call = calls.at(0);
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe("https://api.telegram.org/bot123:token/sendMessage");
		expect(call.body.chat_id).toBe("-100123456");
		expect(String(call.body.text)).toContain("<b>Клиент:</b> Alice");
		expect(String(call.body.text)).toContain("<b>service</b>: visa");
		expect(String(call.body.text)).not.toContain("tenantId");
		const markup = call.body.reply_markup as {
			inline_keyboard: Array<Array<{ text: string; url: string }>>;
		};
		const [row] = markup.inline_keyboard;
		if (!row) throw new Error("Telegram inline keyboard row missing");
		const [confirm, cancel] = row;
		if (!confirm || !cancel) {
			throw new Error("Telegram action buttons missing");
		}
		expect(confirm.url).toContain(result.token);
		expect(cancel.url).toContain("?a=cancel");
	});

	it("Telegram transport validates chat id and bot token", async () => {
		await expect(
			firePartnerPing(basePing({ webhookUrl: "tg:// " })),
		).rejects.toThrow("tg:// has no chat_id");
		await expect(
			firePartnerPing(
				basePing({ webhookUrl: "tg://42", operatorBotToken: "" }),
			),
		).rejects.toThrow("PLATFORM_OPERATOR_BOT_TOKEN not configured");
	});

	it("Telegram transport throws with Telegram description on non-ok response", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ description: "chat not found" },
				{ status: 400 },
			)) as unknown as typeof fetch;

		await expect(
			firePartnerPing(basePing({ webhookUrl: "tg://42" })),
		).rejects.toThrow("Telegram sendMessage failed 400: chat not found");
	});
});
