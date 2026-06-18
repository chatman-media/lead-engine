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

import {
  type Db,
  getDecryptedSecret,
  QUOTE_CURRENCY,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import {
  conversations,
  exchangeRates,
  funnels,
  leadFieldValues,
  leads,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_TX_MAX_AGE_SECONDS, extractTxHash, verifyTronUsdt } from "./chain.ts";
import type { RateGuardTrip } from "./guardrails.ts";
import {
  cancelOpenExchangeOrders,
  createOrderIdempotent,
  findActiveOrder,
  getLatestOrderForConversation,
  getOrderById,
  getOrderByIdempotencyKey,
  isReusableOrderStatus,
  isRevivableOrderStatus,
  markOrderPaidWithUniqueTxHash,
  releaseOrderIdempotencyKey,
  resolveConversationParties,
  reviveExpiredOrder,
  updateOrder,
} from "./orders.ts";
import { getPaymentProvider, verifyWestWalletInvoicePayment } from "./providers.ts";
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
  const dev = Number.isFinite(guard.deviationPct) ? `${guard.deviationPct.toFixed(2)}%` : "n/a";
  console.warn(
    `[exchange-guard] tripped tenant=${tenantId} conv=${conversationId} ` +
      `${asset}${network ? `/${network}` : ""} reason=${guard.reason} ` +
      `deviation=${dev} base=${guard.baseRate} eff=${guard.eff} threshold=${guard.threshold ?? "n/a"}`,
  );
}

function compactInfoLines(lines: Array<string | null | undefined>): string | null {
  const out = lines.map((line) => line?.trim()).filter((line): line is string => Boolean(line));
  return out.length > 0 ? out.join("\n") : null;
}

function parseOfficeAddresses(value: string | null | undefined): string[] {
  const raw = value?.trim();
  if (!raw) return [];
  const blocks = raw
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const candidates =
    blocks.length > 1
      ? blocks
      : raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
  return candidates.map((candidate) => candidate.replace(/\s*\r?\n\s*/g, "; "));
}

async function moveExchangeLeadToStage(opts: {
  db: Db;
  tenantId: number;
  conversationId: number;
  stageSlug: string;
  /** Разрешить откат на более раннюю стадию (по умолчанию move forward-only). */
  allowBackward?: boolean;
}): Promise<{ leadId: number; stageSlug: string; changed: boolean } | null> {
  const { db, tenantId, conversationId, stageSlug, allowBackward = false } = opts;
  const nowEpoch = Math.floor(Date.now() / 1000);

  return withTenant(db, tenantId, async (tx) => {
    const [lead] = await tx
      .select({
        id: leads.id,
        state: leads.state,
        stageDefinitionId: leads.stageDefinitionId,
        currentPosition: stageDefinitions.position,
        funnelId: stageDefinitions.funnelId,
      })
      .from(conversations)
      .innerJoin(leads, and(eq(leads.tenantId, tenantId), eq(leads.userId, conversations.userId)))
      .leftJoin(stageDefinitions, eq(stageDefinitions.id, leads.stageDefinitionId))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
      .orderBy(desc(leads.updatedAt), desc(leads.id))
      .limit(1);
    if (!lead) return null;

    const targetWhere = lead.funnelId
      ? and(
          eq(stageDefinitions.tenantId, tenantId),
          eq(stageDefinitions.funnelId, lead.funnelId),
          eq(stageDefinitions.slug, stageSlug),
        )
      : and(
          eq(stageDefinitions.tenantId, tenantId),
          eq(stageDefinitions.slug, stageSlug),
          eq(funnels.tenantId, tenantId),
          or(eq(funnels.verticalTemplateId, "exchange_v1"), eq(funnels.slug, "exchange")),
        );

    const [target] = await tx
      .select({
        id: stageDefinitions.id,
        slug: stageDefinitions.slug,
        position: stageDefinitions.position,
      })
      .from(stageDefinitions)
      .innerJoin(funnels, eq(stageDefinitions.funnelId, funnels.id))
      .where(targetWhere)
      .orderBy(desc(funnels.isActive), asc(stageDefinitions.position))
      .limit(1);
    if (!target) return null;

    if (lead.stageDefinitionId === target.id && lead.state === target.slug) {
      return { leadId: lead.id, stageSlug: target.slug, changed: false };
    }

    const currentPosition = typeof lead.currentPosition === "number" ? lead.currentPosition : null;
    if (!allowBackward && currentPosition != null && target.position < currentPosition) {
      return { leadId: lead.id, stageSlug: lead.state, changed: false };
    }

    await tx
      .update(leads)
      .set({ stageDefinitionId: target.id, state: target.slug, updatedAt: nowEpoch })
      .where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));

    return { leadId: lead.id, stageSlug: target.slug, changed: true };
  });
}

/**
 * Текущий slug стадии лида беседы (на момент вызова). Нужен стейдж-гейту:
 * инструменты двигают стадию ВНУТРИ хода (create_order → order_created), а
 * захваченный на начало хода stageSlug устаревает и ложно блокирует
 * зацепленные следом инструменты (fetch_requisites и т.п.). undefined — лида
 * нет или стадия не определена (вызывающий откатится на stageSlug хода).
 */
async function resolveLeadStageSlug(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<string | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ slug: stageDefinitions.slug })
      .from(conversations)
      .innerJoin(leads, and(eq(leads.tenantId, tenantId), eq(leads.userId, conversations.userId)))
      .leftJoin(stageDefinitions, eq(stageDefinitions.id, leads.stageDefinitionId))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
      .orderBy(desc(leads.updatedAt), desc(leads.id))
      .limit(1);
    return row?.slug ?? undefined;
  });
}

