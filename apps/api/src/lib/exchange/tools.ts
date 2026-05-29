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
import { computeQuote, isCryptoAsset, normAsset, resolveNetwork } from "./rates.ts";
import { assessOrderRisk } from "./risk.ts";

export interface ExchangeToolsDeps {
  db: Db;
  tenantId: number;
  conversationId: number;
  masterKeyHex: string;
}

const AssetEnum = z
  .string()
  .describe("Актив, который отдаёт клиент: USDT, BTC, ETH, RUB, EUR или USD");

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
      amount: z.number().positive().describe("Сумма в активе-источнике (например 335)"),
      network: z
        .string()
        .optional()
        .describe("Сеть для крипты: TRC20/ERC20/BEP20. Для USDT по умолчанию TRC20."),
    }),
    execute: async (args) => {
      const q = await computeQuote(db, tenantId, {
        asset: args.asset,
        amount: args.amount,
        network: args.network,
      });
      if (!q.ok) return { error: q.error };
      return {
        direction: q.direction,
        asset: q.asset,
        network: q.network || undefined,
        amountFrom: q.amountFrom,
        rate: q.rate,
        amountToThb: q.amountToThb,
        display: `Обмен ${q.asset} — THB\nКурс: ${q.rate}\n\nОтдаёте: ${q.amountFrom} ${q.asset}\nПолучаете: ${q.amountToThb} THB`,
      };
    },
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
      amount: z.number().positive(),
      network: z.string().optional(),
      payoutMethod: z
        .enum(["office", "atm"])
        .optional()
        .describe("Способ получения: office (код в офисе) или atm (cardless в банкомате)"),
    }),
    execute: async (args) => {
      const q = await computeQuote(db, tenantId, {
        asset: args.asset,
        amount: args.amount,
        network: args.network,
      });
      if (!q.ok) return { error: q.error };

      const asset = normAsset(args.asset);
      const network = resolveNetwork(asset, args.network);
      const idempotencyKey = `conv:${conversationId}:${asset}:${network}:${args.amount}`;

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
        rate: q.rate,
        amountToThb: q.amountToThb,
        payoutMethod: args.payoutMethod ?? null,
        riskJson: JSON.stringify({ ok: true, reasons: risk.reasons }),
        rateExpiresAt,
        idempotencyKey,
      });
      return {
        orderId: order.id,
        status: order.status,
        direction: order.direction,
        amountFrom: order.amountFrom,
        amountToThb: order.amountToThb,
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
      const req = await provider.getRequisites({ asset: order.assetFrom, network: order.network });

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
    }),
    execute: async (args) => {
      const order = await findActiveOrder(db, tenantId, conversationId);
      if (!order) return { error: "Нет активной заявки." };

      // Фиат — без автопроверки.
      if (!isCryptoAsset(order.assetFrom)) {
        return {
          orderId: order.id,
          ok: false,
          needsOperator: true,
          note: "Проверку фиатной оплаты выполняет оператор по чеку.",
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
      payoutMethod: z.enum(["office", "atm"]),
      location: z.string().describe("Офис (Бангтао) или банк банкомата (Kbank/Bangkok Bank/SCB)"),
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
      });

      // Код выдачи не генерируется ботом. Если оператор уже проставил payout_code —
      // отдаём его клиенту; иначе сигнализируем needsOperator.
      const fresh = await findActiveOrder(db, tenantId, conversationId);
      if (fresh?.payoutCode) {
        return {
          orderId: order.id,
          payoutMethod: args.payoutMethod,
          location: args.location,
          payoutCode: fresh.payoutCode,
          amountToThb: order.amountToThb,
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
