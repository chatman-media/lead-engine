import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import {
	judgeExchangeSelfPlay,
	parseExchangeSelfPlayVerdict,
} from "./self-play-judge.ts";
import {
	EXCHANGE_SELF_PLAY_PERSONAS,
	getExchangeSelfPlayPersona,
} from "./self-play-personas.ts";

function chatReturning(raw: string): ChatClient & { messages?: ChatMessage[] } {
	const chat: ChatClient & { messages?: ChatMessage[] } = {
		complete: async (messages) => {
			chat.messages = messages;
			return raw;
		},
	};
	return chat;
}

function chatThrowing(): ChatClient {
	return {
		complete: async () => {
			throw new Error("judge down");
		},
	} as unknown as ChatClient;
}

describe("exchange self-play personas", () => {
	it("defines core exchange stress personas", () => {
		const slugs = EXCHANGE_SELF_PLAY_PERSONAS.map((persona) => persona.slug);
		expect(slugs).toContain("rate_negotiator");
		expect(slugs).toContain("urgent_late_night");
		expect(slugs).toContain("first_time_qr_sbp");
		expect(slugs).toContain("ambiguous_receipt");
		expect(slugs).toContain("third_party_card");
		expect(slugs).toContain("requisites_before_confirming");
		expect(slugs).toContain("payout_code_impatient");
	});

	it("finds persona by slug", () => {
		const persona = getExchangeSelfPlayPersona("payout_code_impatient");
		expect(persona?.opener).toContain("код");
		expect(getExchangeSelfPlayPersona("missing")).toBeNull();
	});
});

describe("exchange self-play judge", () => {
	it("parses JSON verdicts with domain outcomes", () => {
		expect(
			parseExchangeSelfPlayVerdict(
				'```json\n{"outcome":"policy_violation","reason":"invented payout code"}\n```',
			),
		).toEqual({ outcome: "policy_violation", reason: "invented payout code" });
	});

	it("falls back to dead_end on unparseable output", () => {
		const verdict = parseExchangeSelfPlayVerdict("not json");
		expect(verdict.outcome).toBe("dead_end");
		expect(verdict.raw).toBe("not json");
	});

	it("calls judge LLM with strict exchange rubric", async () => {
		const chat = chatReturning('{"outcome":"operator_needed","reason":"risk review needed"}');
		const verdict = await judgeExchangeSelfPlay({
			personaSlug: "third_party_card",
			judgeHint: "third-party payments require operator approval",
			transcript: [
				{ role: "client", text: "Перевод будет с карты друга" },
				{ role: "assistant", text: "Нужно согласование оператора, сам не подтверждаю." },
			],
			chat,
		});
		expect(verdict.outcome).toBe("operator_needed");
		const systemPrompt = chat.messages?.[0]?.content ?? "";
		expect(systemPrompt).toContain("policy_violation");
		expect(systemPrompt).toContain("payout code");
		expect(systemPrompt).toContain("third-party payments require operator approval");
	});

	it("returns dead_end when judge model fails", async () => {
		const verdict = await judgeExchangeSelfPlay({
			personaSlug: "rate_negotiator",
			judgeHint: "refuse manual negotiation",
			transcript: [{ role: "client", text: "Дайте курс лучше" }],
			chat: chatThrowing(),
		});
		expect(verdict.outcome).toBe("dead_end");
		expect(verdict.reason).toContain("judge down");
	});
});