/**
 * Поля, собранные универсальным движком воронки (field-extractor →
 * leadFieldValues) на стадии exchange_request. Источник правды для аргументов
 * тулов: что отдаёт клиент / сумма / сеть / способ выдачи / способ внесения.
 * Тулы используют это как fallback, когда LLM не передал arg явно — чтобы
 * собранные универсально данные реально доходили до действий (курс/заявка).
 */
export interface ExchangeCollectedFields {
  asset?: string;
  amount?: number;
  network?: string;
  payoutMethod?: string;
  paymentMethod?: string;
  /**
   * Per-turn сигнал: сумму (amount_from) на ЭТОМ ходе (пере)задал
   * field-extractor — её leadFieldValues.updatedAt не старше turnStartedAt.
   * Нужен форс-котировке: «посчитай 500 usdt» (свежая сумма → считаем) vs
   * «TRC20 в банкомате» (все поля есть, суммы этого хода нет → сводка/оплата).
   * Без turnStartedAt не вычисляется (остаётся undefined).
   */
  amountSetThisTurn?: boolean;
  /** Аналогично amountSetThisTurn, но для актива (asset_from). */
  assetSetThisTurn?: boolean;
}

// stageField option `value` → enum тулов. Актив/сеть нормализует сам тул
// (normAsset/resolveNetwork), здесь маппим только payout (seed: office/atm).
const PAYOUT_VALUE_MAP: Record<string, string> = {
  office: "office_cash",
  office_cash: "office_cash",
  atm: "atm",
  cardless_atm: "cardless_atm",
  cardless: "cardless_atm",
  courier: "courier_cash",
  courier_cash: "courier_cash",
  thai_bank_transfer: "thai_bank_transfer",
};
const PAYMENT_VALUE_MAP: Record<string, string> = {
  sbp_qr: "sbp_qr",
  sbp: "sbp_qr",
  qr: "sbp_qr",
  card_transfer: "card_transfer",
  card: "card_transfer",
  bank_transfer: "bank_transfer",
  crypto_transfer: "crypto_transfer",
  cash: "cash",
};

function fieldString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function fieldNumber(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/\s/g, "").replace(",", "."))
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Чистый маппер: сырые значения stageField (slug → parsed JSON) → аргументы
 * тулов. Вынесен из readExchangeCollectedFields для unit-тестов без БД.
 */
export function mapExchangeCollectedValues(
  bySlug: Record<string, unknown>,
): ExchangeCollectedFields {
  const collected: ExchangeCollectedFields = {};
  const asset = fieldString(bySlug.asset_from);
  if (asset) collected.asset = asset;
  const amount = fieldNumber(bySlug.amount_from);
  if (amount !== undefined) collected.amount = amount;
  const network = fieldString(bySlug.network);
  if (network) collected.network = network;
  const payout = fieldString(bySlug.payout_method);
  if (payout) collected.payoutMethod = PAYOUT_VALUE_MAP[payout.toLowerCase()] ?? payout;
  const payment = fieldString(bySlug.payment_method);
  if (payment) collected.paymentMethod = PAYMENT_VALUE_MAP[payment.toLowerCase()] ?? payment;
  return collected;
}

/**
 * Читает универсально собранные значения (asset_from/amount_from/network/
 * payout_method/payment_method) из leadFieldValues лида беседы. Пусто — поля
 * ещё не собраны (тул тогда полагается на явные аргументы LLM).
 *
 * turnStartedAt (epoch сек) — якорь «этого хода» (createdAt текущего входящего
 * сообщения). Если задан, выставляем amountSetThisTurn/assetSetThisTurn по
 * updatedAt поля amount_from/asset_from: field-extractor перезаписывает поле
 * на ходе, где клиент назвал свежую сумму/актив → updatedAt >= turnStartedAt.
 * Иначе поле осталось от прошлого хода (updatedAt < turnStartedAt). Это
 * заменяет «свежая сумма этого хода» из выпиленного regex (#654).
 */
export async function readExchangeCollectedFields(
  db: Db,
  tenantId: number,
  conversationId: number,
  turnStartedAt?: number,
): Promise<ExchangeCollectedFields> {
  return withTenant(db, tenantId, async (tx) => {
    const [lead] = await tx
      .select({ id: leads.id })
      .from(conversations)
      .innerJoin(leads, and(eq(leads.tenantId, tenantId), eq(leads.userId, conversations.userId)))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
      .orderBy(desc(leads.updatedAt), desc(leads.id))
      .limit(1);
    if (!lead) return {};

    // Один slug может быть заведён на нескольких стадиях (разные fieldId) —
    // берём САМОЕ СВЕЖЕЕ значение. updatedAt секундный, поэтому при re-quote в
    // пределах секунды добавляем тай-брейк по leadFieldValues.id desc (позже
    // созданная запись = позже-созданная стадия = актуальнее). Иначе re-quote
    // («передумал, 500 USDT» на quote_calculated) мог отдать СТАРОЕ значение.
    const rows = await tx
      .select({
        slug: stageFields.slug,
        valueJson: leadFieldValues.valueJson,
        updatedAt: leadFieldValues.updatedAt,
        id: leadFieldValues.id,
      })
      .from(leadFieldValues)
      .innerJoin(stageFields, eq(stageFields.id, leadFieldValues.fieldId))
      .where(and(eq(leadFieldValues.leadId, lead.id), eq(leadFieldValues.tenantId, tenantId)))
      .orderBy(desc(leadFieldValues.updatedAt), desc(leadFieldValues.id));

    const bySlug: Record<string, unknown> = {};
    const updatedBySlug: Record<string, number> = {};
    for (const row of rows) {
      if (row.slug in bySlug) continue; // свежее уже взято
      try {
        bySlug[row.slug] = JSON.parse(row.valueJson);
        updatedBySlug[row.slug] = row.updatedAt;
      } catch {
        // невалидный JSON — пропускаем
      }
    }
    const collected = mapExchangeCollectedValues(bySlug);
    if (turnStartedAt !== undefined) {
      collected.amountSetThisTurn =
        collected.amount !== undefined && (updatedBySlug.amount_from ?? -1) >= turnStartedAt;
      collected.assetSetThisTurn =
        collected.asset !== undefined && (updatedBySlug.asset_from ?? -1) >= turnStartedAt;
    }
    return collected;
  });
}

