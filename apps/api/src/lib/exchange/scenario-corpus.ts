import type { OperatorHandoffMeta } from "@chatman-media/channel-core";
import type { ExchangeGoldenCase } from "./golden-eval.ts";

export type ExchangeSelfPlayScenarioTag =
  | "rub"
  | "usdt"
  | "office_pickup"
  | "cash"
  | "thai_bank_transfer"
  | "cardless_atm"
  | "kyc"
  | "media"
  | "payment_proof"
  | "missing_fields"
  | "rate_change"
  | "exception";

export type ExchangeExpectedOrderStatus =
  | "quote"
  | "awaiting_payment"
  | "paid"
  | "payout"
  | "completed"
  | "cancelled"
  | "expired";

export interface ExchangeScenarioFieldExpectation {
  key: string;
  required: boolean;
  value?: string | number | boolean;
  oneOf?: readonly string[];
  source: "client" | "tool" | "operator" | "fixture";
}

export interface ExchangeScenarioOrderExpectation {
  status: ExchangeExpectedOrderStatus;
  paymentMethod?: string;
  paymentRail?: string;
  payoutMethod?: string;
  payoutLocation?: string;
}

export interface ExchangeScenarioReplyAssertion {
  id: string;
  description: string;
  mustIncludeAny?: readonly string[];
  mustNotIncludeAny?: readonly string[];
}

export interface ExchangeSelfPlayScenario {
  id: string;
  title: string;
  tags: readonly ExchangeSelfPlayScenarioTag[];
  sourceFixtureId?: string;
  clientScript: readonly string[];
  expectedWorkflow: readonly string[];
  expectedFields: readonly ExchangeScenarioFieldExpectation[];
  expectedStages: readonly string[];
  expectedOrder?: ExchangeScenarioOrderExpectation;
  expectedHandoffs: readonly OperatorHandoffMeta["reason"][];
  criticalReplyAssertions: readonly ExchangeScenarioReplyAssertion[];
  debugHint: string;
}

export interface ExchangeScenarioCorpusReport {
  ok: boolean;
  scenarioId?: string;
  total: number;
  scenarios: Array<{
    id: string;
    title: string;
    sourceFixtureId?: string;
    tags: readonly ExchangeSelfPlayScenarioTag[];
    expectedStages: readonly string[];
    expectedHandoffs: readonly OperatorHandoffMeta["reason"][];
    expectedOrderStatus?: ExchangeExpectedOrderStatus;
    criticalReplyAssertions: readonly string[];
  }>;
  failures: Array<{
    scenarioId: string;
    expected: string;
    actual: string;
  }>;
}

const COMMON_NO_UNBACKED_PROMISES: ExchangeScenarioReplyAssertion = {
  id: "no-unbacked-promises",
  description:
    "Bot must not promise rate, requisites, payout code, ETA, or completion without tool/operator state.",
  mustNotIncludeAny: [
    "точно готово",
    "оплата подтверждена",
    "код выдачи 123",
    "курьер будет через 10 минут",
  ],
};

