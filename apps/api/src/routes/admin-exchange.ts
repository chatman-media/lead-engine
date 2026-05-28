/**
 * Админка обменника: курсы/формулы (п.21), CRM заявок (п.18-19), оборот (п.17),
 * реквизиты-секреты (кошельки / платёжная ссылка для PaymentProvider).
 *
 * Все запросы к exchange_* идут через withTenant (RLS FORCE).
 * onReload(tenantId) сбрасывает кеш resolveTools (вкл/выкл exchange-tools).
 */

import { type Db, setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import { exchangeOrders, exchangeRates } from "@chatman-media/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { refreshTenantRates } from "../lib/exchange/rate-feed.ts";

export interface AdminExchangeRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /** Сброс кеша resolveTools после изменения курсов/реквизитов. */
  onReload?: (tenantId: number) => void;
}

const QUOTE_MODES = ["multiply", "divide"] as const;

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

    const asset = typeof body?.asset === "string" ? body.asset.trim().toUpperCase() : "";
    if (!asset) return c.json({ error: "asset required" }, 400);
    const quoteAsset =
      typeof body?.quoteAsset === "string" && body.quoteAsset.trim()
        ? body.quoteAsset.trim().toUpperCase()
        : "THB";
    const network =
      typeof body?.network === "string" ? body.network.trim().toLowerCase().replace(/-/g, "") : "";
    const autoUpdate = !!body?.autoUpdate;
    // Для auto-курса базу заполнит рыночный фид → допускаем 0 как стартовое значение.
    const baseRate = Number.isFinite(Number(body?.baseRate)) ? Number(body.baseRate) : 0;
    if (!autoUpdate && baseRate <= 0) {
      return c.json({ error: "baseRate must be a positive number (или включите авто-курс)" }, 400);
    }
    const quoteMode = QUOTE_MODES.includes(body?.quoteMode) ? body.quoteMode : "multiply";
    const marginPct = Number.isFinite(Number(body?.marginPct)) ? Number(body.marginPct) : 0;
    const feeFixedThb = Number.isFinite(Number(body?.feeFixedThb)) ? Number(body.feeFixedThb) : 0;
    const minAmountFrom =
      body?.minAmountFrom == null || body.minAmountFrom === "" ? null : Number(body.minAmountFrom);
    const maxAmountFrom =
      body?.maxAmountFrom == null || body.maxAmountFrom === "" ? null : Number(body.maxAmountFrom);
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
      return c.json({ error: err instanceof Error ? err.message : "refresh failed" }, 502);
    }
  });

  app.delete("/api/admin/exchange/rates/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(exchangeRates)
        .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.id, id))),
    );
    opts.onReload?.(tenantId);
    return c.json({ ok: true });
  });

  // ── Реквизиты (секреты): кошельки и платёжная ссылка ────────────────────────
  // Body: { key: 'exchange_wallet_usdt_trc20' | 'exchange_fiat_payment_url', value }
  app.post("/api/admin/exchange/requisites", async (c) => {
    const tenantId = c.var.tenantId;
    const body = await c.req.json().catch(() => ({}));
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (!key.startsWith("exchange_wallet_") && key !== "exchange_fiat_payment_url") {
      return c.json({ error: "key must be exchange_wallet_* or exchange_fiat_payment_url" }, 400);
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
        ? and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.status, status))
        : eq(exchangeOrders.tenantId, tenantId);
      return tx
        .select()
        .from(exchangeOrders)
        .where(where)
        .orderBy(desc(exchangeOrders.id))
        .limit(limit);
    });
    return c.json({ orders: rows });
  });

  app.get("/api/admin/exchange/orders/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(exchangeOrders)
        .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)))
        .limit(1),
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ order: row });
  });

  // Операторские правки заявки: код выдачи, ID верификации, статус, подтверждение оплаты.
  app.patch("/api/admin/exchange/orders/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const now = Math.floor(Date.now() / 1000);

    const patch: Record<string, unknown> = { updatedAt: now };
    if (typeof body?.payoutCode === "string") patch.payoutCode = body.payoutCode.trim();
    if (typeof body?.payoutLocation === "string") patch.payoutLocation = body.payoutLocation.trim();
    if (typeof body?.payoutMethod === "string") patch.payoutMethod = body.payoutMethod.trim();
    if (typeof body?.verificationId === "string") patch.verificationId = body.verificationId.trim();
    if (typeof body?.status === "string") {
      const allowed = ["quote", "awaiting_payment", "paid", "payout", "completed", "cancelled", "expired"];
      if (!allowed.includes(body.status)) return c.json({ error: "bad status" }, 400);
      patch.status = body.status;
      if (body.status === "completed") patch.completedAt = now;
    }

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(exchangeOrders)
        .set(patch)
        .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)))
        .returning(),
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, order: row });
  });

  // ── Оборот (нормализовано в THB) ────────────────────────────────────────────
  app.get("/api/admin/exchange/turnover", async (c) => {
    const tenantId = c.var.tenantId;
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [totals] = await tx
        .select({
          completedCount: sql<number>`count(*) filter (where ${exchangeOrders.status} = 'completed')`,
          openCount: sql<number>`count(*) filter (where ${exchangeOrders.status} in ('quote','awaiting_payment','paid','payout'))`,
          totalThb: sql<number>`coalesce(sum(${exchangeOrders.amountToThb}) filter (where ${exchangeOrders.status} = 'completed'), 0)`,
        })
        .from(exchangeOrders)
        .where(eq(exchangeOrders.tenantId, tenantId));

      // Оборот по клиентам (топ).
      const byContact = await tx
        .select({
          contactId: exchangeOrders.contactId,
          telegramId: exchangeOrders.telegramId,
          orders: sql<number>`count(*)`,
          totalThb: sql<number>`coalesce(sum(${exchangeOrders.amountToThb}) filter (where ${exchangeOrders.status} = 'completed'), 0)`,
        })
        .from(exchangeOrders)
        .where(eq(exchangeOrders.tenantId, tenantId))
        .groupBy(exchangeOrders.contactId, exchangeOrders.telegramId)
        .orderBy(sql`2 desc`)
        .limit(50);

      return { totals, byContact };
    });
    return c.json(result);
  });

  return app;
}
