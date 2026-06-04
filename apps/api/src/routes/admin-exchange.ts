/**
 * Админка обменника: курсы/формулы (п.21), CRM заявок (п.18-19), оборот (п.17),
 * реквизиты-секреты (кошельки / платёжная ссылка для PaymentProvider).
 *
 * Все запросы к exchange_* идут через withTenant (RLS FORCE).
 * onReload(tenantId) сбрасывает кеш resolveTools (вкл/выкл exchange-tools).
 */

import {
	type Db,
	getDecryptedSecret,
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	exchangeOrders,
	exchangeRates,
	exchangeRateTiers,
	tenantSecrets,
} from "@chatman-media/storage";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
	buildDefaultRateCardProposal,
	type RateCardProposal,
	refreshTenantRates,
	renderRateCardMessage,
} from "../lib/exchange/rate-feed.ts";
import { isAllowedExchangeSecretKey } from "../lib/exchange/requisite-keys.ts";

export interface AdminExchangeRoutesOpts {
	db: Db;
	masterKeyHex: string;
	/** Сброс кеша resolveTools после изменения курсов/реквизитов. */
	onReload?: (tenantId: number) => void;
}

const QUOTE_MODES = ["multiply", "divide"] as const;

function resolveExchangeWorkflowStage(
	order: typeof exchangeOrders.$inferSelect,
): {
	slug: string;
	label: string;
} {
	if (order.status === "cancelled")
		return { slug: "cancelled", label: "Отменено" };
	if (order.status === "expired")
		return { slug: "cancelled", label: "Истёк TTL" };
	if (order.status === "completed") {
		return { slug: "payout_or_completion", label: "Выдача / Завершено" };
	}
	if (order.status === "payout") {
		return { slug: "payout_or_completion", label: "Выдача THB" };
	}
	if (order.status === "paid") {
		return { slug: "payment_verified", label: "Оплата подтверждена" };
	}
	if (order.proofJson) {
		return { slug: "payment_verified", label: "Проверка чека" };
	}
	if (order.status === "awaiting_payment" && order.requisitesJson) {
		return { slug: "payment_proof_waiting", label: "Ожидание оплаты" };
	}
	if (order.status === "awaiting_payment") {
		return { slug: "requisites_sent", label: "Реквизиты / оплата" };
	}
	if (order.riskJson) return { slug: "order_created", label: "Заявка создана" };
	return { slug: "quote_calculated", label: "Курс рассчитан" };
}

function serializeExchangeOrder(order: typeof exchangeOrders.$inferSelect) {
	return {
		...order,
		workflowStage: resolveExchangeWorkflowStage(order),
	};
}