export const EXCHANGE_SELF_PLAY_SCENARIOS: readonly ExchangeSelfPlayScenario[] = [
  {
    id: "rub-office-pickup-payment-proof",
    title: "RUB payment to THB office pickup with receipt review",
    tags: ["rub", "office_pickup", "payment_proof"],
    sourceFixtureId: "rub-qr-atm-first-time-faq",
    clientScript: [
      "Хочу поменять 100000 рублей на баты, оплатить со Сбера.",
      "Получение хочу в офисе Bangkok Asok сегодня с 15:00 до 16:00.",
      "Курс подходит, подготовьте реквизиты.",
      "[PHOTO: payment receipt]",
    ],
    expectedWorkflow: [
      "intent_exchange",
      "direction_rub_to_thb",
      "rate_quote",
      "requisites_card",
      "receipt_request",
      "office_pickup",
    ],
    expectedFields: [
      { key: "asset", required: true, value: "RUB", source: "client" },
      { key: "amount_from", required: true, value: 100000, source: "client" },
      {
        key: "payment_rail",
        required: true,
        oneOf: ["sber", "bank_transfer", "card_transfer"],
        source: "client",
      },
      {
        key: "payout_method",
        required: true,
        value: "office_cash",
        source: "client",
      },
      {
        key: "payout_location",
        required: true,
        value: "Bangkok Asok",
        source: "client",
      },
      {
        key: "pickup_window",
        required: true,
        value: "15:00-16:00",
        source: "client",
      },
      { key: "payment_proof", required: true, source: "fixture" },
    ],
    expectedStages: [
      "exchange_request",
      "quote_calculated",
      "order_created",
      "requisites_sent",
      "payment_proof_waiting",
      "payment_review",
      "payout",
    ],
    expectedOrder: {
      status: "payout",
      paymentMethod: "bank_transfer",
      paymentRail: "sber",
      payoutMethod: "office_cash",
      payoutLocation: "Bangkok Asok",
    },
    expectedHandoffs: ["payment_review", "office_payout"],
    criticalReplyAssertions: [
      {
        id: "receipt-pending",
        description: "Receipt upload must be acknowledged as pending operator/payment review.",
        mustIncludeAny: ["провер", "оператор", "поступлен", "чек"],
        mustNotIncludeAny: ["оплата подтверждена", "можете забирать"],
      },
      COMMON_NO_UNBACKED_PROMISES,
    ],
    debugHint:
      "Use this to catch premature payment confirmation and missing office confirmation state.",
  },
  {
    id: "usdt-trc20-cash-delivery",
    title: "USDT/TRC20 to THB cash flow",
    tags: ["usdt", "cash"],
    sourceFixtureId: "usdt-trc20-wallet-delivery-60k-thb",
    clientScript: [
      "Добрый день. Нужно поменять 2000 USDT TRC20 на баты.",
      "Получить хочу наличными, район Pratamnak.",
      "Курс подходит, скидывайте кошелек.",
      "Отправил tx hash TMOCKTRXHASH.",
    ],
    expectedWorkflow: [
      "intent_exchange",
      "direction_usdt_to_thb",
      "rate_quote",
      "requisites_crypto_wallet",
      "delivery_or_atm_clarification",
    ],
    expectedFields: [
      { key: "asset", required: true, value: "USDT", source: "client" },
      { key: "network", required: true, value: "trc20", source: "client" },
      { key: "amount_from", required: true, value: 2000, source: "client" },
      {
        key: "payout_method",
        required: true,
        oneOf: ["courier_cash", "office_cash"],
        source: "client",
      },
      {
        key: "payout_location",
        required: true,
        value: "Pratamnak",
        source: "client",
      },
      { key: "tx_hash", required: true, source: "client" },
    ],
    expectedStages: [
      "exchange_request",
      "quote_calculated",
      "order_created",
      "requisites_sent",
      "payment_proof_waiting",
      "payment_verified",
    ],
    expectedOrder: {
      status: "paid",
      paymentMethod: "crypto_transfer",
      paymentRail: "trc20",
      payoutMethod: "courier_cash",
      payoutLocation: "Pratamnak",
    },
    expectedHandoffs: [],
    criticalReplyAssertions: [
      {
        id: "wallet-from-tool",
        description: "Wallet/requisites must come from configured tool state.",
        mustIncludeAny: ["trc20", "кошел", "адрес"],
        mustNotIncludeAny: ["уточню кошелек", "любой адрес"],
      },
      COMMON_NO_UNBACKED_PROMISES,
    ],
    debugHint: "Use this to verify crypto flow can progress without unnecessary operator handoff.",
  },
  {
    id: "usdt-to-thai-bank-transfer",
    title: "USDT/TRC20 to Thai bank transfer",
    tags: ["usdt", "thai_bank_transfer"],
    clientScript: [
      "Меняю 1500 USDT TRC20, получить хочу на Bangkok Bank.",
      "Счет 123-4-56789-0, имя Alexander K.",
      "Подтверждаю, подготовьте адрес.",
    ],
    expectedWorkflow: [
      "intent_exchange",
      "direction_usdt_to_thb",
      "rate_quote",
      "thai_bank_payout",
      "requisites_crypto_wallet",
    ],
    expectedFields: [
      { key: "asset", required: true, value: "USDT", source: "client" },
      { key: "network", required: true, value: "trc20", source: "client" },
      { key: "amount_from", required: true, value: 1500, source: "client" },
      {
        key: "payout_method",
        required: true,
        value: "thai_bank_transfer",
        source: "client",
      },
      {
        key: "thai_bank_name",
        required: true,
        value: "Bangkok Bank",
        source: "client",
      },
    ],
    expectedStages: ["exchange_request", "quote_calculated", "order_created", "requisites_sent"],
    expectedOrder: {
      status: "awaiting_payment",
      paymentMethod: "crypto_transfer",
      paymentRail: "trc20",
      payoutMethod: "thai_bank_transfer",
      payoutLocation: "Bangkok Bank",
    },
    expectedHandoffs: [],
    criticalReplyAssertions: [
      {
        id: "collect-bank-before-payout",
        description: "Bot must collect bank details before promising transfer.",
        mustIncludeAny: ["bangkok bank", "счет", "реквиз"],
        mustNotIncludeAny: ["перевод отправлен", "деньги ушли"],
      },
    ],
    debugHint: "Use this to check non-cash fulfilment fields and no premature transfer promise.",
  },
  {
    id: "rate-first-then-amount-network-change",
    title: "Client asks rate, then changes amount/network",
    tags: ["usdt", "rate_change"],
    clientScript: [
      "Какой сейчас курс USDT к батам?",
      "Сначала думал 1000 USDT TRC20, давайте посчитаем.",
      "Нет, сделаем 2500 USDT, и можно ли через Binance ID?",
    ],
    expectedWorkflow: [
      "intent_exchange",
      "rate_quote",
      "amount_usdt_or_thb_clarification",
      "requisites_binance_id",
    ],
    expectedFields: [
      { key: "asset", required: true, value: "USDT", source: "client" },
      { key: "amount_from", required: true, value: 2500, source: "client" },
      {
        key: "payment_rail",
        required: true,
        value: "binance_id",
        source: "client",
      },
    ],
    expectedStages: ["exchange_request", "quote_calculated", "order_created"],
    expectedOrder: {
      status: "awaiting_payment",
      paymentMethod: "crypto_transfer",
      paymentRail: "binance_id",
    },
    expectedHandoffs: [],
    criticalReplyAssertions: [
      {
        id: "recompute-after-change",
        description: "Changed amount/rail must trigger a fresh quote/order context.",
        mustIncludeAny: ["2500", "binance", "пересч"],
        mustNotIncludeAny: ["1000 usdt подтверждаю"],
      },
      COMMON_NO_UNBACKED_PROMISES,
    ],
    debugHint: "Use this to catch stale quote reuse after the customer changes terms.",
  },
  {
    id: "missing-required-fields",
    title: "Missing asset, amount, rail and payout method",
    tags: ["missing_fields"],
    clientScript: ["Хочу поменять деньги на баты. Что надо?"],
    expectedWorkflow: ["intent_exchange", "missing_fields"],
    expectedFields: [
      { key: "asset", required: true, source: "client" },
      { key: "amount", required: true, source: "client" },
      { key: "payout_method", required: true, source: "client" },
    ],
    expectedStages: ["exchange_request"],
    expectedHandoffs: [],
    criticalReplyAssertions: [
      {
        id: "ask-next-field",
        description: "Bot asks for missing required fields instead of guessing.",
        mustIncludeAny: ["сумм", "валют", "получить", "способ"],
        mustNotIncludeAny: ["курс", "реквизит", "оплатите"],
      },
    ],
    debugHint: "Use this as the intake sanity check for no premature tools.",
  },
  {
    id: "kyc-media-verification",
    title: "KYC photo/document/video branch creates verification handoff",
    tags: ["rub", "kyc", "media", "cardless_atm"],
    sourceFixtureId: "rub-qr-kyc-cardless-atm-12900-thb",
    clientScript: [
      "Хочу оплатить через QR 35000 рублей, получить в зеленом банкомате.",
      "Я первый раз, вот фото паспорта и короткое видео.",
      "[PHOTO: passport]",
      "[VIDEO_NOTE: face verification]",
    ],
    expectedWorkflow: [
      "intent_exchange",
      "payment_method_qr",
      "kyc_required",
      "document_upload",
      "atm_presence_check",
    ],
    expectedFields: [
      { key: "asset", required: true, value: "RUB", source: "client" },
      {
        key: "payment_method",
        required: true,
        value: "sbp_qr",
        source: "client",
      },
      { key: "kyc_document", required: true, source: "fixture" },
      { key: "kyc_video", required: true, source: "fixture" },
    ],
    expectedStages: ["exchange_request", "verification_check", "kyc_collection", "risk_review"],
    expectedOrder: {
      status: "quote",
      paymentMethod: "sbp_qr",
      payoutMethod: "cardless_atm",
    },
    expectedHandoffs: ["kyc_review"],
    criticalReplyAssertions: [
      {
        id: "kyc-pending",
        description: "Media/documents must become pending verification, not auto-approved.",
        mustIncludeAny: ["верификац", "провер", "оператор"],
        mustNotIncludeAny: ["kyc пройден", "верификация подтверждена"],
      },
    ],
    debugHint: "Use this to catch media being treated as plain chat text or auto-approved KYC.",
  },
  {
    id: "fiat-payment-proof-review",
    title: "Fiat receipt upload creates payment-review handoff",
    tags: ["rub", "payment_proof"],
    sourceFixtureId: "rub-qr-bank-transfer-to-bangkok-bank",
    clientScript: [
      "Оплатил по QR, вот чек.",
      "[PHOTO: bank receipt]",
      "Можно отправлять баты на Bangkok Bank?",
    ],
    expectedWorkflow: ["receipt_request", "payment_link_ttl", "thai_bank_payout"],
    expectedFields: [
      { key: "payment_proof", required: true, source: "fixture" },
      {
        key: "source_bank",
        required: false,
        oneOf: ["Sber", "T-Bank"],
        source: "client",
      },
      {
        key: "thai_bank_name",
        required: true,
        value: "Bangkok Bank",
        source: "client",
      },
    ],
    expectedStages: ["payment_proof_waiting", "payment_review"],
    expectedOrder: {
      status: "awaiting_payment",
      paymentMethod: "sbp_qr",
      payoutMethod: "thai_bank_transfer",
      payoutLocation: "Bangkok Bank",
    },
    expectedHandoffs: ["payment_review"],
    criticalReplyAssertions: [
      {
        id: "do-not-confirm-fiat-receipt",
        description: "Fiat receipt must stay under operator review.",
        mustIncludeAny: ["чек", "провер", "оператор"],
        mustNotIncludeAny: ["оплата подтверждена", "перевод отправлен"],
      },
    ],
    debugHint: "Use this to verify RUB receipts do not move straight to paid without review.",
  },
  {
    id: "unsupported-city-out-of-hours",
    title: "Unsupported city and out-of-hours availability exception",
    tags: ["exception", "cash"],
    clientScript: [
      "Я в Чианграе, сейчас 02:30 ночи. Нужно срочно 30000 бат наличными.",
      "Можете сказать точное время курьера и сразу принять оплату?",
    ],
    expectedWorkflow: ["intent_exchange", "unsupported_city", "out_of_hours", "operator_request"],
    expectedFields: [
      { key: "city", required: true, value: "Chiang Rai", source: "client" },
      {
        key: "amount_to_thb",
        required: true,
        value: 30000,
        source: "client",
      },
      {
        key: "requested_time",
        required: true,
        value: "02:30",
        source: "client",
      },
    ],
    expectedStages: ["exchange_request", "risk_review"],
    expectedHandoffs: ["operator_request"],
    criticalReplyAssertions: [
      {
        id: "no-fake-eta",
        description: "Bot must not invent courier availability in unsupported city/out-of-hours.",
        mustIncludeAny: ["оператор", "уточ", "город", "время"],
        mustNotIncludeAny: ["курьер будет через", "точно сможем", "оплатите сейчас"],
      },
    ],
    debugHint: "Use this to catch fabricated availability, ETA, and unsupported coverage promises.",
  },
  {
    id: "rate-stale-limit-cancelled",
    title: "Stale rate, limit exception and cancellation",
    tags: ["exception", "rate_change"],
    clientScript: [
      "У меня курс из вчерашнего сообщения, поменяйте по нему 50 USDT.",
      "Если нельзя, тогда отменяю.",
    ],
    expectedWorkflow: ["intent_exchange", "rate_stale", "below_limit", "cancelled_order"],
    expectedFields: [
      { key: "asset", required: true, value: "USDT", source: "client" },
      { key: "amount_from", required: true, value: 50, source: "client" },
      { key: "cancelled", required: true, value: true, source: "client" },
    ],
    expectedStages: ["exchange_request", "terminal_lost"],
    expectedOrder: { status: "cancelled", paymentMethod: "crypto_transfer" },
    expectedHandoffs: [],
    criticalReplyAssertions: [
      {
        id: "fresh-rate-or-cancel",
        description: "Bot must not reuse stale rate or force flow after explicit cancellation.",
        mustIncludeAny: ["актуальн", "миним", "отмен"],
        mustNotIncludeAny: ["старый курс подтверждаю", "оплатите"],
      },
    ],
    debugHint: "Use this to catch stale quote reuse and ignoring cancellation intent.",
  },
] as const;

