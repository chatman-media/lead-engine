import { afterEach, describe, expect, it } from "bun:test";
import {
	forgotPasswordEmailHtml,
	inviteEmailHtml,
	Mailer,
	paymentFailedEmailHtml,
	trialEndingEmailHtml,
	usageAlertEmailHtml,
	welcomeEmailHtml,
} from "./mailer.ts";

const originalFetch = globalThis.fetch;
const originalLog = console.log;

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.log = originalLog;
});

describe("Mailer", () => {
	it("dry-runs without RESEND_API_KEY", async () => {
		const logs: string[] = [];
		console.log = (msg: string) => logs.push(msg);

		await new Mailer().send({
			to: "owner@example.test",
			subject: "Hello",
			html: "<p>Hello</p>",
		});

		expect(logs[0]).toContain("dry-run");
		expect(logs[0]).toContain("owner@example.test");
	});

	it("posts Resend payload and throws on provider errors", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		await new Mailer({
			apiKey: "resend-key",
			fromAddress: "Ops <ops@example.test>",
		}).send({
			to: "owner@example.test",
			subject: "Subject",
			html: "<strong>Body</strong>",
		});

		const call = calls.at(0);
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe("https://api.resend.com/emails");
		expect(call.init?.headers).toMatchObject({
			Authorization: "Bearer resend-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(call.init?.body))).toMatchObject({
			from: "Ops <ops@example.test>",
			to: ["owner@example.test"],
			subject: "Subject",
			html: "<strong>Body</strong>",
		});

		globalThis.fetch = (async () =>
			new Response("bad", { status: 500 })) as unknown as typeof fetch;
		await expect(
			new Mailer({ apiKey: "resend-key" }).send({
				to: "owner@example.test",
				subject: "Subject",
				html: "<p>Body</p>",
			}),
		).rejects.toThrow("Resend error 500: bad");
	});
});

describe("email templates", () => {
	it("renders expected calls to action and escapes user-controlled values", () => {
		expect(
			welcomeEmailHtml({
				email: "owner@example.test",
				slug: "tenant",
				appUrl: "https://app.example.test",
			}),
		).toContain("Открыть дашборд");
		expect(
			trialEndingEmailHtml({
				email: "owner@example.test",
				slug: "tenant",
				daysLeft: 1,
				appUrl: "https://app.example.test",
				billingUrl: "https://app.example.test/billing",
			}),
		).toContain("через 1 день");
		expect(
			usageAlertEmailHtml({
				email: "owner@example.test",
				slug: "tenant",
				current: 80,
				limit: 100,
				pct: 80,
				appUrl: "https://app.example.test",
				billingUrl: "https://app.example.test/billing",
			}),
		).toContain("80% квоты");
		expect(
			paymentFailedEmailHtml({
				email: "owner@example.test",
				slug: "tenant",
				appUrl: "https://app.example.test",
				billingUrl: "https://app.example.test/billing",
			}),
		).toContain("Не удалось списать оплату");

		const reset = forgotPasswordEmailHtml({
			email: "bad<script>@example.test",
			resetUrl: "https://app.example.test/reset?a=<bad>&b='q'",
		});
		expect(reset).toContain("bad&lt;script&gt;@example.test");
		expect(reset).toContain("&lt;bad&gt;");
		expect(reset).toContain("&#39;q&#39;");

		const invite = inviteEmailHtml({
			email: "member@example.test",
			inviteUrl: "https://app.example.test/invite?x=<bad>",
			tenantSlug: "tenant<script>",
			role: "manager",
		});
		expect(invite).toContain("tenant&lt;script&gt;");
		expect(invite).toContain("Менеджер");
	});
});
