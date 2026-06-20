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
  QUOTE_CURRENCY,
  QUOTE_CURRENCY_CODES,
  setEncryptedSecret,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  admins,
  channelIdentities,
  channels,
  contacts,
  conversations,
  exchangeOrders,
  exchangePayoutPoints,
  exchangeRateProposals,
  exchangeRates,
  exchangeRateTiers,
  exchangeSettings,
  messages,
  operatorPayoutCoverage,
  operatorSettings,
  outboundQueue,
  tenantSecrets,
} from "@chatman-media/storage";
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { DEFAULT_PH_BBOX, syncOsmAtms } from "../lib/exchange/osm-sync.ts";
import {
  applyBaseRateToTiers,
  buildDefaultRateCardProposal,
  type RateCardProposal,
  rateDeviationPct,
  refreshTenantRates,
  renderRateCardMessage,
} from "../lib/exchange/rate-feed.ts";
import { applyRateDeviation, getTenantQuoteCurrency } from "../lib/exchange/rates.ts";
import {
  isAllowedExchangeSecretKey,
  isSensitiveExchangeSecretKey,
} from "../lib/exchange/requisite-keys.ts";

export interface AdminExchangeRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /** Сброс кеша resolveTools после изменения курсов/реквизитов. */
  onReload?: (tenantId: number) => void;
}

const QUOTE_MODES = ["multiply", "divide"] as const;