export function getExchangeSelfPlayScenario(id: string): ExchangeSelfPlayScenario | null {
  return EXCHANGE_SELF_PLAY_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function selectExchangeSelfPlayScenarios(
  scenarioId?: string | null,
): readonly ExchangeSelfPlayScenario[] {
  if (!scenarioId) return EXCHANGE_SELF_PLAY_SCENARIOS;
  const scenario = getExchangeSelfPlayScenario(scenarioId);
  if (!scenario) {
    throw new Error(
      `Unknown exchange scenario "${scenarioId}". Available: ${EXCHANGE_SELF_PLAY_SCENARIOS.map((item) => item.id).join(", ")}`,
    );
  }
  return [scenario];
}

function duplicateIds(items: readonly ExchangeSelfPlayScenario[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) dupes.add(item.id);
    seen.add(item.id);
  }
  return [...dupes];
}

export function runExchangeSelfPlayScenarioCorpus(
  input: { scenarioId?: string | null; fixtureCases?: readonly ExchangeGoldenCase[] } = {},
): ExchangeScenarioCorpusReport {
  const scenarios = selectExchangeSelfPlayScenarios(input.scenarioId);
  const fixtureIds = new Set((input.fixtureCases ?? []).map((item) => item.id));
  const failures: ExchangeScenarioCorpusReport["failures"] = [];

  for (const duplicate of duplicateIds(EXCHANGE_SELF_PLAY_SCENARIOS)) {
    failures.push({
      scenarioId: duplicate,
      expected: "unique scenario id",
      actual: "duplicate id in corpus",
    });
  }

  for (const scenario of scenarios) {
    if (scenario.clientScript.length === 0) {
      failures.push({
        scenarioId: scenario.id,
        expected: "at least one deterministic client turn",
        actual: "clientScript is empty",
      });
    }
    if (scenario.expectedFields.filter((field) => field.required).length === 0) {
      failures.push({
        scenarioId: scenario.id,
        expected: "required field expectations",
        actual: "no required expectedFields",
      });
    }
    if (scenario.expectedStages.length === 0) {
      failures.push({
        scenarioId: scenario.id,
        expected: "expected workflow stages",
        actual: "expectedStages is empty",
      });
    }
    if (scenario.criticalReplyAssertions.length === 0) {
      failures.push({
        scenarioId: scenario.id,
        expected: "critical reply assertions",
        actual: "criticalReplyAssertions is empty",
      });
    }
    if (
      scenario.sourceFixtureId &&
      input.fixtureCases &&
      !fixtureIds.has(scenario.sourceFixtureId)
    ) {
      failures.push({
        scenarioId: scenario.id,
        expected: `fixture ${scenario.sourceFixtureId}`,
        actual: "fixture id not found in exchange-workflows.jsonl",
      });
    }
  }

  return {
    ok: failures.length === 0,
    ...(input.scenarioId ? { scenarioId: input.scenarioId } : {}),
    total: scenarios.length,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      ...(scenario.sourceFixtureId ? { sourceFixtureId: scenario.sourceFixtureId } : {}),
      tags: scenario.tags,
      expectedStages: scenario.expectedStages,
      expectedHandoffs: scenario.expectedHandoffs,
      ...(scenario.expectedOrder ? { expectedOrderStatus: scenario.expectedOrder.status } : {}),
      criticalReplyAssertions: scenario.criticalReplyAssertions.map((assertion) => assertion.id),
    })),
    failures,
  };
}

export function formatExchangeSelfPlayScenarioReport(report: ExchangeScenarioCorpusReport): string {
  const header = [
    `exchange self-play corpus: ${report.ok ? "ok" : "failed"}`,
    `scenarios=${report.total}`,
    report.scenarioId ? `scenario=${report.scenarioId}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [header];
  for (const scenario of report.scenarios) {
    lines.push(
      [
        `- ${scenario.id}`,
        `tags=${scenario.tags.join(",")}`,
        `stages=${scenario.expectedStages.join(">")}`,
        scenario.expectedHandoffs.length > 0
          ? `handoffs=${scenario.expectedHandoffs.join(",")}`
          : "handoffs=none",
        scenario.expectedOrderStatus ? `order=${scenario.expectedOrderStatus}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (report.failures.length > 0) {
    lines.push("", "failures:");
    for (const failure of report.failures) {
      lines.push(
        [
          `scenario=${failure.scenarioId}`,
          `expected=${failure.expected}`,
          `actual=${failure.actual}`,
        ].join(" "),
      );
    }
  }
  return lines.join("\n");
}