function resolveTxMaxAgeSeconds(): number {
  const raw = process.env.EXCHANGE_TX_MAX_AGE_SECONDS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TX_MAX_AGE_SECONDS;
}

/** Событие срабатывания guardrail курса — уходит владельцу (A4 / #145). */
export interface RateGuardAlert {
  tenantId: number;
  conversationId: number;
  asset: string;
  network?: string;
  reason: string;
  deviationPct: number;
  threshold?: number;
}

export interface ExchangeToolsDeps {
  db: Db;
  tenantId: number;
  conversationId: number;
  masterKeyHex: string;
  /** Current exchange_v1 funnel stage. If omitted, tools keep legacy behavior. */
  stageSlug?: string;
  /**
   * A4: алерт владельцу при срабатывании rate-guard (вместо «тихого» warn).
   * Fire-and-forget; если не задан — остаётся только console.warn.
   */
  notifyRateGuard?: (alert: RateGuardAlert) => void;
}

const AssetEnum = z
  .string()
  .describe(
    `Актив, который отдаёт клиент: USDT, BTC, ETH, RUB, EUR или USD. Если клиент хочет отдать ${QUOTE_CURRENCY.code} (баты) — это направление мы не обслуживаем, сообщи об этом сразу и не продолжай сбор данных.`,
  );
const AmountModeEnum = z
  .enum(["source_amount", "target_thb"])
  .optional()
  .describe(
    `source_amount — клиент назвал сумму, которую отдаёт; target_thb — клиент назвал сумму, которую хочет получить в котируемой валюте (${QUOTE_CURRENCY.code})`,
  );
const PaymentMethodEnum = z
  .enum(["crypto_transfer", "sbp_qr", "card_transfer", "bank_transfer", "cash"])
  .optional()
  .describe("Как клиент платит: crypto_transfer, sbp_qr, card_transfer, bank_transfer, cash");
const PayoutMethodEnum = z
  .enum(["office_cash", "cardless_atm", "courier_cash", "thai_bank_transfer", "atm"])
  .optional()
  .describe(
    `Как клиент получает ${QUOTE_CURRENCY.code}: courier_cash, cardless_atm, thai_bank_transfer (перевод на местный банк), office_cash`,
  );

const KNOWN_EXCHANGE_STAGES = new Set([
  "exchange_request",
  "quote_calculated",
  "verification_check",
  "kyc_collection",
  "risk_review",
  "order_created",
  "requisites_sent",
  "payment_proof_waiting",
  "payment_verified",
  "payout_or_completion",
  "cancelled",
]);

const TOOL_STAGE_MATRIX: Record<string, Set<string> | "any"> = {
  compute_exchange_quote: new Set([
    "exchange_request",
    "quote_calculated",
    "kyc_collection",
    // Перекотировка ДО оплаты: клиент может передумать (другая сумма/направление)
    // уже после создания заявки/выдачи реквизитов. После оплаты — нельзя.
    "order_created",
    "requisites_sent",
  ]),
  check_exchange_verification: new Set([
    "quote_calculated",
    "verification_check",
    "kyc_collection",
    "risk_review",
    "order_created",
  ]),
  create_exchange_order: new Set(["quote_calculated", "risk_review", "order_created"]),
  // Отмена доступна на любой стадии до завершения — клиент может передумать когда угодно.
  cancel_exchange_order: "any",
  fetch_exchange_requisites: new Set(["order_created", "requisites_sent"]),
  verify_exchange_payment: new Set(["requisites_sent", "payment_proof_waiting"]),
  issue_exchange_payout: new Set(["payment_verified"]),
  get_exchange_business_info: "any",
};

export function isKnownExchangeStage(stageSlug: string | null | undefined): stageSlug is string {
  return typeof stageSlug === "string" && KNOWN_EXCHANGE_STAGES.has(stageSlug);
}

export function exchangeAllowedActionsBlock(stageSlug: string | null | undefined): string | null {
  if (!isKnownExchangeStage(stageSlug)) return null;
  const allowed = Object.entries(TOOL_STAGE_MATRIX)
    .filter(([, stages]) => stages === "any" || stages.has(stageSlug))
    .map(([name]) => name);
  return [
    `Текущая стадия exchange: ${stageSlug}.`,
    `Разрешённые инструменты сейчас: ${allowed.join(", ") || "нет"}.`,
    "Если нужный инструмент не разрешён, не вызывай его и попроси оператора/двигай клиента к следующему корректному шагу.",
  ].join(" ");
}

export function guardExchangeToolForStage(
  toolName: string,
  stageSlug: string | null | undefined,
): null | {
  ok: false;
  needsOperator: true;
  reason: "action_not_allowed_for_stage";
  toolName: string;
  stageSlug: string;
  allowedTools: string[];
  note: string;
} {
  if (!isKnownExchangeStage(stageSlug)) return null;
  const allowed = TOOL_STAGE_MATRIX[toolName] ?? "any";
  if (allowed === "any" || allowed.has(stageSlug)) return null;
  const allowedTools = Object.entries(TOOL_STAGE_MATRIX)
    .filter(([, stages]) => stages === "any" || stages.has(stageSlug))
    .map(([name]) => name);
  return {
    ok: false,
    needsOperator: true,
    reason: "action_not_allowed_for_stage",
    toolName,
    stageSlug,
    allowedTools,
    note: `Инструмент ${toolName} нельзя выполнять на стадии ${stageSlug}.`,
  };
}

