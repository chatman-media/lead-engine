/**
 * Админка concierge-сервисов: каталог услуг (трансфер, еда, уборка, экскурсии).
 *
 * GET  /api/admin/concierge/catalog   — прочитать текущий каталог
 * PUT  /api/admin/concierge/catalog   — сохранить каталог (полная замена)
 * DELETE /api/admin/concierge/catalog — удалить каталог (сброс к needsOperator)
 *
 * Каталог хранится в tenant_secrets["concierge_catalog"] как AES-256-GCM JSON.
 * После PUT/DELETE onReload(tenantId) сбрасывает кеш resolveTools.
 */

import {
	type Db,
	getDecryptedSecret,
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import { tenantSecrets } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import {
	CONCIERGE_CATALOG_KEY,
	type ConciergeCatalog,
} from "../lib/concierge-domain-tools.ts";

export interface AdminConciergeRoutesOpts {
	db: Db;
	masterKeyHex: string;
	/** Сброс кеша resolveTools после изменения каталога. */
	onReload?: (tenantId: number) => void;
}

export function makeAdminConciergeRoutes(opts: AdminConciergeRoutesOpts) {
	const { db, masterKeyHex, onReload } = opts;
	const app = new Hono();

	// GET /api/admin/concierge/catalog
	app.get("/api/admin/concierge/catalog", async (c) => {
		const tenantId = c.var.tenantId as number;
		const json = await getDecryptedSecret({
			db,
			tenantId,
			key: CONCIERGE_CATALOG_KEY,
			masterKeyHex,
		});
		if (!json) return c.json({ catalog: null });
		try {
			return c.json({ catalog: JSON.parse(json) as ConciergeCatalog });
		} catch {
			return c.json({
				catalog: null,
				error: "Каталог повреждён — сохраните снова.",
			});
		}
	});

	// PUT /api/admin/concierge/catalog
	app.put("/api/admin/concierge/catalog", async (c) => {
		const tenantId = c.var.tenantId as number;
		let body: ConciergeCatalog;
		try {
			body = await c.req.json<ConciergeCatalog>();
		} catch {
			return c.json({ error: "Невалидный JSON" }, 400);
		}

		// Basic validation: каталог должен быть объектом с хотя бы одним известным ключом
		const knownKeys = ["transfer", "food", "housekeeping", "tour"];
		if (
			typeof body !== "object" ||
			body === null ||
			!knownKeys.some((k) => k in body)
		) {
			return c.json(
				{
					error: `Каталог должен содержать хотя бы один раздел: ${knownKeys.join(", ")}`,
				},
				400,
			);
		}

		await setEncryptedSecret({
			db,
			tenantId,
			key: CONCIERGE_CATALOG_KEY,
			value: JSON.stringify(body),
			masterKeyHex,
			nowEpoch: Math.floor(Date.now() / 1000),
		});

		await recordAudit(db, {
			tenantId,
			action: "concierge_catalog_updated",
			details: { sections: knownKeys.filter((k) => k in body) },
		});

		onReload?.(tenantId);
		return c.json({ ok: true, catalog: body });
	});

	// DELETE /api/admin/concierge/catalog
	app.delete("/api/admin/concierge/catalog", async (c) => {
		const tenantId = c.var.tenantId as number;
		await withTenant(db, tenantId, (tx) =>
			tx
				.delete(tenantSecrets)
				.where(
					and(
						eq(tenantSecrets.tenantId, tenantId),
						eq(tenantSecrets.key, CONCIERGE_CATALOG_KEY),
					),
				),
		);

		await recordAudit(db, {
			tenantId,
			action: "concierge_catalog_deleted",
		});

		onReload?.(tenantId);
		return c.json({ ok: true });
	});

	return app;
}
