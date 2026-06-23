import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXCHANGE_SAFE_FALLBACK,
  normalizeReplyStrategyResult,
  RagReplyStrategy,
  type RagTurnContext,
} from "@chatman-media/conversation-engine";
import type { ChatClient } from "@chatman-media/llm-router";
import type { AnyRagTool } from "@chatman-media/kb";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  evaluateExchangeGoldenCases,
  formatExchangeGoldenFailures,
  parseExchangeGoldenJsonl,
} from "./golden-eval.ts";

const fixturesPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "vertical-exchange",
  "evals",
  "exchange-workflows.jsonl",
);

function loadCases() {
  return parseExchangeGoldenJsonl(readFileSync(fixturesPath, "utf8"));
}

function firstReplyText(result: Awaited<ReturnType<RagReplyStrategy["generate"]>>): string {
  const normalized = normalizeReplyStrategyResult(result);
  const part = normalized?.envelopes[0]?.parts[0];
  return part?.kind === "text" ? part.text : "";
}

const EXCHANGE_TEMPLATE = {
  slug: "exchange_v1",
  displayName: "Exchange",
  version: 1,
  funnelStages: [],
  systemPromptFragment: "",
} as unknown as VerticalTemplate;

const embedder: RagTurnContext["embedder"] = {
  embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
  dim: 3,
} as never;

const emptyKb: RagTurnContext["kb"] = {
  search: async () => [],
  hybridSearch: async () => [],
  prioritySearch: async () => [],
} as never;

const quoteKb: RagTurnContext["kb"] = {
  search: async () => [
    {
      chunk_id: 1,
      distance: 0.1,
      text: "Курс и сумму называет только compute_exchange_quote.",
      document_id: 1,
      source: "kb",
      title: "Exchange policy",
    },
  ],
  hybridSearch: async () => [
    {
      chunk_id: 1,
      distance: 0.1,
      text: "Курс и сумму называет только compute_exchange_quote.",
      document_id: 1,
      source: "kb",
      title: "Exchange policy",
    },
  ],
  prioritySearch: async () => [],
} as never;

const fakeMessages: RagTurnContext["messages"] = {
  recent: async () => [],
  countByConversation: async () => 0,
  insert: async () => ({ id: 1 }),
} as never;

function quoteTool(): AnyRagTool {
  return {
    name: "compute_exchange_quote",
    description: "Compute exchange quote",
    parameters: z.object({ asset: z.string(), amount: z.number() }),
    execute: async () => ({ rate: 31.5, amountToThb: 10553 }),
  };
}

function chatWithQuoteToolTrace(finalReply: string): ChatClient {
  let calls = 0;
  return {
    completeWithTools: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "quote-1",
              name: "compute_exchange_quote",
              args: { asset: "USDT", amount: 335 },
            },
          ],
        };
      }
      return { content: finalReply, toolCalls: [] };
    },
    complete: async () => finalReply,
  } as unknown as ChatClient;
}

function chatWithoutTools(finalReply: string): ChatClient {
  return { complete: async () => finalReply } as unknown as ChatClient;
}

async function runRagPipelineSmoke(opts: {
  chat: ChatClient;
  tools?: AnyRagTool[];
  kb?: RagTurnContext["kb"];
  userMessageText?: string;
}) {
  const strategy = new RagReplyStrategy({
    loadTurnContext: () => ({
      template: EXCHANGE_TEMPLATE,
      chat: opts.chat,
      embedder,
      kb: opts.kb ?? emptyKb,
      tools: opts.tools ?? [],
      messages: fakeMessages,
    }),
    softFallback: false,
  });
  return strategy.generate({
    tenant: { tenantId: 1 },
    channel: { channelId: 10 },
    conversationId: 100,
    contactId: 5,
    inbound: { externalUserId: "u1" },
    userMessageText: opts.userMessageText ?? "сколько получу за 335 usdt?",
  });
}

describe("exchange golden eval smoke", () => {
  it("loads 10 anonymized workflow cases", () => {
    const cases = loadCases();
    expect(cases).toHaveLength(10);
    for (const item of cases) {
      expect(item.id).toBeString();
      expect(item.expectedWorkflow.length).toBeGreaterThan(0);
      expect(JSON.stringify(item)).not.toContain("https://qr.nspk.ru");
      expect(JSON.stringify(item)).not.toContain("2202 ");
      expect(JSON.stringify(item)).not.toContain("Код: 289");
    }
  });

  it("covers quote, requisites, KYC and proof checkpoints", () => {
    const tokens = new Set(loadCases().flatMap((item) => item.expectedWorkflow));
    expect(tokens.has("rate_quote")).toBe(true);
    expect(tokens.has("kyc_required")).toBe(true);
    expect(
      [
        "requisites_qr",
        "requisites_card",
        "requisites_crypto_wallet",
        "requisites_binance_id",
      ].some((token) => tokens.has(token)),
    ).toBe(true);
    expect(tokens.has("receipt_request")).toBe(true);
  });

  it("passes deterministic guard and stage-policy smoke checks", () => {
    const results = evaluateExchangeGoldenCases(loadCases());
    const failures = formatExchangeGoldenFailures(results);
    expect(failures).toBe("");
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("formats case id, expected behavior, actual result and trace for failures", () => {
    const failures = formatExchangeGoldenFailures([
      {
        caseId: "case-1",
        passed: false,
        trace: ["rate_quote: exchange_request -> compute_exchange_quote"],
        failures: [
          {
            caseId: "case-1",
            expected: "quote through tool",
            actual: "draft was allowed",
            trace: ["rate_quote: exchange_request -> compute_exchange_quote"],
          },
        ],
      },
    ]);
    expect(failures).toContain("case=case-1");
    expect(failures).toContain("expected=quote through tool");
    expect(failures).toContain("actual=draft was allowed");
    expect(failures).toContain("trace=rate_quote");
  });

  it("real RAG pipeline smoke: tool-backed quote is sent", async () => {
    const reply = "Курс 31.5, получите 10553 THB.";
    const result = await runRagPipelineSmoke({
      chat: chatWithQuoteToolTrace(reply),
      tools: [quoteTool()],
      userMessageText: loadCases()[0]?.messages[0]?.text,
    });
    expect(result).not.toBeNull();
    expect(firstReplyText(result)).toBe(reply);
  });

  it("real RAG pipeline smoke: unbacked quote is replaced with safe fallback", async () => {
    const result = await runRagPipelineSmoke({
      chat: chatWithoutTools("Курс 31.5, получите 10553 THB."),
      tools: [],
      kb: quoteKb,
      userMessageText: loadCases()[0]?.messages[0]?.text,
    });
    expect(result).not.toBeNull();
    expect(firstReplyText(result)).toBe(EXCHANGE_SAFE_FALLBACK);
  });
});