// Рантайм-гейт на КАЖДЫЙ инструмент: проверяет стадию по ТЕКУЩЕМУ значению (на
// момент вызова), а не по снимку на начало хода — иначе инструмент, зацепленный
// после стадия-двигающего (create_order → order_created → fetch_requisites одним
// ходом), ложно блокируется. Поэтому это per-tool обёртка execute, а НЕ отрезание
// из списка тулзов. Текст «какие инструменты сейчас разрешены»
// (exchangeAllowedActionsBlock) сюда НЕ добавляем — он дублировался бы в каждое из
// ~7 описаний; его эмитим ОДИН раз в makeExchangeTools.
function withExchangeStageGuard(
  tool: AnyRagTool,
  stageSlug: string | undefined,
  getCurrentStage?: () => Promise<string | undefined>,
): AnyRagTool {
  if (!isKnownExchangeStage(stageSlug)) return tool;
  return {
    ...tool,
    execute: async (args) => {
      let current = stageSlug;
      if (getCurrentStage) {
        try {
          current = (await getCurrentStage()) ?? stageSlug;
        } catch {
          current = stageSlug;
        }
      }
      const denied = guardExchangeToolForStage(tool.name, current);
      if (denied) return denied;
      return tool.execute(args);
    },
  };
}

/**
 * Обёртка: после успешного выполнения инструмента двигает лида по воронке.
 * verify_exchange_payment / issue_exchange_payout сами стадию не двигали —
 * воронка зависала на requisites_sent. pick(result) → целевой slug или null.
 */
function withStageAdvance(
  tool: AnyRagTool,
  db: Db,
  tenantId: number,
  conversationId: number,
  pick: (result: Record<string, unknown>) => string | null,
): AnyRagTool {
  return {
    ...tool,
    execute: async (args) => {
      const result = await tool.execute(args);
      const slug =
        result && typeof result === "object" ? pick(result as Record<string, unknown>) : null;
      if (slug) {
        await moveExchangeLeadToStage({ db, tenantId, conversationId, stageSlug: slug });
      }
      return result;
    },
  };
}