export function makeAdminExchangeRoutes(opts: AdminExchangeRoutesOpts): Hono {
	const app = new Hono();

	// ── Курсы / формулы ────────────────────────────────────────────────────────
	app.get("/api/admin/exchange/rates", async (c) => {
		const tenantId = c.var.tenantId;
		const rows = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select()
				.from(exchangeRates)
				.where(eq(exchangeRates.tenantId, tenantId))
				.orderBy(exchangeRates.asset, exchangeRates.network),
		);
		return c.json({ rates: rows });
	});

	// Upsert по (asset, quoteAsset, network).
	app.post("/api/admin/exchange/rates", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = c.var.adminId as number | undefined;
		const body = await c.req.json().catch(() => ({}));

		const asset =
			typeof body?.asset === "string" ? body.asset.trim().toUpperCase() : "";
		if (!asset) return c.json({ error: "asset required" }, 400);
		const quoteAsset =
			typeof body?.quoteAsset === "string" && body.quoteAsset.trim()
				? body.quoteAsset.trim().toUpperCase()
				: "THB";
		const network =
			typeof body?.network === "string"
				? body.network.trim().toLowerCase().replace(/-/g, "")
				: "";
		const autoUpdate = !!body?.autoUpdate;
		// Для auto-курса базу заполнит рыночный фид → допускаем 0 как стартовое значение.
		const baseRate = Number.isFinite(Number(body?.baseRate))
			? Number(body.baseRate)
			: 0;
		if (!autoUpdate && baseRate <= 0) {
			return c.json(
				{
					error: "baseRate must be a positive number (или включите авто-курс)",
				},
				400,
			);
		}
		const quoteMode = QUOTE_MODES.includes(body?.quoteMode)
			? body.quoteMode
			: "multiply";
		const marginPct = Number.isFinite(Number(body?.marginPct))
			? Number(body.marginPct)
			: 0;
		const feeFixedThb = Number.isFinite(Number(body?.feeFixedThb))
			? Number(body.feeFixedThb)
			: 0;
		const minAmountFrom =
			body?.minAmountFrom == null || body.minAmountFrom === ""
				? null
				: Number(body.minAmountFrom);
		const maxAmountFrom =
			body?.maxAmountFrom == null || body.maxAmountFrom === ""
				? null
				: Number(body.maxAmountFrom);
		const isActive = body?.isActive === undefined ? true : !!body.isActive;
		const now = Math.floor(Date.now() / 1000);

		const [row] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.insert(exchangeRates)
				.values({
					tenantId,
					asset,
					quoteAsset,
					network,
					baseRate,
					quoteMode,
					marginPct,
					feeFixedThb,
					minAmountFrom,
					maxAmountFrom,
					isActive,
					autoUpdate,
					updatedByAdminId: adminId ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						exchangeRates.tenantId,
						exchangeRates.asset,
						exchangeRates.quoteAsset,
						exchangeRates.network,
					],
					set: {
						baseRate,
						quoteMode,
						marginPct,
						feeFixedThb,
						minAmountFrom,
						maxAmountFrom,
						isActive,
						autoUpdate,
						updatedByAdminId: adminId ?? null,
						updatedAt: now,
					},
				})
				.returning(),
		);

		opts.onReload?.(tenantId);
		return c.json({ ok: true, rate: row });
	});

	// Немедленно обновить auto-курсы тенанта рыночным фидом.
	app.post("/api/admin/exchange/rates/refresh", async (c) => {
		const tenantId = c.var.tenantId;
		try {
			const result = await refreshTenantRates(opts.db, tenantId);
			return c.json({ ok: true, ...result });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "refresh failed" },
				502,
			);
		}
	});

	app.post("/api/admin/exchange/rate-card/preview", async (c) => {
		try {
			const proposals = await buildDefaultRateCardProposal();
			return c.json({
				ok: true,
				proposals,
				message: renderRateCardMessage(proposals),
			});
		} catch (err) {
			return c.json(
				{
					error:
						err instanceof Error ? err.message : "rate-card preview failed",
				},
				502,
			);
		}
	});

	app.post("/api/admin/exchange/rate-card/approve", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = c.var.adminId as number | undefined;
		const body = await c.req.json().catch(() => ({}));
		const proposals = Array.isArray(body?.proposals)
			? (body.proposals as RateCardProposal[])
			: await buildDefaultRateCardProposal();
		const now = Math.floor(Date.now() / 1000);

		await withTenant(opts.db, tenantId, async (tx) => {
			for (const proposal of proposals) {
				const asset = proposal.asset.trim().toUpperCase();
				const quoteMode =
					proposal.quoteMode === "divide" ? "divide" : "multiply";
				const network =
					typeof proposal.network === "string"
						? proposal.network.trim().toLowerCase()
						: "";
				const marketRate = Number(proposal.marketRate);
				if (!asset || !(marketRate > 0) || !Array.isArray(proposal.tiers))
					continue;

				await tx
					.insert(exchangeRates)
					.values({
						tenantId,
						asset,
						quoteAsset: "THB",
						network,
						baseRate: marketRate,
						quoteMode,
						marginPct: 0,
						feeFixedThb: 0,
						minAmountFrom: null,
						maxAmountFrom: null,
						isActive: true,
						autoUpdate: true,
						updatedByAdminId: adminId ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [
							exchangeRates.tenantId,
							exchangeRates.asset,
							exchangeRates.quoteAsset,
							exchangeRates.network,
						],
						set: {
							baseRate: marketRate,
							quoteMode,
							isActive: true,
							autoUpdate: true,
							updatedByAdminId: adminId ?? null,
							updatedAt: now,
						},
					});

				for (const tier of proposal.tiers) {
					const minAmount = Number(tier.minThb);
					const maxAmount = tier.maxThb === null ? null : Number(tier.maxThb);
					const displayRate = Number(tier.displayRate);
					const deviationPct = Number(tier.deviationPct);
					if (
						!(minAmount >= 0) ||
						!(displayRate > 0) ||
						!Number.isFinite(deviationPct)
					)
						continue;
					await tx
						.insert(exchangeRateTiers)
						.values({
							tenantId,
							asset,
							quoteAsset: "THB",
							network,
							rangeBasis: "target_thb",
							minAmount,
							maxAmount,
							marketRate,
							displayRate,
							deviationPct,
							formulaJson: JSON.stringify({
								source: "market_deviation",
								quoteMode,
								marketRate,
								displayRate,
								deviationPct,
								formula: tier.formula,
							}),
							isActive: true,
							approvedByAdminId: adminId ?? null,
							approvedAt: now,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [
								exchangeRateTiers.tenantId,
								exchangeRateTiers.asset,
								exchangeRateTiers.quoteAsset,
								exchangeRateTiers.network,
								exchangeRateTiers.rangeBasis,
								exchangeRateTiers.minAmount,
							],
							set: {
								maxAmount,
								marketRate,
								displayRate,
								deviationPct,
								formulaJson: JSON.stringify({
									source: "market_deviation",
									quoteMode,
									marketRate,
									displayRate,
									deviationPct,
									formula: tier.formula,
								}),
								isActive: true,
								approvedByAdminId: adminId ?? null,
								approvedAt: now,
								updatedAt: now,
							},
						});
				}
			}
		});

		opts.onReload?.(tenantId);
		return c.json({ ok: true, message: renderRateCardMessage(proposals) });
	});

	app.delete("/api/admin/exchange/rates/:id", async (c) => {
		const tenantId = c.var.tenantId;
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
		await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.delete(exchangeRates)
				.where(
					and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.id, id)),
				),
		);
		opts.onReload?.(tenantId);
		return c.json({ ok: true });
	});

	// ── Реквизиты (секреты): кошельки, Binance ID, QR/карта ────────────────────
	// GET — список сохранённых exchange_*-реквизитов с расшифрованными значениями
	// (это не секреты в строгом смысле — бот всё равно отдаёт их клиентам; нужны
	// владельцу для просмотра/проверки). Под withTenant (RLS).
	app.get("/api/admin/exchange/requisites", async (c) => {
		const tenantId = c.var.tenantId;
		const items = await withTenant(opts.db, tenantId, async (tx) => {
			const rows = await tx
				.select({ key: tenantSecrets.key })
				.from(tenantSecrets)
				.where(and(eq(tenantSecrets.tenantId, tenantId), like(tenantSecrets.key, "exchange_%")));
			const out: Array<{ key: string; value: string }> = [];
			for (const row of rows) {
				if (!isAllowedExchangeSecretKey(row.key)) continue;
				let value = "";
				try {
					value =
						(await getDecryptedSecret({
							db: tx,
							tenantId,
							key: row.key,
							masterKeyHex: opts.masterKeyHex,
						})) ?? "";
				} catch {
					value = "";
				}
				out.push({ key: row.key, value });
			}
			return out;
		});
		return c.json({ items });
	});

	// Body: { key: 'exchange_wallet_*' | 'exchange_fiat_payment_url' |
	//         'exchange_binance_id' | 'exchange_rub_card_requisites', value }
	app.post("/api/admin/exchange/requisites", async (c) => {
		const tenantId = c.var.tenantId;
		const body = await c.req.json().catch(() => ({}));
		const key = typeof body?.key === "string" ? body.key.trim() : "";
		const value = typeof body?.value === "string" ? body.value.trim() : "";
		// Реквизиты приёма + бизнес-настройки (общий allowlist — см. requisite-keys.ts).
		if (!isAllowedExchangeSecretKey(key)) {
			return c.json({ error: "bad requisites key" }, 400);
		}
		if (!value) return c.json({ error: "value required" }, 400);
		await setEncryptedSecret({
			db: opts.db,
			tenantId,
			key,
			value,
			masterKeyHex: opts.masterKeyHex,
			nowEpoch: Math.floor(Date.now() / 1000),
		});
		return c.json({ ok: true });
	});

	// ── CRM заявок ──────────────────────────────────────────────────────────────
	app.get("/api/admin/exchange/orders", async (c) => {
		const tenantId = c.var.tenantId;
		const status = c.req.query("status");
		const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
		const rows = await withTenant(opts.db, tenantId, async (tx) => {
			const where = status
				? and(
						eq(exchangeOrders.tenantId, tenantId),
						eq(exchangeOrders.status, status),
					)
				: eq(exchangeOrders.tenantId, tenantId);
			return tx
				.select()
				.from(exchangeOrders)
				.where(where)
				.orderBy(desc(exchangeOrders.id))
				.limit(limit);
		});
		return c.json({ orders: rows.map(serializeExchangeOrder) });
	});

	app.get("/api/admin/exchange/orders/:id", async (c) => {
		const tenantId = c.var.tenantId;
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
		const [row] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select()
				.from(exchangeOrders)
				.where(
					and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)),
				)
				.limit(1),
		);
		if (!row) return c.json({ error: "not found" }, 404);
		return c.json({ order: serializeExchangeOrder(row) });
	});

	// Операторские правки заявки: код выдачи, ID верификации, статус, подтверждение оплаты.
	app.patch("/api/admin/exchange/orders/:id", async (c) => {
		const tenantId = c.var.tenantId;
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
		const body = await c.req.json().catch(() => ({}));
		const now = Math.floor(Date.now() / 1000);

		const patch: Record<string, unknown> = { updatedAt: now };
		if (typeof body?.payoutCode === "string")
			patch.payoutCode = body.payoutCode.trim();
		if (typeof body?.payoutLocation === "string")
			patch.payoutLocation = body.payoutLocation.trim();
		if (typeof body?.payoutMethod === "string" || body?.payoutMethod === null)
			patch.payoutMethod =
				body.payoutMethod === null ? null : body.payoutMethod.trim();
		if (typeof body?.payoutDestinationJson === "string")
			patch.payoutDestinationJson = body.payoutDestinationJson.trim();
		if (typeof body?.verificationId === "string")
			patch.verificationId = body.verificationId.trim();
		if (typeof body?.paymentMethod === "string" || body?.paymentMethod === null)
			patch.paymentMethod =
				body.paymentMethod === null ? null : body.paymentMethod.trim();
		if (typeof body?.paymentRail === "string" || body?.paymentRail === null)
			patch.paymentRail =
				body.paymentRail === null ? null : body.paymentRail.trim();
		if (typeof body?.sourceBank === "string" || body?.sourceBank === null)
			patch.sourceBank =
				body.sourceBank === null ? null : body.sourceBank.trim();
		if (typeof body?.payerName === "string" || body?.payerName === null)
			patch.payerName = body.payerName === null ? null : body.payerName.trim();
		if (typeof body?.thirdPartyApproved === "boolean")
			patch.thirdPartyApproved = body.thirdPartyApproved;
		if (typeof body?.status === "string") {
			const allowed = [
				"quote",
				"awaiting_payment",
				"paid",
				"payout",
				"completed",
				"cancelled",
				"expired",
			];
			if (!allowed.includes(body.status))
				return c.json({ error: "bad status" }, 400);
			patch.status = body.status;
			if (body.status === "completed") patch.completedAt = now;
		}

		const [row] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.update(exchangeOrders)
				.set(patch)
				.where(
					and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)),
				)
				.returning(),
		);
		if (!row) return c.json({ error: "not found" }, 404);
		return c.json({ ok: true, order: serializeExchangeOrder(row) });
	});

	// ── Оборот (нормализовано в THB) ────────────────────────────────────────────
	app.get("/api/admin/exchange/turnover", async (c) => {
		const tenantId = c.var.tenantId;
		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const totalsRows = await tx
				.select({
					completedCount: sql<number>`count(CASE WHEN ${exchangeOrders.status} = 'completed' THEN 1 END)`,
					openCount: sql<number>`count(CASE WHEN ${exchangeOrders.status} in ('quote','awaiting_payment','paid','payout') THEN 1 END)`,
					totalThb: sql<number>`coalesce(sum(CASE WHEN ${exchangeOrders.status} = 'completed' THEN ${exchangeOrders.amountToThb} ELSE 0 END), 0)`,
				})
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantId));

			const totals = totalsRows[0] ?? {
				completedCount: 0,
				openCount: 0,
				totalThb: 0,
			};

			// Оборот по клиентам (топ).
			const byContact = await tx
				.select({
					contactId: exchangeOrders.contactId,
					telegramId: exchangeOrders.telegramId,
					orders: sql<number>`count(*)`,
					totalThb: sql<number>`coalesce(sum(CASE WHEN ${exchangeOrders.status} = 'completed' THEN ${exchangeOrders.amountToThb} ELSE 0 END), 0)`,
				})
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantId))
				.groupBy(exchangeOrders.contactId, exchangeOrders.telegramId)
				.orderBy(sql`4 desc`) // Order by totalThb (column 4)
				.limit(50);

			return { totals, byContact };
		});
		return c.json(result);
	});

	return app;
}
