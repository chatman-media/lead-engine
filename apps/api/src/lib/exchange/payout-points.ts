/**
 * Каталог точек выдачи обменника (ATM / офис / зона курьера). Чтение поверх
 * exchange_payout_points. Запись/авто-обновление (фид) — отдельным слоем (B2).
 *
 * Зачем нужен (ground-up): cardless-выдача в банкомате имеет физические
 * ограничения — шаг номинала (denomination), лимит одного снятия
 * (perWithdrawalMax), TTL кода. Расчёт под способ (B3) и маршрутизация на
 * оператора по покрытию (B4) читают точки отсюда.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangePayoutPoints } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";

export type PayoutPointKind = "atm" | "office" | "courier_zone";

export interface PayoutPoint {
  id: number;
  kind: PayoutPointKind;
  code: string;
  label: string;
  bankName: string | null;
  provider: string | null;
  quoteAsset: string;
  /** Шаг номинала банкомата (выдача округляется вниз кратно ему); null → дефолт тенанта. */
  denomination: number | null;
  /** Лимит одного cardless-снятия; выше → дробить на несколько кодов. */
  perWithdrawalMax: number | null;
  dailyMax: number | null;
  feeFixed: number;
  feePct: number;
  codeTtlSec: number | null;
  area: string | null;
  city: string | null;
  address: string | null;
}

export interface ListPayoutPointsOpts {
  kind?: PayoutPointKind;
  /** Фильтр по валюте выдачи (по умолчанию — все валюты тенанта). */
  quoteAsset?: string;
}

/** Активные точки выдачи тенанта, отсортированные по типу и названию. */
export async function listActivePayoutPoints(
  db: Db,
  tenantId: number,
  opts: ListPayoutPointsOpts = {},
): Promise<PayoutPoint[]> {
  return withTenant(db, tenantId, async (tx) => {
    const filters = [
      eq(exchangePayoutPoints.tenantId, tenantId),
      eq(exchangePayoutPoints.isActive, true),
    ];
    if (opts.kind) filters.push(eq(exchangePayoutPoints.kind, opts.kind));
    if (opts.quoteAsset) filters.push(eq(exchangePayoutPoints.quoteAsset, opts.quoteAsset));

    const rows = await tx
      .select({
        id: exchangePayoutPoints.id,
        kind: exchangePayoutPoints.kind,
        code: exchangePayoutPoints.code,
        label: exchangePayoutPoints.label,
        bankName: exchangePayoutPoints.bankName,
        provider: exchangePayoutPoints.provider,
        quoteAsset: exchangePayoutPoints.quoteAsset,
        denomination: exchangePayoutPoints.denomination,
        perWithdrawalMax: exchangePayoutPoints.perWithdrawalMax,
        dailyMax: exchangePayoutPoints.dailyMax,
        feeFixed: exchangePayoutPoints.feeFixed,
        feePct: exchangePayoutPoints.feePct,
        codeTtlSec: exchangePayoutPoints.codeTtlSec,
        area: exchangePayoutPoints.area,
        city: exchangePayoutPoints.city,
        address: exchangePayoutPoints.address,
      })
      .from(exchangePayoutPoints)
      .where(and(...filters))
      .orderBy(asc(exchangePayoutPoints.kind), asc(exchangePayoutPoints.label));

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as PayoutPointKind,
      code: r.code,
      label: r.label,
      bankName: r.bankName,
      provider: r.provider,
      quoteAsset: r.quoteAsset,
      denomination: r.denomination === null ? null : Number(r.denomination),
      perWithdrawalMax: r.perWithdrawalMax === null ? null : Number(r.perWithdrawalMax),
      dailyMax: r.dailyMax === null ? null : Number(r.dailyMax),
      feeFixed: Number(r.feeFixed),
      feePct: Number(r.feePct),
      codeTtlSec: r.codeTtlSec === null ? null : Number(r.codeTtlSec),
      area: r.area,
      city: r.city,
      address: r.address,
    }));
  });
}
