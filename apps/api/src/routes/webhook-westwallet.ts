import type { Db } from "@chatman-media/conversation-engine";
import { Hono } from "hono";
import { getOrderById, updateOrder } from "../lib/exchange/orders.ts";
import { verifyWestWalletInvoicePayment } from "../lib/exchange/providers.ts";

export function makeWestWalletWebhookRoutes(opts: {
	db: Db;
	masterKeyHex: string;
}): Hono {
	const app = new Hono();

	app.post("/webhook/westwallet/:tenantId", async (c) => {
		const tenantId = Number(c.req.param("tenantId"));
		if (!Number.isInteger(tenantId) || tenantId <= 0) {
			return c.json({ error: "bad tenant" }, 400);
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File>;
		const label = typeof body.label === "string" ? body.label : "";
		const match = /^le-(\d+)-(\d+)$/.exec(label);
		if (!match) return c.json({ ok: true, ignored: true, reason: "unknown label" });

		const labelTenantId = Number(match[1]);
		const orderId = Number(match[2]);
		if (labelTenantId !== tenantId || !Number.isInteger(orderId)) {
			return c.json({ ok: true, ignored: true, reason: "label mismatch" });
		}

		const order = await getOrderById(opts.db, tenantId, orderId);
		if (!order?.requisitesJson) {
			return c.json({ ok: true, ignored: true, reason: "order not found" });
		}

		let req: Record<string, unknown> | null = null;
		try {
			req = JSON.parse(order.requisitesJson);
		} catch {
			req = null;
		}
		const token = typeof req?.invoiceToken === "string" ? req.invoiceToken : "";
		if (!token) return c.json({ ok: true, ignored: true, reason: "no invoice token" });

		const verification = await verifyWestWalletInvoicePayment({
			db: opts.db,
			tenantId,
			masterKeyHex: opts.masterKeyHex,
			token,
			expectedAmount: order.amountFrom,
		});
		await updateOrder(opts.db, tenantId, order.id, {
			proofJson: JSON.stringify({
				kind: "westwallet_ipn",
				raw: body,
				invoiceToken: token,
				transaction: verification.transaction ?? null,
				verifiedOk: verification.ok,
				needsOperator: verification.needsOperator ?? false,
			}),
			...(verification.ok ? { status: "paid" } : {}),
		});

		return c.json({ ok: true, verified: verification.ok });
	});

	return app;
}
