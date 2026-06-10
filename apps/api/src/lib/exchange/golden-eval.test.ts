import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	EXCHANGE_SAFE_FALLBACK,
	RagReplyStrategy,
	type RagReplyStrategyOpts,
} from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import type { ChatClient } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { z } from "zod";
import {
	EXCHANGE_ANSWER_QUALITY_CASES,
	EXCHANGE_BAD_DIALOG_REPLAY_CASES,
	evaluateExchangeAnswerQualityCases,
	evaluateExchangeBadDialogCases,
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

const EXCHANGE_TEMPLATE = {
	slug: "exchange_v1",
	displayName: "Exchange",
	version: 1,
	funnelStages: [],
	systemPromptFragment: "",
} as unknown as VerticalTemplate;

const embed: RagReplyStrategyOpts["resolveEmbed"] = () =>
	({ embed: async (xs: string[]) => xs.map(() => [1, 0, 0]), dim: 3 }) as never;

const emptyKb: RagReplyStrategyOpts["resolveKb"] = () =>
	({
		search: async () => [],
		hybridSearch: async () => [],
		prioritySearch: async () => [],
	}) as never;

const quoteKb: RagReplyStrategyOpts["resolveKb"] = () =>
	({
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
	}) as never;

function fakeMessagesRepo() {
	return () =>
		({
			recent: async () => [],
			countByConversation: async () => 0,
			insert: async () => ({ id: 1 }),
		}) as never;
}

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
	resolveKb?: RagReplyStrategyOpts["resolveKb"];
	userMessageText?: string;
}) {
	const strategy = new RagReplyStrategy(
		{
			template: EXCHANGE_TEMPLATE,
			resolveChat: () => opts.chat,
			resolveEmbed: embed,
			resolveKb: opts.resolveKb ?? emptyKb,
			resolveTools: () => opts.tools ?? [],
			softFallback: false,
		},
		fakeMessagesRepo(),
	);
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
		const tokens = new Set(
			loadCases().flatMap((item) => item.expectedWorkflow),
		);
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

	it("passes exchange answer-quality replay cases", () => {
		const results = evaluateExchangeAnswerQualityCases(
			EXCHANGE_ANSWER_QUALITY_CASES,
		);
		const failures = formatExchangeGoldenFailures(results);
		expect(failures).toBe("");
		expect(results.every((result) => result.passed)).toBe(true);
	});

	it("answer-quality replay covers every response contract", () => {
		const contracts = new Set(
			EXCHANGE_ANSWER_QUALITY_CASES.map((item) => item.expectedContract),
		);
		const expected = [
			"quote",
			"quote_confirmed",
			"kyc_requested",
			"kyc_submitted",
			"payment_requisites",
			"payment_review",
			"office_pickup",
			"payout",
			"operator_handoff",
			"cancelled",
			"general",
		] as const;
		for (const contractId of expected) {
			expect(contracts.has(contractId)).toBe(true);
		}
		expect(EXCHANGE_ANSWER_QUALITY_CASES.length).toBeGreaterThanOrEqual(
			expected.length,
		);
	});

	it("passes bad-dialog replay cases without external LLM", () => {
		const results = evaluateExchangeBadDialogCases(
			EXCHANGE_BAD_DIALOG_REPLAY_CASES,
		);
		const failures = formatExchangeGoldenFailures(results);
		expect(failures).toBe("");
		expect(results.every((result) => result.passed)).toBe(true);
	});

	it("bad-dialog replay covers the known exchange failure modes", () => {
		const ids = new Set(
			EXCHANGE_BAD_DIALOG_REPLAY_CASES.map((item) => item.id),
		);
		for (const id of [
			"bad-dialog-quote-accepted-no-repeat",
			"bad-dialog-kyc-media-submitted",
			"bad-dialog-why-kyc-needed",
			"bad-dialog-rub-payment-office-pickup",
			"bad-dialog-rate-objection",
			"bad-dialog-payment-proof-submitted",
			"bad-dialog-operator-required",
			"bad-dialog-cancel-refuse-kyc",
		]) {
			expect(ids.has(id)).toBe(true);
		}
	});

	it("bad-dialog failures include the violated guard reason", () => {
		const source = EXCHANGE_BAD_DIALOG_REPLAY_CASES.find(
			(item) => item.id === "bad-dialog-kyc-media-submitted",
		);
		expect(source).toBeTruthy();
		const results = evaluateExchangeBadDialogCases([
			{
				...source!,
				unsafeDrafts: [
					{
						label: "auto KYC verified",
						text: "KYC подтверждён, можете оплачивать.",
						expectedReason: "unbacked_quote",
					},
				],
			},
		]);
		const failures = formatExchangeGoldenFailures(results);
		expect(results[0]?.passed).toBe(false);
		expect(failures).toContain("blocked with kyc_auto_verified");
		expect(failures).toContain("expected=unsafe draft");
	});

	it("answer-quality replay exposes redacted debug trace lines", () => {
		const results = evaluateExchangeAnswerQualityCases([
			EXCHANGE_ANSWER_QUALITY_CASES.find(
				(item) => item.id === "payment-proof-review",
			)!,
		]);
		const trace = results[0]?.trace.join("\n") ?? "";
		expect(trace).toContain("debug_contract=payment_review");
		expect(trace).toContain("debug_state");
		expect(trace).toContain("debug_handoff");
		expect(trace).toContain("debug_guard ok=yes");
		expect(trace).not.toContain("2200 7000 1234 5678");
		expect(trace).not.toContain("https://");
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
		expect((result![0]!.parts[0] as { text: string }).text).toBe(reply);
	});

	it("real RAG pipeline smoke: unbacked quote is replaced with safe fallback", async () => {
		const result = await runRagPipelineSmoke({
			chat: chatWithoutTools("Курс 31.5, получите 10553 THB."),
			tools: [],
			resolveKb: quoteKb,
			userMessageText: loadCases()[0]?.messages[0]?.text,
		});
		expect(result).not.toBeNull();
		expect((result![0]!.parts[0] as { text: string }).text).toBe(
			EXCHANGE_SAFE_FALLBACK,
		);
	});
});
