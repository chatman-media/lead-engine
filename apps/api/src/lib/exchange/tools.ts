/**
 * Агентские tools обменника (RagTool) для tool-loop в rag-reply.
 * Связаны с конкретной беседой (conversationId) — поэтому строятся СВЕЖИМИ на
 * каждый ответ (НЕ кешируются по тенанту, в отличие от booking-link).
 *
 * Поток: computeQuote (показать курс) → createOrder (подтверждение) →
 * fetchRequisites (адрес/ссылка с TTL) → verifyPayment (on-chain) →
 * issuePayout (код офиса / cardless).
 *
 * ЖЁСТКО: курс/сумму/реквизиты/коды считает/выдаёт код, НЕ модель. Бот зачитывает
 * результат verbatim.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import { exchangeRates } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { extractTxHash, verifyTronUsdt } from "./chain.ts";
import {
  createOrderIdempotent,
  findActiveOrder,
  getOrderByIdempotencyKey,
  resolveConversationParties,
  updateOrder,
} from "./orders.ts";
import { getPaymentProvider } from "./providers.ts";
import type { RateGuardTrip } from "./guardrails.ts";
import { computeQuote, isCryptoAsset, normAsset, resolveNetwork } from "./rates.ts";
import { assessOrderRisk } from "./risk.ts";
import { getExchangeVerificationStatus } from "./verification.ts";

/**
 * Срабатывание guardrail курса не должно быть «тихим». Пока — структурный warn.
 * TODO(#145): маршрутизировать как событие `rate_guard_tripped` владельцу
 * (Telegram DM + email) через NotificationService.
 */
function logGuardTrip(
  tenantId: number,
  conversationId: number,
  asset: string,
  network: string | undefined,
  guard: RateGuardTrip,
): void {
  const dev = Number.isFinite(guard.deviationPct)
    ? `${guard.deviationPct.toFixed(2)}%`
    : "n/a";
  console.warn(
    `[exchange-guard] tripped tenant=${tenantId} conv=${conversationId} ` +
      `${asset}${network ? `/${network}` : ""} reason=${guard.reason} ` +
      `deviation=${dev} base=${guard.baseRate} eff=${guard.eff} threshold=${guard.threshold ?? "n/a"}`,
  );
}

export interface ExchangeToolsDeps {
  db: Db;
  tenantId: number;
  conversationId: number;
  masterKeyHex: string;
}

const AssetEnum = z
  .string()
  .describe("Актив, который отдаёт клиент: USDT, BTC, ETH, RUB, EUR или USD");
const AmountModeEnum = z
  .enum(["source_amount", "target_thb"])
  .optional()
  .describe("source_amount — клиент назвал сумму, которую отдаёт; target_thb — клиент назвал сумму, которую хочет получить в батах");
const PaymentMethodEnum = z
  .enum(["crypto_transfer", "sbp_qr", "card_transfer", "bank_transfer", "cash"])
  .optional()
  .describe("Как клиент платит: crypto_transfer, sbp_qr, card_transfer, bank_transfer, cash");
const PayoutMethodEnum = z
  .enum(["office_cash", "cardless_atm", "courier_cash", "thai_bank_transfer", "atm"])
  .optional()
  .describe("Как клиент получает THB: courier_cash, cardless_atm, thai_bank_transfer, office_cash");

