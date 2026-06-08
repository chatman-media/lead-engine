import type { Db } from "@chatman-media/conversation-engine";
import { Hono } from "hono";

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

		void opts;
		return c.json({
			ok: true,
			ignored: true,
			reason: "westwallet provider is not available in this branch",
		});
	});

	return app;
}
