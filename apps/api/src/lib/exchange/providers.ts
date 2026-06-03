/**
 * Абстракция провайдера реквизитов (п.12 ТЗ). Источник реквизитов «пока не решён»,
 * поэтому всё спрятано за интерфейсом PaymentProvider — позже легко подключить
 * партнёрский API, не трогая бота/инструменты.
 *
 * Дефолтная реализация ConfigPaymentProvider берёт реквизиты из tenant_secrets:
 *   - крипта: ключ `exchange_wallet_<asset>_<network>` (напр. exchange_wallet_usdt_trc20) → адрес;
 *   - фиат:   ключ `exchange_fiat_payment_url` → статическая ссылка СБП (если есть),
 *             иначе needsOperator=true (ссылку выдаёт оператор/партнёрский API).
 *
 * TTL: крипта 15 мин, фиат 20 мин — как в реальном воркфлоу.
 */

import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
import { isCryptoAsset, normNetwork } from "./rates.ts";

export const CRYPTO_TTL_MIN = 15;
export const FIAT_TTL_MIN = 20;

export interface RequisitesResult {
  kind: "crypto" | "fiat";
  /** адрес кошелька (крипта) */
  address?: string;
  network?: string;
  /** платёжная ссылка (фиат) */
  paymentUrl?: string;
  /** Binance/internal exchange id */
  exchangeId?: string;
  /** Карточные реквизиты/телефон/банк — показывать как текст, не парсить моделью. */
  detailsText?: string;
  ttlMin: number;
  /** показать AML-предупреждение про входящие переводы */
  amlNote?: boolean;
  /** реквизиты должен выдать оператор (нет настроенного источника) */
  needsOperator?: boolean;
  note?: string;
  /** имя провайдера (для requisites_json/аудита) */
  provider: string;
}

export interface RequisitesInput {
  asset: string; // нормализованный (USDT/RUB/...)
  network: string; // нормализованный lowercase или ''
  amountFrom?: number;
  amountToThb?: number;
  paymentMethod?: string | null;
  paymentRail?: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  getRequisites(input: RequisitesInput): Promise<RequisitesResult>;
}

/** Провайдер на основе настроек тенанта (tenant_secrets). */
export class ConfigPaymentProvider implements PaymentProvider {
  readonly name = "config";
  constructor(
    private readonly deps: { db: Db; tenantId: number; masterKeyHex: string },
  ) {}

  async getRequisites(input: RequisitesInput): Promise<RequisitesResult> {
    const asset = input.asset.toUpperCase();
    const network = normNetwork(input.network);

    if (isCryptoAsset(asset)) {
      const net = asset === "USDT" && !network ? "trc20" : network;
      if (input.paymentRail === "binance_id") {
        const exchangeId = await getDecryptedSecret({
          db: this.deps.db,
          tenantId: this.deps.tenantId,
          key: "exchange_binance_id",
          masterKeyHex: this.deps.masterKeyHex,
        });
        if (!exchangeId) {
          return {
            kind: "crypto",
            network: "BINANCE",
            ttlMin: CRYPTO_TTL_MIN,
            needsOperator: true,
            provider: this.name,
            note: "Binance ID не настроен — выдаёт оператор.",
          };
        }
        return {
          kind: "crypto",
          exchangeId,
          network: "BINANCE",
          ttlMin: CRYPTO_TTL_MIN,
          provider: this.name,
        };
      }
      const key = `exchange_wallet_${asset.toLowerCase()}_${net || "default"}`;
      const address = await getDecryptedSecret({
        db: this.deps.db,
        tenantId: this.deps.tenantId,
        key,
        masterKeyHex: this.deps.masterKeyHex,
      });
      if (!address) {
        return {
          kind: "crypto",
          network: net.toUpperCase(),
          ttlMin: CRYPTO_TTL_MIN,
          amlNote: true,
          needsOperator: true,
          provider: this.name,
          note: `Кошелёк ${asset}/${net.toUpperCase()} не настроен — выдаёт оператор.`,
        };
      }
      return {
        kind: "crypto",
        address,
        network: net.toUpperCase(),
        ttlMin: CRYPTO_TTL_MIN,
        amlNote: true,
        provider: this.name,
      };
    }

    if (input.paymentMethod === "card_transfer") {
      const detailsText = await getDecryptedSecret({
        db: this.deps.db,
        tenantId: this.deps.tenantId,
        key: "exchange_rub_card_requisites",
        masterKeyHex: this.deps.masterKeyHex,
      });
      if (!detailsText) {
        return {
          kind: "fiat",
          ttlMin: FIAT_TTL_MIN,
          needsOperator: true,
          provider: this.name,
          note: "Карточные RUB-реквизиты не настроены — выдаёт оператор.",
        };
      }
      return { kind: "fiat", detailsText, ttlMin: FIAT_TTL_MIN, provider: this.name };
    }

    // Фиат (RUB/EUR/USD): динамический QR пока представлен ссылкой/оператором.
    const paymentUrl = await getDecryptedSecret({
      db: this.deps.db,
      tenantId: this.deps.tenantId,
      key: "exchange_fiat_payment_url",
      masterKeyHex: this.deps.masterKeyHex,
    });
    if (!paymentUrl) {
      return {
        kind: "fiat",
        ttlMin: FIAT_TTL_MIN,
        needsOperator: true,
        provider: this.name,
        note: "Платёжная ссылка/QR не настроены — выдаёт оператор / партнёрский API.",
      };
    }
    return { kind: "fiat", paymentUrl, ttlMin: FIAT_TTL_MIN, provider: this.name };
  }
}

/** Фабрика провайдера тенанта. Точка расширения для партнёрских API. */
export function getPaymentProvider(deps: {
  db: Db;
  tenantId: number;
  masterKeyHex: string;
}): PaymentProvider {
  return new ConfigPaymentProvider(deps);
}
