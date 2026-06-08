import { describe, expect, it } from "bun:test";
import { StripeApi, StripeApiError } from "./stripe-api.ts";

describe("StripeApi", () => {
	it("requires a secret key", () => {
		expect(() => new StripeApi({ secretKey: "" })).toThrow(
			"StripeApi: secretKey required",
		);
	});

	it("creates customers, checkout sessions, portal sessions and lists invoices", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const invoice = {
			id: "in_1",
			number: "INV-1",
			status: "paid",
			amount_due: 1000,
			amount_paid: 1000,
			currency: "usd",
			created: 1,
			period_start: 1,
			period_end: 2,
			hosted_invoice_url: null,
			invoice_pdf: null,
			description: null,
		};
		const api = new StripeApi({
			secretKey: "sk_test",
			baseUrl: "https://stripe.test",
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init: init ?? {} });
				if (String(url).endsWith("/v1/customers")) {
					return Response.json({ id: "cus_1", email: "owner@example.test" });
				}
				if (String(url).endsWith("/v1/checkout/sessions")) {
					return Response.json({ id: "cs_1", url: "https://checkout.test" });
				}
				if (String(url).endsWith("/v1/billing_portal/sessions")) {
					return Response.json({ id: "bps_1", url: "https://portal.test" });
				}
				return Response.json({ data: [invoice] });
			}) as typeof fetch,
		});

		expect(
			await api.createCustomer({
				email: "owner@example.test",
				tenantId: 42,
				tenantSlug: "demo",
			}),
		).toEqual({ id: "cus_1", email: "owner@example.test" });
		expect(
			await api.createCheckoutSession({
				customerId: "cus_1",
				priceId: "price_1",
				tenantId: 42,
				successUrl: "https://app.test/success",
				cancelUrl: "https://app.test/cancel",
				trialDays: 7,
			}),
		).toEqual({ id: "cs_1", url: "https://checkout.test" });
		expect(
			await api.createBillingPortalSession({
				customerId: "cus_1",
				returnUrl: "https://app.test/billing",
			}),
		).toEqual({ id: "bps_1", url: "https://portal.test" });
		expect(await api.listInvoices({ customerId: "cus_1", limit: 3 })).toEqual({
			data: [invoice],
		});

		expect(calls[0]?.init.headers).toMatchObject({
			authorization: "Bearer sk_test",
			"content-type": "application/x-www-form-urlencoded",
		});
		expect(String(calls[0]?.init.body)).toContain("metadata%5Btenant_id%5D=42");
		expect(String(calls[1]?.init.body)).toContain(
			"subscription_data%5Btrial_period_days%5D=7",
		);
		expect(calls[3]?.url).toBe(
			"https://stripe.test/v1/invoices?customer=cus_1&limit=3",
		);
		expect(calls[3]?.init.headers).toMatchObject({
			authorization: "Bearer sk_test",
		});
		expect(calls[3]?.init.body).toBeUndefined();
	});

	it("throws structured StripeApiError on API failures", async () => {
		const api = new StripeApi({
			secretKey: "sk_test",
			fetch: (async () =>
				Response.json(
					{ error: { code: "resource_missing", message: "No customer" } },
					{ status: 404 },
				)) as unknown as typeof fetch,
		});

		try {
			await api.createBillingPortalSession({
				customerId: "missing",
				returnUrl: "https://app.test",
			});
			throw new Error("expected StripeApiError");
		} catch (err) {
			expect(err).toBeInstanceOf(StripeApiError);
			const stripeErr = err as StripeApiError;
			expect(stripeErr.method).toBe("POST /v1/billing_portal/sessions");
			expect(stripeErr.statusCode).toBe(404);
			expect(stripeErr.code).toBe("resource_missing");
			expect(stripeErr.description).toBe("No customer");
		}
	});
});