function roundRate(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function resolveExchangeWorkflowStage(order: typeof exchangeOrders.$inferSelect): {
  slug: string;
  label: string;
} {
  if (order.status === "cancelled") return { slug: "cancelled", label: "Отменено" };
  if (order.status === "expired") return { slug: "cancelled", label: "Истёк TTL" };
  if (order.status === "completed") {
    return { slug: "payout_or_completion", label: "Выдача / Завершено" };
  }
  if (order.status === "payout") {
    return {
      slug: "payout_or_completion",
      label: `Выдача ${QUOTE_CURRENCY.code}`,
    };
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

/** Номер паспорта наружу не отдаём целиком — только последние 4 знака. */
function maskPassportNumber(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const compact = raw.replace(/\s+/g, "");
  return compact.length <= 4 ? `••${compact}` : `•••• ${compact.slice(-4)}`;
}

/**
 * Контакт с историей KYC: статус/ID из attributes_json.exchangeKyc (пишет
 * оператор-бот при confirm) + паспортные поля из vision-OCR (photo-processor).
 */
function serializeKycContact(
  row: {
    id: number;
    displayName: string | null;
    attributesJson: string | null;
  },
  agg: { ordersCount: number; turnoverThb: number } | null,
) {
  let attrs: Record<string, unknown> = {};
  try {
    attrs = row.attributesJson ? (JSON.parse(row.attributesJson) as Record<string, unknown>) : {};
  } catch {
    attrs = {};
  }
  const kyc = (attrs.exchangeKyc ?? {}) as Record<string, unknown>;
  const verified = kyc.verified === true || attrs.isVerified === true;
  const passportName =
    [attrs.passport_family_name, attrs.passport_given_name]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ") || null;
  // Прислал документы (OCR что-то распознал), но решения оператора ещё нет.
  const hasDocuments = Boolean(passportName || attrs.passport_number || attrs.passport_expiry);
  return {
    contactId: row.id,
    displayName: row.displayName,
    verified,
    status:
      typeof kyc.status === "string"
        ? kyc.status
        : verified
          ? "verified"
          : hasDocuments
            ? "documents_received"
            : "unknown",
    verificationId: typeof kyc.verificationId === "string" ? kyc.verificationId : null,
    reviewedAt: typeof kyc.reviewedAt === "number" ? kyc.reviewedAt : null,
    reviewedByAdminId: typeof kyc.reviewedByAdminId === "number" ? kyc.reviewedByAdminId : null,
    source: typeof kyc.source === "string" ? kyc.source : null,
    passportName,
    passportNumberMasked: maskPassportNumber(attrs.passport_number),
    passportExpiry: typeof attrs.passport_expiry === "string" ? attrs.passport_expiry : null,
    ordersCount: agg?.ordersCount ?? 0,
    turnoverThb: Math.round(agg?.turnoverThb ?? 0),
  };
}

/**
 * Доставляет клиенту сообщение по заявке: пишет ассистент-реплику в беседу,
 * обновляет lastMessage и кладёт в outbound_queue для реальной отправки в канал
 * (если беседа не self_play и у контакта есть активный канал). Возвращает, было
 * ли сообщение поставлено в очередь на отправку. Это «push без поллинга»: бот
 * не опрашивает статус — оператор нажал, клиент сразу получил.
 */
async function deliverExchangeMessage(
  db: Db,
  tenantId: number,
  row: typeof exchangeOrders.$inferSelect,
  note: string,
  idempotencyKey: string,
  sentVia: string,
): Promise<boolean> {
  if (!row.conversationId) return false;
  const now = Math.floor(Date.now() / 1000);
  return withTenant(db, tenantId, async (tx) => {
    const [msg] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: row.conversationId!,
        role: "assistant",
        text: note,
        metaJson: JSON.stringify({ sentVia, orderId: row.id }),
        createdAt: now,
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastMessageText: note.slice(0, 200) })
      .where(eq(conversations.id, row.conversationId!));

    const [conv] = await tx
      .select({ source: conversations.source })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId!))
      .limit(1);
    if (conv && conv.source !== "self_play" && row.contactId) {
      const [identity] = await tx
        .select({
          channelDbId: channels.id,
          externalUserId: channelIdentities.externalUserId,
        })
        .from(channelIdentities)
        .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
        .where(and(eq(channelIdentities.contactId, row.contactId), eq(channels.status, "active")))
        .limit(1);
      if (identity) {
        await tx.insert(outboundQueue).values({
          tenantId,
          channelId: identity.channelDbId,
          conversationId: row.conversationId!,
          payloadJson: JSON.stringify({
            channelId: String(identity.channelDbId),
            externalUserId: identity.externalUserId,
            parts: [{ kind: "text", text: note }],
          }),
          idempotencyKey: `${idempotencyKey}-${msg!.id}`,
          scheduledAt: now,
          createdAt: now,
        });
        return true;
      }
    }
    return false;
  });
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

    const asset = typeof body?.asset === "string" ? body.asset.trim().toUpperCase() : "";
    if (!asset) return c.json({ error: "asset required" }, 400);
    const quoteAsset =
      typeof body?.quoteAsset === "string" && body.quoteAsset.trim()
        ? body.quoteAsset.trim().toUpperCase()
        : (await getTenantQuoteCurrency(opts.db, tenantId)).code;
    const network =
      typeof body?.network === "string" ? body.network.trim().toLowerCase().replace(/-/g, "") : "";
    const autoUpdate = !!body?.autoUpdate;
    // Для auto-курса базу заполнит рыночный фид → допускаем 0 как стартовое значение.
    const baseRate = Number.isFinite(Number(body?.baseRate)) ? Number(body.baseRate) : 0;
    if (!autoUpdate && baseRate <= 0) {
      return c.json(
        {
          error: "baseRate must be a positive number (или включите авто-курс)",
        },
        400,
      );
    }
    const quoteMode = QUOTE_MODES.includes(body?.quoteMode) ? body.quoteMode : "multiply";
    const marginPct = Number.isFinite(Number(body?.marginPct)) ? Number(body.marginPct) : 0;
    const feeFixedThb = Number.isFinite(Number(body?.feeFixedThb)) ? Number(body.feeFixedThb) : 0;
    // Save-time guardrails: не даём сохранить заведомо убыточную/абсурдную формулу.
    // Плавающую проверку «спред vs рынок» делает computeQuote (guardrails.ts) на лету.
    if (feeFixedThb < 0) {
      return c.json({ error: "fee_fixed_thb не может быть отрицательной" }, 400);
    }
    if (marginPct < 0) {
      return c.json({ error: "Маржа не может быть отрицательной — это продажа в убыток" }, 400);
    }
    if (marginPct >= 100) {
      return c.json({ error: "Маржа ≥ 100% — похоже на опечатку" }, 400);
    }
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

  // Per-tenant настройки обновления курсов (нет строки → дефолты 180с / авто-порог)
  // + котируемая валюта выдачи (quoteAsset; дефолт платформы — PHP).
  app.get("/api/admin/exchange/settings", async (c) => {
    const tenantId = c.var.tenantId;
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          rateRefreshSec: exchangeSettings.rateRefreshSec,
          feedStaleSec: exchangeSettings.feedStaleSec,
          quoteAsset: exchangeSettings.quoteAsset,
          handoffCustomerNotice: exchangeSettings.handoffCustomerNotice,
          requireRateConfirmation: exchangeSettings.requireRateConfirmation,
          roundStepAtm: exchangeSettings.roundStepAtm,
          roundStepCash: exchangeSettings.roundStepCash,
          roundStepBank: exchangeSettings.roundStepBank,
        })
        .from(exchangeSettings)
        .where(eq(exchangeSettings.tenantId, tenantId))
        .limit(1),
    );
    return c.json({
      rateRefreshSec: row?.rateRefreshSec ?? 180,
      feedStaleSec: row?.feedStaleSec ?? null,
      quoteAsset: row?.quoteAsset ?? QUOTE_CURRENCY.code,
      quoteAssetOptions: QUOTE_CURRENCY_CODES,
      handoffCustomerNotice: row?.handoffCustomerNotice ?? true,
      requireRateConfirmation: row?.requireRateConfirmation ?? false,
      roundStepAtm: row?.roundStepAtm ?? null,
      roundStepCash: row?.roundStepCash ?? null,
      roundStepBank: row?.roundStepBank ?? null,
    });
  });

  // Сохранить: rateRefreshSec (сек, 60..86400) + feedStaleSec (сек, ≥ refresh или
  // пусто = авто) + quoteAsset (ISO-код котируемой валюты). Планировщик (api),
  // ops-watch (worker) и расчёт котировок читают это per-tenant.
  app.put("/api/admin/exchange/settings", async (c) => {
    const tenantId = c.var.tenantId;
    const body = await c.req.json().catch(() => ({}));

    const refresh = Math.floor(Number(body?.rateRefreshSec));
    if (!Number.isFinite(refresh) || refresh < 60 || refresh > 86400) {
      return c.json({ error: "rateRefreshSec должен быть 60..86400 секунд" }, 400);
    }
    let stale: number | null = null;
    if (body?.feedStaleSec != null && body.feedStaleSec !== "") {
      stale = Math.floor(Number(body.feedStaleSec));
      if (!Number.isFinite(stale) || stale < refresh) {
        return c.json(
          {
            error: "feedStaleSec должен быть ≥ rateRefreshSec (или пусто = авто)",
          },
          400,
        );
      }
    }
    const quoteAssetRaw =
      typeof body?.quoteAsset === "string" && body.quoteAsset.trim()
        ? body.quoteAsset.trim().toUpperCase()
        : QUOTE_CURRENCY.code;
    if (!/^[A-Z]{3}$/.test(quoteAssetRaw)) {
      return c.json({ error: "quoteAsset должен быть ISO-кодом валюты (PHP, THB…)" }, 400);
    }
    const handoffCustomerNotice = body?.handoffCustomerNotice !== false;
    // Тумблер «требовать подтверждение оператором при обновлении базового курса»
    // (даже мелких тиков). Дефолт false — back-compat.
    const requireRateConfirmation = body?.requireRateConfirmation === true;
    // Шаги округления котировки (floor) по способу выдачи. null = авто из словаря валют.
    function parseStep(val: unknown, field: string) {
      if (val == null || val === "") return null;
      const n = Math.floor(Number(val));
      if (!Number.isFinite(n) || n < 1) throw new Error(`${field} должен быть ≥ 1`);
      return n;
    }
    let roundStepAtm: number | null;
    let roundStepCash: number | null;
    let roundStepBank: number | null;
    try {
      roundStepAtm = parseStep(body?.roundStepAtm, "roundStepAtm");
      roundStepCash = parseStep(body?.roundStepCash, "roundStepCash");
      roundStepBank = parseStep(body?.roundStepBank, "roundStepBank");
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(exchangeSettings)
        .values({
          tenantId,
          rateRefreshSec: refresh,
          feedStaleSec: stale,
          quoteAsset: quoteAssetRaw,
          handoffCustomerNotice,
          requireRateConfirmation,
          roundStepAtm,
          roundStepCash,
          roundStepBank,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: exchangeSettings.tenantId,
          set: {
            rateRefreshSec: refresh,
            feedStaleSec: stale,
            quoteAsset: quoteAssetRaw,
            handoffCustomerNotice,
            requireRateConfirmation,
            roundStepAtm,
            roundStepCash,
            roundStepBank,
            updatedAt: now,
          },
        })
        .returning({
          rateRefreshSec: exchangeSettings.rateRefreshSec,
          feedStaleSec: exchangeSettings.feedStaleSec,
          quoteAsset: exchangeSettings.quoteAsset,
          handoffCustomerNotice: exchangeSettings.handoffCustomerNotice,
          requireRateConfirmation: exchangeSettings.requireRateConfirmation,
          roundStepAtm: exchangeSettings.roundStepAtm,
          roundStepCash: exchangeSettings.roundStepCash,
          roundStepBank: exchangeSettings.roundStepBank,
        }),
    );
    return c.json({ ok: true, settings: row });
  });

  // ── Pending-предложения обновления курса (issue #732) ──────────────────────
  // Когда фид находит отклонение в диапазоне soft..hard или включён тумблер
  // require_rate_confirmation — base_rate не меняется, а кладётся предложение.
  // Жёсткое отклонение (> hard) даёт ещё и rate_anomaly + sanity-guard'ом
  // замораживает курс. Confirm применяет предложенный курс к exchange_rates
  // и пересчитывает тиры (общая функция applyBaseRateToTiers). Reject оставляет
  // текущий курс. Идемпотентность повторного клика — 409 (status != pending).
  app.get("/api/admin/exchange/rate-proposals", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(exchangeRateProposals)
        .where(
          and(
            eq(exchangeRateProposals.tenantId, tenantId),
            eq(exchangeRateProposals.status, "pending"),
          ),
        )
        .orderBy(desc(exchangeRateProposals.createdAt)),
    );
    return c.json({ proposals: rows });
  });

  app.post("/api/admin/exchange/rate-proposals/:id/confirm", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "bad id" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [proposal] = await tx
        .select()
        .from(exchangeRateProposals)
        .where(and(eq(exchangeRateProposals.tenantId, tenantId), eq(exchangeRateProposals.id, id)))
        .limit(1);
      if (!proposal) return { kind: "not_found" as const };
      if (proposal.status !== "pending") {
        return { kind: "not_pending" as const, status: proposal.status };
      }
      // Сверка гонки фид↔confirm: применяем next из снапшота, но только если
      // активный baseRate не сдвинулся за это время. Если сдвинулся → 409 stale.
      const [activeRate] = await tx
        .select({ id: exchangeRates.id, baseRate: exchangeRates.baseRate })
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.tenantId, tenantId),
            eq(exchangeRates.asset, proposal.asset),
            eq(exchangeRates.quoteAsset, proposal.quoteAsset),
            eq(exchangeRates.network, proposal.network),
          ),
        )
        .limit(1);
      if (!activeRate) return { kind: "rate_missing" as const };
      const currentBase = Number(activeRate.baseRate);
      const snapshotPrev = Number(proposal.prevBaseRate);
      // Сравниваем с допуском (база — double precision); 1e-9 — численный шум.
      if (Math.abs(currentBase - snapshotPrev) > 1e-9) {
        return {
          kind: "stale" as const,
          currentBaseRate: currentBase,
          snapshotPrev,
        };
      }
      // Применяем next к exchange_rates и пересчитываем тиры — общая функция,
      // чтобы публичная rate-card не разошлась с базой (issue #732, тиры).
      await applyBaseRateToTiers(
        tx,
        tenantId,
        {
          rateId: activeRate.id,
          asset: proposal.asset,
          quoteAsset: proposal.quoteAsset,
          network: proposal.network,
          quoteMode: proposal.quoteMode,
          baseRate: Number(proposal.nextBaseRate),
        },
        now,
      );
      const [updated] = await tx
        .update(exchangeRateProposals)
        .set({
          status: "confirmed",
          decidedByAdminId: adminId ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(exchangeRateProposals.tenantId, tenantId), eq(exchangeRateProposals.id, id)))
        .returning();
      return { kind: "ok" as const, proposal: updated };
    });
    if (result.kind === "not_found") {
      return c.json({ error: "not found" }, 404);
    }
    if (result.kind === "rate_missing") {
      return c.json({ error: "exchange rate row missing" }, 409);
    }
    if (result.kind === "not_pending") {
      return c.json({ error: "proposal already decided", status: result.status }, 409);
    }
    if (result.kind === "stale") {
      return c.json(
        {
          error: "stale: baseRate moved since proposal was created",
          currentBaseRate: result.currentBaseRate,
          snapshotPrev: result.snapshotPrev,
        },
        409,
      );
    }
    await recordAudit(opts.db, {
      tenantId,
      ...(adminId !== undefined ? { adminId } : {}),
      action: "exchange.rate_proposal.confirm",
      targetKind: "exchange_rate_proposal",
      targetId: id,
      details: {
        asset: result.proposal?.asset ?? null,
        quoteAsset: result.proposal?.quoteAsset ?? null,
        network: result.proposal?.network ?? null,
        prev: result.proposal?.prevBaseRate ?? null,
        next: result.proposal?.nextBaseRate ?? null,
      },
    });
    opts.onReload?.(tenantId);
    return c.json({ ok: true, proposal: result.proposal });
  });

  app.post("/api/admin/exchange/rate-proposals/:id/reject", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "bad id" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [proposal] = await tx
        .select()
        .from(exchangeRateProposals)
        .where(and(eq(exchangeRateProposals.tenantId, tenantId), eq(exchangeRateProposals.id, id)))
        .limit(1);
      if (!proposal) return { kind: "not_found" as const };
      if (proposal.status !== "pending") {
        return { kind: "not_pending" as const, status: proposal.status };
      }
      const [updated] = await tx
        .update(exchangeRateProposals)
        .set({
          status: "rejected",
          decidedByAdminId: adminId ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(exchangeRateProposals.tenantId, tenantId), eq(exchangeRateProposals.id, id)))
        .returning();
      return { kind: "ok" as const, proposal: updated };
    });
    if (result.kind === "not_found") return c.json({ error: "not found" }, 404);
    if (result.kind === "not_pending") {
      return c.json({ error: "proposal already decided", status: result.status }, 409);
    }
    await recordAudit(opts.db, {
      tenantId,
      ...(adminId !== undefined ? { adminId } : {}),
      action: "exchange.rate_proposal.reject",
      targetKind: "exchange_rate_proposal",
      targetId: id,
      details: {
        asset: result.proposal?.asset ?? null,
        quoteAsset: result.proposal?.quoteAsset ?? null,
        network: result.proposal?.network ?? null,
      },
    });
    return c.json({ ok: true, proposal: result.proposal });
  });

  app.post("/api/admin/exchange/rate-card/preview", async (c) => {
    try {
      const currency = await getTenantQuoteCurrency(opts.db, c.var.tenantId);
      const proposals = await buildDefaultRateCardProposal(currency);
      return c.json({
        ok: true,
        proposals,
        message: renderRateCardMessage(proposals, currency),
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "rate-card preview failed",
        },
        502,
      );
    }
  });

  app.post("/api/admin/exchange/rate-card/approve", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json().catch(() => ({}));
    const currency = await getTenantQuoteCurrency(opts.db, tenantId);
    const proposals = Array.isArray(body?.proposals)
      ? (body.proposals as RateCardProposal[])
      : await buildDefaultRateCardProposal(currency);
    const now = Math.floor(Date.now() / 1000);
    const normalizedProposals: RateCardProposal[] = [];

    await withTenant(opts.db, tenantId, async (tx) => {
      for (const proposal of proposals) {
        const asset = proposal.asset.trim().toUpperCase();
        const quoteMode = proposal.quoteMode === "divide" ? "divide" : "multiply";
        const network =
          typeof proposal.network === "string" ? proposal.network.trim().toLowerCase() : "";
        const marketRate = Number(proposal.marketRate);
        if (!asset || !(marketRate > 0) || !Array.isArray(proposal.tiers)) continue;
        const normalizedTiers: RateCardProposal["tiers"] = [];

        await tx
          .insert(exchangeRates)
          .values({
            tenantId,
            asset,
            quoteAsset: currency.code,
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
          const rawDeviationPct = Number((tier as { deviationPct?: unknown }).deviationPct);
          const rawDisplayRate = Number((tier as { displayRate?: unknown }).displayRate);
          const deviationPct = Number.isFinite(rawDeviationPct)
            ? roundRate(rawDeviationPct, 8)
            : rateDeviationPct(marketRate, rawDisplayRate, 8);
          const displayRate = Number.isFinite(rawDeviationPct)
            ? roundRate(applyRateDeviation(marketRate, deviationPct))
            : rawDisplayRate;
          if (!(minAmount >= 0) || !(displayRate > 0)) continue;
          const formula =
            typeof tier.formula === "string" && tier.formula.trim()
              ? tier.formula
              : `${marketRate} ${deviationPct >= 0 ? "+" : "-"} ${Math.abs(
                  deviationPct,
                )}% = ${displayRate}`;
          normalizedTiers.push({
            minThb: minAmount,
            maxThb: maxAmount,
            displayRate,
            deviationPct,
            formula,
          });
          await tx
            .insert(exchangeRateTiers)
            .values({
              tenantId,
              asset,
              quoteAsset: currency.code,
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
                formula,
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
                  formula,
                }),
                isActive: true,
                approvedByAdminId: adminId ?? null,
                approvedAt: now,
                updatedAt: now,
              },
            });
        }
        if (normalizedTiers.length > 0) {
          normalizedProposals.push({
            asset,
            network,
            quoteMode,
            marketRate,
            tiers: normalizedTiers,
            message: "",
          });
        }
      }
    });

    opts.onReload?.(tenantId);
    return c.json({
      ok: true,
      message: renderRateCardMessage(normalizedProposals, currency),
    });
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
      const out: Array<{
        key: string;
        value: string;
        hasValue?: boolean;
        sensitive?: boolean;
      }> = [];
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
        if (isSensitiveExchangeSecretKey(row.key)) {
          out.push({
            key: row.key,
            value: "",
            hasValue: value.length > 0,
            sensitive: true,
          });
          continue;
        }
        out.push({ key: row.key, value });
      }
      return out;
    });
    return c.json({ items });
  });

  // Body: { key: 'exchange_wallet_*' | exchange requisite/business/provider key, value }
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
        ? and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.status, status))
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
        .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)))
        .limit(1),
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ order: serializeExchangeOrder(row) });
  });

  // ── Реестр верификаций (KYC) ───────────────────────────────────────────
  // Контакты с историей KYC (#511): решение оператора (exchangeKyc) ИЛИ
  // присланные документы без решения (passport_* из vision-OCR). Номер
  // паспорта — маскированный; плюс заявки и оборот по каждому клиенту.
  app.get("/api/admin/exchange/kyc-contacts", async (c) => {
    const tenantId = c.var.tenantId;
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);

    const page = await withTenant(opts.db, tenantId, async (tx) => {
      const searchFilter = q
        ? or(
            ilike(contacts.displayName, `%${q}%`),
            sql`lower(coalesce(${contacts.attributesJson}, '')) like ${`%${q}%`}`,
          )
        : undefined;
      const rows = await tx
        .select({
          id: contacts.id,
          displayName: contacts.displayName,
          attributesJson: contacts.attributesJson,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            or(
              like(contacts.attributesJson, '%"exchangeKyc"%'),
              like(contacts.attributesJson, '%"passport_number"%'),
            ),
            searchFilter,
          ),
        )
        .orderBy(desc(contacts.updatedAt))
        .limit(limit + 1)
        .offset(offset);
      if (rows.length === 0) return { items: [], nextOffset: null };
      const pageRows = rows.slice(0, limit);

      const agg = await tx
        .select({
          contactId: exchangeOrders.contactId,
          ordersCount: sql<number>`count(*)::int`,
          turnoverThb: sql<number>`coalesce(sum(${exchangeOrders.amountToThb}) filter (where ${exchangeOrders.status} = 'completed'), 0)::float`,
        })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.tenantId, tenantId),
            inArray(
              exchangeOrders.contactId,
              pageRows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(exchangeOrders.contactId);
      const byContact = new Map(agg.map((a) => [a.contactId, a]));
      return {
        items: pageRows.map((r) => serializeKycContact(r, byContact.get(r.id) ?? null)),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    });

    return c.json({
      contacts: page.items,
      limit,
      offset,
      nextOffset: page.nextOffset,
    });
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
    if (typeof body?.payoutMethod === "string" || body?.payoutMethod === null)
      patch.payoutMethod = body.payoutMethod === null ? null : body.payoutMethod.trim();
    if (typeof body?.payoutDestinationJson === "string")
      patch.payoutDestinationJson = body.payoutDestinationJson.trim();
    if (typeof body?.verificationId === "string") patch.verificationId = body.verificationId.trim();
    if (typeof body?.paymentMethod === "string" || body?.paymentMethod === null)
      patch.paymentMethod = body.paymentMethod === null ? null : body.paymentMethod.trim();
    if (typeof body?.paymentRail === "string" || body?.paymentRail === null)
      patch.paymentRail = body.paymentRail === null ? null : body.paymentRail.trim();
    if (typeof body?.sourceBank === "string" || body?.sourceBank === null)
      patch.sourceBank = body.sourceBank === null ? null : body.sourceBank.trim();
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

    // Last mile: при смене статуса оператором — сообщаем клиенту в чат
    // (оплата подтверждена / выдача / завершено / отмена). Иначе клиент
    // «висит» — бот сам про операторское решение не узнаёт.
    if (typeof body?.status === "string" && row.conversationId) {
      const thb = row.amountToThb ? Math.round(Number(row.amountToThb)) : null;
      // Валюта — из направления заявки ("USDT->PHP"), не из платформенного дефолта.
      const orderQuote = row.direction?.split("->")[1] || QUOTE_CURRENCY.code;
      const note =
        row.status === "paid"
          ? "✅ Оплата получена и подтверждена. Готовим выдачу."
          : row.status === "payout"
            ? "💸 Выдача в работе — скоро пришлём детали получения."
            : row.status === "completed"
              ? `🎉 Обмен завершён!${thb ? ` Вы получаете ${thb} ${orderQuote}.` : ""}` +
                `${row.payoutCode ? ` Код выдачи: ${row.payoutCode}.` : ""}` +
                `${row.payoutLocation ? ` Место: ${row.payoutLocation}.` : ""}`
              : row.status === "cancelled"
                ? "Заявка отменена. Если это ошибка — напишите нам, поможем."
                : null;
      if (note) {
        await withTenant(opts.db, tenantId, async (tx) => {
          const [msg] = await tx
            .insert(messages)
            .values({
              tenantId,
              conversationId: row.conversationId!,
              role: "assistant",
              text: note,
              metaJson: JSON.stringify({
                sentVia: "exchange-status",
                status: row.status,
              }),
              createdAt: now,
            })
            .returning({ id: messages.id });
          await tx
            .update(conversations)
            .set({ lastMessageAt: now, lastMessageText: note.slice(0, 200) })
            .where(eq(conversations.id, row.conversationId!));

          const [conv] = await tx
            .select({ source: conversations.source })
            .from(conversations)
            .where(eq(conversations.id, row.conversationId!))
            .limit(1);
          if (conv && conv.source !== "self_play" && row.contactId) {
            const [identity] = await tx
              .select({
                channelDbId: channels.id,
                externalUserId: channelIdentities.externalUserId,
              })
              .from(channelIdentities)
              .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
              .where(
                and(eq(channelIdentities.contactId, row.contactId), eq(channels.status, "active")),
              )
              .limit(1);
            if (identity) {
              await tx.insert(outboundQueue).values({
                tenantId,
                channelId: identity.channelDbId,
                conversationId: row.conversationId!,
                payloadJson: JSON.stringify({
                  channelId: String(identity.channelDbId),
                  externalUserId: identity.externalUserId,
                  parts: [{ kind: "text", text: note }],
                }),
                idempotencyKey: `exch-status-${row.id}-${row.status}-${msg!.id}`,
                scheduledAt: now,
                createdAt: now,
              });
            }
          }
        });
      }
    }

    return c.json({ ok: true, order: serializeExchangeOrder(row) });
  });

  /**
   * POST /api/admin/exchange/orders/:id/issue-payout-code
   * Операторская «выдача кода» одной кнопкой: задаёт код (или генерирует),
   * опц. место/метод выдачи и TTL, переводит paid→payout и СРАЗУ доставляет
   * код клиенту в чат (без поллинга ботом). Тело:
   *   { payoutCode?, generate?, payoutLocation?, payoutMethod?, ttlMinutes? }
   */
  app.post("/api/admin/exchange/orders/:id/issue-payout-code", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const now = Math.floor(Date.now() / 1000);

    const provided =
      typeof body?.payoutCode === "string" && body.payoutCode.trim()
        ? body.payoutCode.trim()
        : null;
    const code =
      provided ??
      (body?.generate === true
        ? `CODE-${id}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`
        : null);
    if (!code) return c.json({ error: "payoutCode required (or pass generate:true)" }, 400);

    const ttlMinutes =
      typeof body?.ttlMinutes === "number" && body.ttlMinutes > 0
        ? Math.floor(body.ttlMinutes)
        : null;
    const expiresAt = ttlMinutes ? now + ttlMinutes * 60 : null;

    const patch: Record<string, unknown> = {
      payoutCode: code,
      payoutCodeExpiresAt: expiresAt,
      updatedAt: now,
    };
    if (typeof body?.payoutLocation === "string") patch.payoutLocation = body.payoutLocation.trim();
    if (typeof body?.payoutMethod === "string") patch.payoutMethod = body.payoutMethod.trim();

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(exchangeOrders)
        .set(patch)
        .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)))
        .returning(),
    );
    if (!row) return c.json({ error: "not found" }, 404);

    // paid → payout: двигаем статус, раз код выдан.
    if (row.status === "paid") {
      await withTenant(opts.db, tenantId, async (tx) =>
        tx
          .update(exchangeOrders)
          .set({ status: "payout", updatedAt: now })
          .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id))),
      );
      row.status = "payout";
    }

    const loc = row.payoutLocation ? ` Место: ${row.payoutLocation}.` : "";
    const ttlNote = ttlMinutes ? ` Код действует ${ttlMinutes} мин.` : "";
    const note = `🔐 Код выдачи: ${code}.${loc}${ttlNote}`;
    const delivered = await deliverExchangeMessage(
      opts.db,
      tenantId,
      row,
      note,
      `exch-payout-code-${row.id}`,
      "exchange-payout-code",
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "exchange.payout_code_issued",
      targetKind: "exchange_order",
      targetId: String(id),
      details: { generated: !provided, ttlMinutes, delivered },
    });

    return c.json({
      ok: true,
      payoutCode: code,
      expiresAt,
      delivered,
      order: serializeExchangeOrder(row),
    });
  });

  /**
   * POST /api/admin/exchange/orders/:id/confirm-payment
   * Оператор подтверждает фиат-оплату (verify_exchange_payment по RUB/EUR не
   * может проверить ончейн и возвращает needsOperator). Переводит заявку в
   * paid и сразу сообщает клиенту, что оплата принята и готовится выдача —
   * клиент не «висит». Дальше оператор выдаёт код (issue-payout-code).
   */
  app.post("/api/admin/exchange/orders/:id/confirm-payment", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const now = Math.floor(Date.now() / 1000);

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(exchangeOrders)
        .set({ status: "paid", updatedAt: now })
        .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, id)))
        .returning(),
    );
    if (!row) return c.json({ error: "not found" }, 404);

    const custom = typeof body?.text === "string" && body.text.trim() ? body.text.trim() : null;
    const note = custom ?? "✅ Оплата получена и подтверждена. Готовим выдачу.";
    const delivered = await deliverExchangeMessage(
      opts.db,
      tenantId,
      row,
      note,
      `exch-pay-confirm-${row.id}`,
      "exchange-payment-confirmed",
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "exchange.payment_confirmed",
      targetKind: "exchange_order",
      targetId: String(id),
      details: { delivered, custom: !!custom },
    });

    return c.json({ ok: true, delivered, order: serializeExchangeOrder(row) });
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

  // ─── Точки выдачи (exchange_payout_points) ─────────────────────────────────
  // GET /api/admin/exchange/payout-points
  app.get("/api/admin/exchange/payout-points", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select()
        .from(exchangePayoutPoints)
        .where(eq(exchangePayoutPoints.tenantId, tenantId))
        .orderBy(asc(exchangePayoutPoints.kind), asc(exchangePayoutPoints.label));
    });
    return c.json({ points: rows });
  });

  // POST /api/admin/exchange/payout-points
  app.post("/api/admin/exchange/payout-points", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<{
      kind: string;
      code: string;
      label: string;
      bankName?: string | null;
      quoteAsset: string;
      denomination?: number | null;
      perWithdrawalMax?: number | null;
      feeFixed?: number;
      feePct?: number;
      codeTtlSec?: number | null;
      city?: string | null;
      address?: string | null;
      isActive?: boolean;
    }>();
    const now = Math.floor(Date.now() / 1000);
    const [point] = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .insert(exchangePayoutPoints)
        .values({
          tenantId,
          kind: body.kind as "atm" | "office" | "courier_zone",
          code: body.code,
          label: body.label,
          bankName: body.bankName ?? null,
          quoteAsset: body.quoteAsset,
          denomination: body.denomination ?? null,
          perWithdrawalMax: body.perWithdrawalMax ?? null,
          feeFixed: body.feeFixed ?? 0,
          feePct: body.feePct ?? 0,
          codeTtlSec: body.codeTtlSec ?? null,
          city: body.city ?? null,
          address: body.address ?? null,
          isActive: body.isActive ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    });
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "exchange.payout_point_created",
      details: { payoutPointId: point?.id, code: body.code },
    });
    return c.json({ ok: true, point });
  });

  // PATCH /api/admin/exchange/payout-points/:id
  app.patch("/api/admin/exchange/payout-points/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    const body =
      await c.req.json<
        Partial<{
          label: string;
          bankName: string | null;
          denomination: number | null;
          perWithdrawalMax: number | null;
          feeFixed: number;
          feePct: number;
          codeTtlSec: number | null;
          city: string | null;
          address: string | null;
          isActive: boolean;
        }>
      >();
    const now = Math.floor(Date.now() / 1000);
    const [updated] = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .update(exchangePayoutPoints)
        .set({ ...body, updatedAt: now })
        .where(and(eq(exchangePayoutPoints.tenantId, tenantId), eq(exchangePayoutPoints.id, id)))
        .returning();
    });
    if (!updated) return c.json({ ok: false, error: "not_found" }, 404);
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "exchange.payout_point_updated",
      details: { payoutPointId: id },
    });
    return c.json({ ok: true, point: updated });
  });

  // DELETE /api/admin/exchange/payout-points/:id
  app.delete("/api/admin/exchange/payout-points/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    const now = Math.floor(Date.now() / 1000);
    const [deactivated] = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .update(exchangePayoutPoints)
        .set({ isActive: false, updatedAt: now })
        .where(and(eq(exchangePayoutPoints.tenantId, tenantId), eq(exchangePayoutPoints.id, id)))
        .returning({ id: exchangePayoutPoints.id });
    });
    if (!deactivated) return c.json({ ok: false, error: "not_found" }, 404);
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "exchange.payout_point_deleted",
      details: { payoutPointId: id },
    });
    return c.json({ ok: true });
  });

  // GET /api/admin/exchange/payout-points/:id/coverage
  app.get("/api/admin/exchange/payout-points/:id/coverage", async (c) => {
    const tenantId = c.var.tenantId;
    const pointId = Number(c.req.param("id"));
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          adminId: operatorPayoutCoverage.adminId,
          name: admins.name,
          email: admins.email,
        })
        .from(operatorPayoutCoverage)
        .innerJoin(admins, eq(admins.id, operatorPayoutCoverage.adminId))
        .where(
          and(
            eq(operatorPayoutCoverage.tenantId, tenantId),
            eq(operatorPayoutCoverage.payoutPointId, pointId),
          ),
        );
    });
    // All operators with operatorSettings (candidates pool)
    const allOps = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({ adminId: operatorSettings.adminId, name: admins.name, email: admins.email })
        .from(operatorSettings)
        .innerJoin(admins, eq(admins.id, operatorSettings.adminId))
        .where(eq(operatorSettings.tenantId, tenantId));
    });
    const coveringIds = new Set(rows.map((r) => r.adminId));
    return c.json({
      operators: allOps.map((op) => ({
        adminId: op.adminId,
        name: op.name,
        email: op.email,
        covering: coveringIds.has(op.adminId),
      })),
    });
  });

  // POST /api/admin/exchange/payout-points/:id/coverage
  app.post("/api/admin/exchange/payout-points/:id/coverage", async (c) => {
    const tenantId = c.var.tenantId;
    const actorId = c.var.adminId as number | undefined;
    const pointId = Number(c.req.param("id"));
    const body = await c.req.json<{ adminId: number }>();
    const now = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      await tx
        .insert(operatorPayoutCoverage)
        .values({ tenantId, adminId: body.adminId, payoutPointId: pointId, createdAt: now })
        .onConflictDoNothing();
    });
    await recordAudit(opts.db, {
      tenantId,
      adminId: actorId,
      action: "exchange.coverage_added",
      details: { payoutPointId: pointId, operatorAdminId: body.adminId },
    });
    return c.json({ ok: true });
  });

  // POST /api/admin/exchange/payout-points/sync-osm
  app.post("/api/admin/exchange/payout-points/sync-osm", async (c) => {
    const tenantId = c.var.tenantId;
    const body = await c.req.json<{ bbox?: string; quoteAsset?: string }>().catch(() => ({}));
    const result = await syncOsmAtms(opts.db, tenantId, {
      bbox: body.bbox ?? DEFAULT_PH_BBOX,
      quoteAsset: body.quoteAsset ?? "PHP",
    });
    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId as number | undefined,
      action: "exchange.osm_sync",
      details: result,
    });
    return c.json({ ok: true, ...result });
  });

  // DELETE /api/admin/exchange/payout-points/:id/coverage/:adminId
  app.delete("/api/admin/exchange/payout-points/:id/coverage/:adminId", async (c) => {
    const tenantId = c.var.tenantId;
    const actorId = c.var.adminId as number | undefined;
    const pointId = Number(c.req.param("id"));
    const targetAdminId = Number(c.req.param("adminId"));
    await withTenant(opts.db, tenantId, async (tx) => {
      await tx
        .delete(operatorPayoutCoverage)
        .where(
          and(
            eq(operatorPayoutCoverage.tenantId, tenantId),
            eq(operatorPayoutCoverage.payoutPointId, pointId),
            eq(operatorPayoutCoverage.adminId, targetAdminId),
          ),
        );
    });
    await recordAudit(opts.db, {
      tenantId,
      adminId: actorId,
      action: "exchange.coverage_removed",
      details: { payoutPointId: pointId, operatorAdminId: targetAdminId },
    });
    return c.json({ ok: true });
  });

  return app;
}
