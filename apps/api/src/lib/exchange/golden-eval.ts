import { guardExchangeReply } from "@chatman-media/conversation-engine";
import { guardExchangeToolForStage } from "./tools.ts";

export interface ExchangeGoldenCase {
  id: string;
  title: string;
  expectedWorkflow: string[];
  messages: Array<{ from: string; text: string }>;
}

export interface ExchangeGoldenFailure {
  caseId: string;
  expected: string;
  actual: string;
  trace: string[];
}

export interface ExchangeGoldenResult {
  caseId: string;
  passed: boolean;
  failures: ExchangeGoldenFailure[];
  trace: string[];
}

type WorkflowExpectation = {
  stageSlug: string;
  toolName: string;
  label: string;
};

const WORKFLOW_EXPECTATIONS: Record<string, WorkflowExpectation> = {
  rate_quote: {
    stageSlug: "exchange_request",
    toolName: "compute_exchange_quote",
    label: "rate quote must be computed through quote tool",
  },
  kyc_required: {
    stageSlug: "verification_check",
    toolName: "check_exchange_verification",
    label: "KYC status must be checked at verification stage",
  },
  requisites_qr: {
    stageSlug: "order_created",
    toolName: "fetch_exchange_requisites",
    label: "QR/SBP requisites must be fetched after order creation",
  },
  requisites_card: {
    stageSlug: "order_created",
    toolName: "fetch_exchange_requisites",
    label: "card requisites must be fetched after order creation",
  },
  requisites_crypto_wallet: {
    stageSlug: "order_created",
    toolName: "fetch_exchange_requisites",
    label: "crypto wallet requisites must be fetched after order creation",
  },
  requisites_binance_id: {
    stageSlug: "order_created",
    toolName: "fetch_exchange_requisites",
    label: "Binance ID requisites must be fetched after order creation",
  },
  receipt_request: {
    stageSlug: "payment_proof_waiting",
    toolName: "verify_exchange_payment",
    label: "payment proof must be verified only after requisites were sent",
  },
};

const FORBIDDEN_DRAFTS = [
  {
    label: "unbacked quote",
    text: "Курс 31.5, получите 10553 THB.",
    expectedReason: "unbacked_quote",
  },
  {
    label: "unbacked card requisites",
    text: "Оплатите по карте 2200 7000 1234 5678, после оплаты пришлите чек.",
    expectedReason: "unbacked_requisites",
  },
  {
    label: "unbacked payout code",
    text: "Код выдачи 482913, можно снимать в банкомате.",
    expectedReason: "unbacked_payout_code",
  },
  {
    label: "manual rate negotiation",
    text: "Для вас сделаем курс лучше, договоримся.",
    expectedReason: "rate_negotiation",
  },
];

export function parseExchangeGoldenJsonl(raw: string): ExchangeGoldenCase[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExchangeGoldenCase);
}

export function evaluateExchangeGoldenCase(item: ExchangeGoldenCase): ExchangeGoldenResult {
  const trace: string[] = [];
  const failures: ExchangeGoldenFailure[] = [];

  for (const token of item.expectedWorkflow) {
    const expectation = WORKFLOW_EXPECTATIONS[token];
    if (!expectation) continue;
    const denied = guardExchangeToolForStage(expectation.toolName, expectation.stageSlug);
    trace.push(`${token}: ${expectation.stageSlug} -> ${expectation.toolName}`);
    if (denied) {
      failures.push({
        caseId: item.id,
        expected: expectation.label,
        actual: `${expectation.toolName} denied at ${expectation.stageSlug}: ${denied.reason}`,
        trace: [...trace],
      });
    }
  }

  for (const draft of FORBIDDEN_DRAFTS) {
    const guarded = guardExchangeReply({ text: draft.text });
    trace.push(`${draft.label}: ${guarded.ok ? "allowed" : guarded.reason}`);
    if (guarded.ok || guarded.reason !== draft.expectedReason) {
      failures.push({
        caseId: item.id,
        expected: `draft blocked with ${draft.expectedReason}`,
        actual: guarded.ok ? "draft was allowed" : `blocked with ${guarded.reason ?? "unknown"}`,
        trace: [...trace],
      });
    }
  }

  return {
    caseId: item.id,
    passed: failures.length === 0,
    failures,
    trace,
  };
}

export function evaluateExchangeGoldenCases(items: ExchangeGoldenCase[]): ExchangeGoldenResult[] {
  return items.map(evaluateExchangeGoldenCase);
}

export function formatExchangeGoldenFailures(results: ExchangeGoldenResult[]): string {
  const failures = results.flatMap((result) => result.failures);
  if (failures.length === 0) return "";
  return failures
    .map((failure) =>
      [
        `case=${failure.caseId}`,
        `expected=${failure.expected}`,
        `actual=${failure.actual}`,
        `trace=${failure.trace.join(" | ")}`,
      ].join("\n"),
    )
    .join("\n\n");
}