export function makeExchangeTools(deps: ExchangeToolsDeps): AnyRagTool[] {
  const { db, tenantId, conversationId, masterKeyHex } = deps;

  const computeQuoteTool: AnyRagTool = {
    name: "compute_exchange_quote",
    description: [
      "Посчитать актуальный курс и сумму к получению в THB для обмена.",
      "Вызывай ВСЕГДА, когда нужно назвать курс или итог — НИКОГДА не считай курс сам.",
      "Возвращает direction, rate, amountToThb. Покажи клиенту эти значения как есть.",
    ].join(" "),
    parameters: z.object({
      asset: AssetEnum,
      amount: z.number().positive().describe("Сумма. По умолчанию в активе-источнике; если клиент сказал 'нужно 10000 бат', передай amountMode=target_thb и amount=10000."),
      amountMode: AmountModeEnum,
      network: z
        .string()
        .optional()
        .describe("Сеть для крипты: TRC20/ERC20/BEP20. Для USDT по умолчанию TRC20."),
    }),
    execute: async (args) => {
      const q = await computeQuote(db, tenantId, {
        asset: args.asset,
        amount: args.amount,
        amountMode: args.amountMode,
        network: args.network,
      });
      if (!q.ok) {
        if (q.guard?.tripped) logGuardTrip(tenantId, conversationId, args.asset, args.network, q.guard);
        return { error: q.error };
      }
      return {
        direction: q.direction,
        asset: q.asset,
        network: q.network || undefined,
        amountMode: q.amountMode,
        amountFrom: q.amountFrom,
        rate: q.rate,
        amountToThb: q.amountToThb,
        display: `Обмен ${q.asset} — THB\nКурс: ${q.rate}\n\nОтдаёте: ${q.amountFrom} ${q.asset}\nПолучаете: ${q.amountToThb} THB`,
      };
    },
  };

  const checkVerificationTool: AnyRagTool = {
    name: "check_exchange_verification",
    description: [
      "Проверить, прошёл ли клиент верификацию для обмена.",
      "Вызывай перед create_exchange_order. Если needsVerification=true — объясни KYC и попроси документ/видео.",
    ].join(" "),
    parameters: z.object({}),
    execute: async () => getExchangeVerificationStatus(db, tenantId, conversationId),
  };

  const createOrderTool: AnyRagTool = {
    name: "create_exchange_order",
    description: [
      "Создать заявку на обмен ПОСЛЕ согласия клиента ('готовы'/'да'/'подготовьте реквизиты').",
      "Фиксирует курс снапшотом с TTL. Идемпотентно. Возвращает orderId.",
      "Не вызывай до согласия и до compute_exchange_quote.",
    ].join(" "),
    parameters: z.object({
      asset: AssetEnum,
      amount: z.number().positive().describe("Сумма: source asset или целевые THB, если amountMode=target_thb."),
      amountMode: AmountModeEnum,
      network: z.string().optional(),
      paymentMethod: PaymentMethodEnum,
      paymentRail: z.string().optional().describe("Конкретный rail: trc20, binance_id, sber, tinkoff, sbp, etc."),
      sourceBank: z.string().optional().describe("Банк/источник отправителя, если клиент назвал: Сбер, Тинькофф/T-Bank и т.д."),
      payerName: z.string().optional().describe("Имя плательщика, если известно."),
      thirdPartyApproved: z.boolean().optional().describe("true только если оператор явно разрешил перевод от третьего лица."),
      payoutMethod: PayoutMethodEnum,
      payoutLocation: z.string().optional().describe("Локация/банк выдачи: отель, Bangkok Bank, SCB, KBank, офис и т.д."),
      payoutDestination: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Структурированные данные выдачи: hotel/location, atmBank, thaiBankName, thaiAccountLast4 и т.д."),
    }),
    execute: async (args) => {
      const q = await computeQuote(db, tenantId, {
        asset: args.asset,
        amount: args.amount,
        amountMode: args.amountMode,
        network: args.network,
      });
      if (!q.ok) {
        if (q.guard?.tripped) logGuardTrip(tenantId, conversationId, args.asset, args.network, q.guard);
        return { error: q.error };
      }

      const verification = await getExchangeVerificationStatus(db, tenantId, conversationId);
      if (!verification.verified) {
        return {
          ok: false,
          needsVerification: true,
          status: verification.status,
          instructions:
            "Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.",
        };
      }

      const asset = normAsset(args.asset);
      const network = resolveNetwork(asset, args.network);
      const amountMode = args.amountMode === "target_thb" ? "target_thb" : "source_amount";
      const idempotencyKey = `conv:${conversationId}:${asset}:${network}:${amountMode}:${args.amount}`;

      const existing = await getOrderByIdempotencyKey(db, tenantId, idempotencyKey);
      if (existing) {
        return {
          orderId: existing.id,
          status: existing.status,
          direction: existing.direction,
          amountToThb: existing.amountToThb,
          rate: existing.rate,
          idempotent: true,
        };
      }

      const risk = await assessOrderRisk(db, tenantId, {
        conversationId,
        amountToThb: q.amountToThb,
      });
      if (!risk.ok) return { error: risk.reasons.join(" ") };

      const parties = await resolveConversationParties(db, tenantId, conversationId);
      const ttlMin = isCryptoAsset(asset) ? 15 : 20;
      const rateExpiresAt = Math.floor(Date.now() / 1000) + ttlMin * 60;

      const order = await createOrderIdempotent(db, tenantId, {
        conversationId,
        contactId: parties.contactId,
        telegramId: parties.telegramId,
        direction: q.direction,
        assetFrom: asset,
        network,
        amountFrom: q.amountFrom,
        amountMode,
        requestedAmount: args.amount,
        rate: q.rate,
        amountToThb: q.amountToThb,
        paymentMethod: args.paymentMethod ?? (isCryptoAsset(asset) ? "crypto_transfer" : null),
        paymentRail: args.paymentRail ?? (isCryptoAsset(asset) ? network : null),
        sourceBank: args.sourceBank ?? null,
        payerName: args.payerName ?? null,
        thirdPartyApproved: args.thirdPartyApproved ?? false,
        payoutMethod: args.payoutMethod ?? null,
        payoutLocation: args.payoutLocation ?? null,
        payoutDestinationJson: args.payoutDestination ? JSON.stringify(args.payoutDestination) : null,
        verificationId: verification.verificationId,
        riskJson: JSON.stringify({ ok: true, reasons: risk.reasons }),
        rateExpiresAt,
        idempotencyKey,
      });
      return {
        orderId: order.id,
        status: order.status,
        direction: order.direction,
        amountFrom: order.amountFrom,
        amountMode,
        amountToThb: order.amountToThb,
        paymentMethod: order.paymentMethod,
        payoutMethod: order.payoutMethod,
        rate: order.rate,
        ttlMin,
      };
    },
  };

  const fetchRequisitesTool: AnyRagTool = {
    name: "fetch_exchange_requisites",
    description: [
      "Получить реквизиты для оплаты по активной заявке: адрес кошелька (крипта) или",
      "платёжную ссылку (фиат) с TTL. Вызывай после create_exchange_order.",
      "Отправь клиенту реквизиты + предупреждение о TTL + (для крипты) про AML-проверку.",
    ].join(" "),
    parameters: z.object({}),
    execute: async () => {
      const order = await findActiveOrder(db, tenantId, conversationId);
      if (!order) return { error: "Нет активной заявки. Сначала создай заявку." };

      const provider = getPaymentProvider({ db, tenantId, masterKeyHex });
      const req = await provider.getRequisites({
        asset: order.assetFrom,
        network: order.network,
        amountFrom: order.amountFrom,
        amountToThb: order.amountToThb,
        paymentMethod: order.paymentMethod,
        paymentRail: order.paymentRail,
      });

      const ttlMin = req.ttlMin;
      const rateExpiresAt = Math.floor(Date.now() / 1000) + ttlMin * 60;
      await updateOrder(db, tenantId, order.id, {
        requisitesJson: JSON.stringify(req),
        rateExpiresAt,
      });

      if (req.needsOperator) {
        return {
          orderId: order.id,
          needsOperator: true,
          note: req.note ?? "Реквизиты выдаст оператор.",
        };
      }
      if (req.kind === "crypto") {
        if (req.exchangeId) {
          return {
            orderId: order.id,
            kind: "crypto",
            paymentRail: "binance_id",
            exchangeId: req.exchangeId,
            ttlMin,
            instructions: `Binance ID для перевода: ${req.exchangeId}\nРеквизиты актуальны ${ttlMin} минут. После оплаты пришлите подтверждение перевода.`,
          };
        }
        return {
          orderId: order.id,
          kind: "crypto",
          address: req.address,
          network: req.network,
          ttlMin,
          amlNote: true,
          instructions: `Адрес для ${order.assetFrom} (${req.network}): ${req.address}\nАдрес актуален ${ttlMin} минут. Все входящие транзакции проходят AML-проверку. Переведите точную сумму с учётом сетевой комиссии. После оплаты пришлите tx hash или ссылку на транзакцию.`,
        };
      }
      if (req.detailsText) {
        return {
          orderId: order.id,
          kind: "fiat",
          paymentMethod: order.paymentMethod,
          detailsText: req.detailsText,
          ttlMin,
          instructions: `${req.detailsText}\nРеквизиты актуальны ${ttlMin} минут. После оплаты пришлите развёрнутый чек.`,
        };
      }
      return {
        orderId: order.id,
        kind: "fiat",
        paymentUrl: req.paymentUrl,
        ttlMin,
        instructions: `Оплата по платёжной ссылке (СБП): ${req.paymentUrl}\nСсылка действует ${ttlMin} минут. После оплаты пришлите развёрнутый чек.`,
      };
    },
  };

  const verifyPaymentTool: AnyRagTool = {
    name: "verify_exchange_payment",
    description: [
      "Проверить поступление оплаты по активной заявке. Для крипты — on-chain по tx hash.",
      "Передай proof = присланный клиентом tx hash или ссылку на explorer (tronscan).",
      "Не подтверждай оплату клиенту, пока не вернулся ok:true.",
      "Для фиата (RUB) автопроверка недоступна — вернётся needsOperator.",
    ].join(" "),
    parameters: z.object({
      proof: z
        .string()
        .optional()
        .describe("tx hash или ссылка на транзакцию (для крипты)"),
      sourceBank: z.string().optional().describe("Банк отправителя из чека: Сбер, Тинькофф/T-Bank и т.д."),
      receiptAmount: z.number().positive().optional().describe("Сумма оплаты из чека в валюте оплаты, если удалось прочитать."),
      payerName: z.string().optional().describe("Имя плательщика из чека, если видно."),
      paymentReference: z.string().optional().describe("Номер/референс платежа из чека."),
    }),
    execute: async (args) => {
      const order = await findActiveOrder(db, tenantId, conversationId);
      if (!order) return { error: "Нет активной заявки." };

      // Фиат — сохраняем данные чека, но НЕ подтверждаем автоматически.
      if (!isCryptoAsset(order.assetFrom)) {
        await updateOrder(db, tenantId, order.id, {
          proofJson: JSON.stringify({
            kind: "fiat_receipt",
            proof: args.proof ?? null,
            sourceBank: args.sourceBank ?? null,
            receiptAmount: args.receiptAmount ?? null,
            payerName: args.payerName ?? null,
            paymentReference: args.paymentReference ?? null,
            verifiedOk: false,
            needsOperator: true,
          }),
          sourceBank: args.sourceBank ?? order.sourceBank,
          payerName: args.payerName ?? order.payerName,
        });
        return {
          orderId: order.id,
          ok: false,
          needsOperator: true,
          sourceBank: args.sourceBank ?? order.sourceBank,
          receiptAmount: args.receiptAmount ?? null,
          note: "Данные чека сохранены. Проверку фиатной оплаты выполняет оператор.",
        };
      }

      // Крипта — нужен tx hash и адрес-получатель из выданных реквизитов.
      const txHash = args.proof ? extractTxHash(args.proof) : null;
      if (!txHash) {
        return { ok: false, error: "Пришлите, пожалуйста, tx hash транзакции или ссылку на неё." };
      }
      let toAddress: string | undefined;
      try {
        const req = order.requisitesJson ? JSON.parse(order.requisitesJson) : null;
        toAddress = req?.address;
      } catch {
        /* ignore */
      }
      if (!toAddress) {
        return {
          ok: false,
          needsOperator: true,
          note: "Адрес кошелька не зафиксирован — проверит оператор.",
        };
      }

      const network = (order.network || "TRC20").toUpperCase();
      if (network !== "TRC20") {
        return {
          orderId: order.id,
          ok: false,
          needsOperator: true,
          note: `Автопроверка для сети ${network} недоступна — проверит оператор.`,
        };
      }

      const res = await verifyTronUsdt({
        txHash,
        toAddress,
        expectedAmount: order.amountFrom,
      });

      // Зафиксировать пруф (включая from_address — п.16).
      await updateOrder(db, tenantId, order.id, {
        proofJson: JSON.stringify({
          txHash: res.txHash,
          fromAddress: res.fromAddress,
          toAddress: res.toAddress,
          amount: res.amount,
          symbol: res.symbol,
          network: res.network,
          verifiedOk: res.ok,
        }),
        ...(res.ok ? { status: "paid" } : {}),
      });

      if (res.ok) {
        return {
          orderId: order.id,
          ok: true,
          fromAddress: res.fromAddress,
          amount: res.amount,
          note: "Оплата поступила. Можно готовить выдачу.",
        };
      }
      return {
        orderId: order.id,
        ok: false,
        ...(res.needsOperator ? { needsOperator: true } : {}),
        reason: res.reason,
      };
    },
  };

  const issuePayoutTool: AnyRagTool = {
    name: "issue_exchange_payout",
    description: [
      "Выдать получение THB по оплаченной заявке. payoutMethod: office (код в офисе)",
      "или atm (cardless в банкомате). location: офис (напр. Бангтао) или банк (Kbank/Bangkok Bank/SCB).",
      "Код снятия приходит от провайдера/оператора — НЕ выдумывай его. Если кода ещё нет —",
      "вернётся needsOperator: попроси оператора подготовить код.",
    ].join(" "),
    parameters: z.object({
      payoutMethod: z.enum(["office_cash", "cardless_atm", "courier_cash", "thai_bank_transfer", "atm"]),
      location: z.string().describe("Офис (Бангтао) или банк банкомата (Kbank/Bangkok Bank/SCB)"),
      destination: z.record(z.string(), z.unknown()).optional().describe("Структурированные детали выдачи: банк, отель, адрес, последние цифры счёта."),
    }),
    execute: async (args) => {
      const order = await findActiveOrder(db, tenantId, conversationId);
      if (!order) return { error: "Нет активной заявки." };
      if (order.status !== "paid" && order.status !== "payout") {
        return { error: "Оплата ещё не подтверждена — сначала verify_exchange_payment." };
      }

      await updateOrder(db, tenantId, order.id, {
        status: "payout",
        payoutMethod: args.payoutMethod,
        payoutLocation: args.location,
        payoutDestinationJson: args.destination ? JSON.stringify(args.destination) : order.payoutDestinationJson,
      });

      // Код выдачи не генерируется ботом. Если оператор уже проставил payout_code —
      // отдаём его клиенту; иначе сигнализируем needsOperator. Просроченный код
      // (payout_code_expires_at < now) НЕ выдаём — это снова кейс оператора.
      const fresh = await findActiveOrder(db, tenantId, conversationId);
      const nowSec = Math.floor(Date.now() / 1000);
      const codeExpired =
        fresh?.payoutCodeExpiresAt != null && fresh.payoutCodeExpiresAt < nowSec;
      if (fresh?.payoutCode && !codeExpired) {
        return {
          orderId: order.id,
          payoutMethod: args.payoutMethod,
          location: args.location,
          payoutCode: fresh.payoutCode,
          amountToThb: order.amountToThb,
        };
      }
      if (codeExpired) {
        return {
          orderId: order.id,
          needsOperator: true,
          codeExpired: true,
          note: "Срок действия кода истёк — оператор выпустит новый. Сообщите клиенту, что код скоро обновят.",
          payoutMethod: args.payoutMethod,
          location: args.location,
        };
      }
      return {
        orderId: order.id,
        needsOperator: true,
        note: "Код получения готовит оператор. Сообщите клиенту, что код скоро будет.",
        payoutMethod: args.payoutMethod,
        location: args.location,
      };
    },
  };

  return [
    computeQuoteTool,
    checkVerificationTool,
    createOrderTool,
    fetchRequisitesTool,
    verifyPaymentTool,
    issuePayoutTool,
  ];
}

/** Есть ли у тенанта хоть один активный курс (гейт для включения exchange-tools). */
export async function hasActiveExchangeRates(db: Db, tenantId: number): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: exchangeRates.id })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.isActive, true)))
      .limit(1);
    return !!row;
  });
}