export function makeExchangeTools(deps: ExchangeToolsDeps): AnyRagTool[] {
  const { db, tenantId, conversationId, masterKeyHex, stageSlug } = deps;

  // Срабатывание guardrail курса: лог (всегда) + алерт владельцу (если задан).
  const onGuardTrip = (asset: string, network: string | undefined, guard: RateGuardTrip) => {
    logGuardTrip(tenantId, conversationId, asset, network, guard);
    deps.notifyRateGuard?.({
      tenantId,
      conversationId,
      asset,
      ...(network ? { network } : {}),
      reason: guard.reason ?? "rate_guard",
      deviationPct: guard.deviationPct,
      ...(guard.threshold != null ? { threshold: guard.threshold } : {}),
    });
  };

  const computeQuoteTool: AnyRagTool = {
    name: "compute_exchange_quote",
    description: [
      `Посчитать актуальную сумму к получению в ${QUOTE_CURRENCY.code} для обмена.`,
      "Вызывай ВСЕГДА, когда нужно назвать итог — НИКОГДА не считай сумму сам.",
      "Клиенту показывай только amountToThb/quoteAsset. Курс в ответе клиенту не пиши.",
    ].join(" "),
    parameters: z.object({
      asset: AssetEnum.optional(),
      amount: z
        .number()
        .positive()
        .optional()
        .describe(
          `Сумма. По умолчанию в активе-источнике; если клиент сказал 'нужно 10000 ${QUOTE_CURRENCY.word}', передай amountMode=target_thb и amount=10000. Если не передать — берётся из собранных полей заявки.`,
        ),
      amountMode: AmountModeEnum,
      network: z
        .string()
        .optional()
        .describe("Сеть для крипты: TRC20/ERC20/BEP20. Для USDT по умолчанию TRC20."),
    }),
    execute: async (args) => {
      // Источник правды для НЕзаданных аргументов: сначала АКТИВНАЯ заявка
      // (подтверждённая сделка), затем универсально собранные поля. Чинит «компьют
      // берёт протухшее значение из leadFieldValues, хотя заявка про другую сумму»:
      // пока есть открытая заявка, считаем по ней, если LLM не передал явно новое.
      const collected = await readExchangeCollectedFields(db, tenantId, conversationId);
      const active = await findActiveOrder(db, tenantId, conversationId);
      const asset = args.asset ?? active?.assetFrom ?? collected.asset;
      const amount =
        args.amount ?? active?.requestedAmount ?? active?.amountFrom ?? collected.amount;
      const network = args.network ?? active?.network ?? collected.network;
      if (!asset || amount === undefined) {
        return { error: "Не хватает данных для расчёта: уточните, что меняете и на какую сумму." };
      }
      const q = await computeQuote(db, tenantId, {
        asset,
        amount,
        amountMode: args.amountMode,
        network,
      });
      if (!q.ok) {
        if (q.guard?.tripped) onGuardTrip(asset, network, q.guard);
        return { error: q.error };
      }

      // Перекотировка до оплаты: клиент назвал ДРУГУЮ сумму/актив/режим, чем в
      // активной заявке → отменяем ВСЕ открытые до-оплатные заявки (не только
      // последнюю) и откатываем лида на quote_calculated, чтобы воронка пошла под
      // новую сумму. Совпадающая перекотировка — без побочек. Заявки с оплатой
      // cancelOpenExchangeOrders не трогает (их разрулит оператор).
      if (active) {
        const reqAmount = active.requestedAmount ?? active.amountFrom;
        const sameDeal =
          active.assetFrom === normAsset(asset) &&
          Number(reqAmount) === Number(amount) &&
          (active.amountMode ?? "source_amount") === (args.amountMode ?? "source_amount");
        if (!sameDeal) {
          await cancelOpenExchangeOrders(db, tenantId, conversationId);
          await moveExchangeLeadToStage({
            db,
            tenantId,
            conversationId,
            stageSlug: "quote_calculated",
            allowBackward: true,
          });
        }
      }

      return {
        direction: q.direction,
        asset: q.asset,
        quoteAsset: q.quoteAsset,
        network: q.network || undefined,
        amountMode: q.amountMode,
        amountFrom: q.amountFrom,
        rate: q.rate,
        amountToThb: q.amountToThb,
        display: `Отдаёте: ${q.amountFrom} ${q.asset}\nПолучаете: ${q.amountToThb} ${q.quoteAsset}`,
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
      asset: AssetEnum.optional(),
      amount: z
        .number()
        .positive()
        .optional()
        .describe(
          `Сумма: source asset или целевые ${QUOTE_CURRENCY.code}, если amountMode=target_thb. Если не передать — берётся из собранных полей заявки.`,
        ),
      amountMode: AmountModeEnum,
      network: z.string().optional(),
      paymentMethod: PaymentMethodEnum,
      paymentRail: z
        .string()
        .optional()
        .describe("Конкретный rail: trc20, binance_id, sber, tinkoff, sbp, etc."),
      sourceBank: z
        .string()
        .optional()
        .describe("Банк/источник отправителя, если клиент назвал: Сбер, Тинькофф/T-Bank и т.д."),
      payerName: z.string().optional().describe("Имя плательщика, если известно."),
      thirdPartyApproved: z
        .boolean()
        .optional()
        .describe("true только если оператор явно разрешил перевод от третьего лица."),
      payoutMethod: PayoutMethodEnum,
      payoutLocation: z
        .string()
        .optional()
        .describe("Локация/банк выдачи: отель, Bangkok Bank, SCB, KBank, офис и т.д."),
      payoutDestination: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Структурированные данные выдачи: hotel/location, atmBank, thaiBankName, thaiAccountLast4 и т.д.",
        ),
    }),
    execute: async (args) => {
      // Источник правды для незаданных аргументов: АКТИВНАЯ заявка (подтверждённая
      // сделка), затем собранные поля. Иначе создание брало протухшее значение из
      // leadFieldValues, хотя активная заявка про другую сумму.
      const collected = await readExchangeCollectedFields(db, tenantId, conversationId);
      const active = await findActiveOrder(db, tenantId, conversationId);
      const assetArg = args.asset ?? active?.assetFrom ?? collected.asset;
      const amountArg =
        args.amount ?? active?.requestedAmount ?? active?.amountFrom ?? collected.amount;
      const networkArg = args.network ?? active?.network ?? collected.network;
      const paymentMethodArg =
        args.paymentMethod ?? active?.paymentMethod ?? collected.paymentMethod;
      const payoutMethodArg = args.payoutMethod ?? active?.payoutMethod ?? collected.payoutMethod;
      if (!assetArg || amountArg === undefined) {
        return { error: "Не хватает данных для заявки: уточните, что меняете и на какую сумму." };
      }
      const q = await computeQuote(db, tenantId, {
        asset: assetArg,
        amount: amountArg,
        amountMode: args.amountMode,
        network: networkArg,
      });
      if (!q.ok) {
        if (q.guard?.tripped) onGuardTrip(assetArg, networkArg, q.guard);
        return { error: q.error };
      }

      const verification = await getExchangeVerificationStatus(db, tenantId, conversationId);
      if (!verification.verified) {
        await moveExchangeLeadToStage({
          db,
          tenantId,
          conversationId,
          stageSlug: "kyc_collection",
        });
        return {
          ok: false,
          needsVerification: true,
          status: verification.status,
          instructions:
            "Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.",
        };
      }

      const asset = normAsset(assetArg);
      const network = resolveNetwork(asset, networkArg);
      const amountMode = args.amountMode === "target_thb" ? "target_thb" : "source_amount";
      const idempotencyKey = `conv:${conversationId}:${asset}:${network}:${amountMode}:${amountArg}`;

      const existing = await getOrderByIdempotencyKey(db, tenantId, idempotencyKey);
      if (existing && isReusableOrderStatus(existing.status)) {
        // Заявка ещё живая — возвращаем её (истинная идемпотентность).
        await moveExchangeLeadToStage({
          db,
          tenantId,
          conversationId,
          stageSlug: "order_created",
        });
        return {
          orderId: existing.id,
          status: existing.status,
          direction: existing.direction,
          amountToThb: existing.amountToThb,
          rate: existing.rate,
          idempotent: true,
        };
      }
      if (existing) {
        // Заявка протухла/отменена/завершена, но ключ идемпотентности
        // детерминированный (conv+asset+amount) — без этого повторный заказ той
        // же суммы вечно «попадал» в мёртвую заявку, новую создать нельзя, а
        // fetch_exchange_requisites её не видит. Освобождаем ключ → создаём свежую.
        await releaseOrderIdempotencyKey(db, tenantId, existing.id);
      }

      // Вытесняем зависшие до-оплатные заявки (другой/протухший расчёт), чтобы блок
      // «уже есть незавершённая заявка» не стопорил ПОДТВЕРЖДЁННОЕ создание.
      // Идемпотентно переиспользуемую заявку уже вернули выше; заявки с поступившей
      // оплатой cancelOpenExchangeOrders НЕ трогает → assessOrderRisk ниже корректно
      // остановит (деньги в движении → оператор).
      await cancelOpenExchangeOrders(db, tenantId, conversationId);

      const parties = await resolveConversationParties(db, tenantId, conversationId);
      const risk = await assessOrderRisk(db, tenantId, {
        conversationId,
        contactId: parties.contactId,
        amountToThb: q.amountToThb,
      });
      if (!risk.ok) return { error: risk.reasons.join(" ") };

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
        requestedAmount: amountArg,
        rate: q.rate,
        amountToThb: q.amountToThb,
        paymentMethod: paymentMethodArg ?? (isCryptoAsset(asset) ? "crypto_transfer" : null),
        paymentRail: args.paymentRail ?? (isCryptoAsset(asset) ? network : null),
        sourceBank: args.sourceBank ?? null,
        payerName: args.payerName ?? null,
        thirdPartyApproved: args.thirdPartyApproved ?? false,
        payoutMethod: payoutMethodArg ?? null,
        payoutLocation: args.payoutLocation ?? null,
        payoutDestinationJson: args.payoutDestination
          ? JSON.stringify(args.payoutDestination)
          : null,
        verificationId: verification.verificationId,
        riskJson: JSON.stringify({
          ok: true,
          decision: risk.needsOperator ? "manual" : "pass",
          reasons: risk.reasons,
        }),
        rateExpiresAt,
        idempotencyKey,
      });
      // Заявка создана — продвигаем лида на order_created. Иначе он застревает
      // на quote_calculated, а fetch_exchange_requisites гейтится матрицей на
      // order_created/requisites_sent → реквизиты не выдать (лид «не двигается»).
      await moveExchangeLeadToStage({
        db,
        tenantId,
        conversationId,
        stageSlug: "order_created",
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

  const cancelOrderTool: AnyRagTool = {
    name: "cancel_exchange_order",
    description: [
      "Отменить заявку по ЯВНОЙ просьбе клиента ('отмени заявку', 'не хочу', 'передумал').",
      "Отменяет незавершённые ДО-оплатные заявки беседы. Если по заявке уже пришла оплата —",
      "НЕ отменяет, а передаёт оператору (needsOperator). Для смены суммы используй",
      "compute_exchange_quote, не этот инструмент.",
    ].join(" "),
    parameters: z.object({}),
    execute: async () => {
      const active = await findActiveOrder(db, tenantId, conversationId);
      const { cancelled, blockedByPayment } = await cancelOpenExchangeOrders(
        db,
        tenantId,
        conversationId,
      );
      if (blockedByPayment.length > 0) {
        return {
          ok: false,
          needsOperator: true,
          blockedByPayment,
          note: "По заявке уже поступила оплата — отмену подтверждает оператор.",
        };
      }
      if (cancelled.length === 0) {
        return { cancelled: [], note: "Активных заявок нет." };
      }
      await moveExchangeLeadToStage({
        db,
        tenantId,
        conversationId,
        stageSlug: "quote_calculated",
        allowBackward: true,
      });
      return {
        cancelled,
        ...(active
          ? {
              lastDeal: {
                asset: active.assetFrom,
                amount: active.requestedAmount ?? active.amountFrom,
                network: active.network,
              },
            }
          : {}),
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
      let order = await findActiveOrder(db, tenantId, conversationId);
      // Авто-восстановление: заявка протухла (TTL), но клиент всё ещё в сделке —
      // оживляем последнюю под текущий курс вместо дед-энда «Нет активной
      // заявки» (после которого бот эскалирует generic'ом). См. moveStage в
      // create/fetch — стадия уже order_created/requisites_sent.
      if (!order) {
        const latest = await getLatestOrderForConversation(db, tenantId, conversationId);
        if (latest && isRevivableOrderStatus(latest.status)) {
          const q = await computeQuote(db, tenantId, {
            asset: latest.assetFrom,
            amount: latest.requestedAmount ?? latest.amountFrom,
            amountMode: latest.amountMode as "source_amount" | "target_thb" | undefined,
            network: latest.network || undefined,
          });
          if (q.ok) {
            const ttlMin = isCryptoAsset(latest.assetFrom) ? 15 : 20;
            await reviveExpiredOrder(db, tenantId, latest.id, {
              rate: q.rate,
              amountFrom: q.amountFrom,
              amountToThb: q.amountToThb,
              rateExpiresAt: Math.floor(Date.now() / 1000) + ttlMin * 60,
            });
            order = await getOrderById(db, tenantId, latest.id);
          }
        }
      }
      if (!order) return { error: "Нет активной заявки. Сначала создай заявку." };

      const provider = getPaymentProvider({ db, tenantId, masterKeyHex });
      const req = await provider.getRequisites({
        asset: order.assetFrom,
        network: order.network,
        amountFrom: order.amountFrom,
        amountToThb: order.amountToThb,
        orderId: order.id,
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
      // Реквизиты получены и уходят клиенту — двигаем лида на requisites_sent.
      await moveExchangeLeadToStage({
        db,
        tenantId,
        conversationId,
        stageSlug: "requisites_sent",
      });
      if (req.kind === "crypto") {
        if (req.exchangeId) {
          const exchangeName = req.exchangeName ?? req.network ?? "exchange";
          return {
            orderId: order.id,
            kind: "crypto",
            paymentRail: order.paymentRail ?? req.network,
            exchangeId: req.exchangeId,
            exchangeName,
            ttlMin,
            instructions: `${exchangeName} UID/ID для перевода: ${req.exchangeId}\nРеквизиты действительны ${ttlMin} минут. Как переведёте — пришлите, пожалуйста, подтверждение, и я сразу проверю.`,
          };
        }
        const tagLine = req.destTag ? `\nMemo/tag: ${req.destTag}` : "";
        const paymentUrlLine = req.paymentUrl ? `\nСсылка оплаты: ${req.paymentUrl}` : "";
        return {
          orderId: order.id,
          kind: "crypto",
          address: req.address,
          network: req.network,
          destTag: req.destTag,
          paymentUrl: req.paymentUrl,
          invoiceToken: req.invoiceToken,
          expiresAt: req.expiresAt,
          currencyCode: req.currencyCode,
          ttlMin,
          amlNote: true,
          instructions: req.paymentUrl
            ? `Оплата ${order.assetFrom} (${req.network}) через WestWallet:${paymentUrlLine}\nАдрес: ${req.address}${tagLine}\nРеквизиты действительны ${ttlMin} минут. Все входящие транзакции проходят AML-проверку — переведите, пожалуйста, точную сумму с учётом сетевой комиссии. Как оплатите, пришлите подтверждение перевода.`
            : `Адрес для ${order.assetFrom} (${req.network}): ${req.address}${tagLine}\nАдрес действителен ${ttlMin} минут. Все входящие транзакции проходят AML-проверку — переведите, пожалуйста, точную сумму с учётом сетевой комиссии. Как отправите, пришлите tx hash или ссылку на транзакцию.`,
        };
      }
      if (req.detailsText) {
        return {
          orderId: order.id,
          kind: "fiat",
          paymentMethod: order.paymentMethod,
          detailsText: req.detailsText,
          ttlMin,
          instructions: `${req.detailsText}\nРеквизиты действительны ${ttlMin} минут. Как оплатите — пришлите, пожалуйста, развёрнутый чек, и я сразу всё проверю.`,
        };
      }
      return {
        orderId: order.id,
        kind: "fiat",
        paymentUrl: req.paymentUrl,
        ttlMin,
        instructions: `Оплатить можно по ссылке (СБП): ${req.paymentUrl}\nСсылка действует ${ttlMin} минут. Как оплатите — пришлите, пожалуйста, развёрнутый чек.`,
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
      proof: z.string().optional().describe("tx hash или ссылка на транзакцию (для крипты)"),
      sourceBank: z
        .string()
        .optional()
        .describe("Банк отправителя из чека: Сбер, Тинькофф/T-Bank и т.д."),
      receiptAmount: z
        .number()
        .positive()
        .optional()
        .describe("Сумма оплаты из чека в валюте оплаты, если удалось прочитать."),
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

      let issuedRequisites: Record<string, unknown> | null = null;
      try {
        issuedRequisites = order.requisitesJson ? JSON.parse(order.requisitesJson) : null;
      } catch {
        issuedRequisites = null;
      }

      if (
        issuedRequisites?.provider === "westwallet" &&
        typeof issuedRequisites.invoiceToken === "string"
      ) {
        const res = await verifyWestWalletInvoicePayment({
          db,
          tenantId,
          masterKeyHex,
          token: issuedRequisites.invoiceToken,
          expectedAmount: order.amountFrom,
        });
        await updateOrder(db, tenantId, order.id, {
          proofJson: JSON.stringify({
            kind: "westwallet_invoice",
            invoiceToken: issuedRequisites.invoiceToken,
            transaction: res.transaction ?? null,
            verifiedOk: res.ok,
            needsOperator: res.needsOperator ?? false,
          }),
          ...(res.ok ? { status: "paid" } : {}),
        });
        return {
          orderId: order.id,
          ok: res.ok,
          needsOperator: res.needsOperator ?? !res.ok,
          note: res.note,
        };
      }

      // Крипта без WestWallet invoice — нужен tx hash и адрес-получатель из выданных реквизитов.
      const txHash = args.proof ? extractTxHash(args.proof) : null;
      if (!txHash) {
        return { ok: false, error: "Пришлите, пожалуйста, tx hash транзакции или ссылку на неё." };
      }
      const toAddress =
        typeof issuedRequisites?.address === "string" ? issuedRequisites.address : undefined;
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
        maxAgeSeconds: resolveTxMaxAgeSeconds(),
      });

      if (res.ok) {
        const mark = await markOrderPaidWithUniqueTxHash(db, tenantId, order.id, {
          txHash: res.txHash ?? txHash,
          fromAddress: res.fromAddress ?? null,
          toAddress: res.toAddress ?? null,
          amount: res.amount ?? null,
          symbol: res.symbol ?? null,
          network: res.network ?? network,
          confirmedAt: res.confirmedAt ?? null,
          verifiedOk: true,
        });
        if (!mark.ok) {
          await updateOrder(db, tenantId, order.id, {
            proofJson: JSON.stringify({
              txHash: res.txHash ?? txHash,
              fromAddress: res.fromAddress,
              toAddress: res.toAddress,
              amount: res.amount,
              symbol: res.symbol,
              network: res.network,
              confirmedAt: res.confirmedAt,
              verifiedOk: false,
              needsOperator: true,
              duplicateOrderId: mark.duplicateOrderId,
              reason: "tx_hash_replay",
            }),
          });
          return {
            orderId: order.id,
            ok: false,
            needsOperator: true,
            duplicateOrderId: mark.duplicateOrderId,
            reason: "Этот tx hash уже использован в другой заявке — нужна проверка оператора.",
          };
        }
        return {
          orderId: order.id,
          ok: true,
          fromAddress: res.fromAddress,
          amount: res.amount,
          note: "Оплата поступила. Можно готовить выдачу.",
        };
      }
      await updateOrder(db, tenantId, order.id, {
        proofJson: JSON.stringify({
          txHash: res.txHash ?? txHash,
          fromAddress: res.fromAddress,
          toAddress: res.toAddress,
          amount: res.amount,
          symbol: res.symbol,
          network: res.network ?? network,
          confirmedAt: res.confirmedAt,
          verifiedOk: false,
          needsOperator: res.needsOperator ?? false,
          reason: res.reason,
        }),
      });
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
      `Выдать получение ${QUOTE_CURRENCY.code} по оплаченной заявке. payoutMethod: office (код в офисе)`,
      "или atm (cardless в банкомате). location: офис (напр. Бангтао) или банк (Kbank/Bangkok Bank/SCB).",
      "Код снятия приходит от провайдера/оператора — НЕ выдумывай его. Если кода ещё нет —",
      "вернётся needsOperator: попроси оператора подготовить код.",
    ].join(" "),
    parameters: z.object({
      payoutMethod: z.enum([
        "office_cash",
        "cardless_atm",
        "courier_cash",
        "thai_bank_transfer",
        "atm",
      ]),
      location: z.string().describe("Офис (Бангтао) или банк банкомата (Kbank/Bangkok Bank/SCB)"),
      destination: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Структурированные детали выдачи: банк, отель, адрес, последние цифры счёта."),
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
        payoutDestinationJson: args.destination
          ? JSON.stringify(args.destination)
          : order.payoutDestinationJson,
      });

      // Код выдачи не генерируется ботом. Если оператор уже проставил payout_code —
      // отдаём его клиенту; иначе сигнализируем needsOperator. Просроченный код
      // (payout_code_expires_at < now) НЕ выдаём — это снова кейс оператора.
      const fresh = await findActiveOrder(db, tenantId, conversationId);
      const nowSec = Math.floor(Date.now() / 1000);
      const codeExpired = fresh?.payoutCodeExpiresAt != null && fresh.payoutCodeExpiresAt < nowSec;
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

  // A3: бизнес-настройки обменника из tenant_secrets — часы работы, контакт
  // оператора, способы выдачи, KYC-политика, адреса офисов. Бот отвечает
  // «когда работаете / какие документы / как получить / куда подойти» из
  // настроек, не выдумывая.
  const businessInfoTool: AnyRagTool = {
    name: "get_exchange_business_info",
    description: [
      "Справочные данные обменника: часы работы, контакт оператора, способы выдачи,",
      "KYC-политика (какие документы нужны), адреса офисов. Вызывай, когда клиент",
      "спрашивает «во сколько работаете», «как получить», «какие документы», «где офис»,",
      "«как связаться». Если officeAddresses содержит несколько вариантов — предложи клиенту выбрать офис.",
      "Отвечай ТОЛЬКО тем, что вернул инструмент; пустые поля не выдумывай.",
    ].join(" "),
    parameters: z.object({}),
    execute: async () => {
      const [
        workingHours,
        operatorContactLegacy,
        operatorTelegram,
        operatorWhatsapp,
        operatorLine,
        payoutMethodsLegacy,
        payoutBankMethods,
        payoutCashMethods,
        amlPolicy,
        kycPolicy,
        officeAddress,
      ] = await withTenant(db, tenantId, (tx) =>
        Promise.all([
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_working_hours",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_operator_contact",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_operator_telegram",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_operator_whatsapp",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_operator_line",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_payout_methods",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_payout_bank_methods",
            masterKeyHex,
          }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_payout_cash_methods",
            masterKeyHex,
          }),
          getDecryptedSecret({ db: tx as Db, tenantId, key: "exchange_aml_policy", masterKeyHex }),
          getDecryptedSecret({ db: tx as Db, tenantId, key: "exchange_kyc_policy", masterKeyHex }),
          getDecryptedSecret({
            db: tx as Db,
            tenantId,
            key: "exchange_office_address",
            masterKeyHex,
          }),
        ]),
      );
      const operatorContact =
        compactInfoLines([
          operatorTelegram ? `Telegram: ${operatorTelegram}` : null,
          operatorWhatsapp ? `WhatsApp: ${operatorWhatsapp}` : null,
          operatorLine ? `Line: ${operatorLine}` : null,
        ]) ?? operatorContactLegacy;
      const payoutMethods =
        compactInfoLines([
          payoutBankMethods ? `Банки: ${payoutBankMethods}` : null,
          payoutCashMethods ? `Наличные/офис/курьер: ${payoutCashMethods}` : null,
        ]) ?? payoutMethodsLegacy;
      const policy = compactInfoLines([
        amlPolicy ? `AML: ${amlPolicy}` : null,
        kycPolicy ? `KYC: ${kycPolicy}` : null,
      ]);
      const officeAddresses = parseOfficeAddresses(officeAddress);
      const info: Record<string, string | string[]> = {};
      if (workingHours) info.workingHours = workingHours;
      if (operatorContact) info.operatorContact = operatorContact;
      if (payoutMethods) info.payoutMethods = payoutMethods;
      if (policy) info.kycPolicy = policy;
      if (officeAddress) info.officeAddress = officeAddress;
      if (officeAddresses.length > 0) info.officeAddresses = officeAddresses;
      if (Object.keys(info).length === 0) {
        return {
          note: "Справочные данные не заданы оператором. Подскажи, что уточнишь у оператора.",
        };
      }
      return info;
    },
  };

  const resolveCurrentStage = () => resolveLeadStageSlug(db, tenantId, conversationId);
  const guarded = [
    computeQuoteTool,
    checkVerificationTool,
    createOrderTool,
    cancelOrderTool,
    fetchRequisitesTool,
    // Оплата: ok → payment_verified; чек принят (needsOperator) → ждём оператора.
    withStageAdvance(verifyPaymentTool, db, tenantId, conversationId, (r) =>
      r.ok === true
        ? "payment_verified"
        : r.needsOperator === true && typeof r.orderId === "number"
          ? "payment_proof_waiting"
          : null,
    ),
    // Выдача запущена (статус payout проставлен) → финальная стадия.
    withStageAdvance(issuePayoutTool, db, tenantId, conversationId, (r) =>
      typeof r.orderId === "number" && !r.error ? "payout_or_completion" : null,
    ),
    businessInfoTool,
  ].map((tool) => withExchangeStageGuard(tool, stageSlug, resolveCurrentStage));

  // Policy-текст (текущая стадия + разрешённые инструменты) добавляем ОДИН раз —
  // в описание первого инструмента, а не дублируем во все ~7. Модель видит его как
  // глобальную подсказку; корректность всё равно держит per-tool guard выше.
  const policyBlock = exchangeAllowedActionsBlock(stageSlug);
  if (policyBlock && guarded[0]) {
    guarded[0] = { ...guarded[0], description: `${guarded[0].description} ${policyBlock}` };
  }
  return guarded;
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
