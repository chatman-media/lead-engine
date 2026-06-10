// Unit-tests for conversation compaction.
// Validates: summary generation, empty input, LLM call signature.

import { describe, expect, it } from "bun:test";
import type {
	ChatClient,
	ChatCompletionOpts,
	ChatMessage,
} from "@chatman-media/llm-router";
import { compactConversation } from "./compact-conversation.ts";

function makeChatClient(reply: string): ChatClient {
	return {
		async complete(messages: ChatMessage[], _opts?: ChatCompletionOpts) {
			// Verify the transcript is present in the user message.
			const userMsg = messages.find((m: ChatMessage) => m.role === "user");
			expect(typeof userMsg?.content).toBe("string");
			return reply;
		},
	} as unknown as ChatClient;
}

describe("compactConversation", () => {
	it("returns null for empty messages", async () => {
		const chat = makeChatClient("anything");
		const result = await compactConversation([], chat);
		expect(result).toBeNull();
	});

	it("returns summary text from LLM", async () => {
		const chat = makeChatClient(
			"• Кандидат ищет работу менеджером\n• Город: Москва",
		);
		const messages: ChatMessage[] = [
			{ role: "user", content: "ищу работу" },
			{ role: "assistant", content: "расскажите подробнее" },
		];
		const result = await compactConversation(messages, chat);
		expect(result).toContain("Кандидат");
	});

	it("returns null when LLM returns empty string", async () => {
		const chat = makeChatClient("   ");
		const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
		const result = await compactConversation(messages, chat);
		expect(result).toBeNull();
	});

	it("includes both user and assistant messages in transcript", async () => {
		let capturedContent = "";
		const chat: ChatClient = {
			async complete(messages: ChatMessage[], _opts?: ChatCompletionOpts) {
				const userMsg = messages.find((m: ChatMessage) => m.role === "user");
				capturedContent = String(userMsg?.content ?? "");
				return "summary";
			},
		} as unknown as ChatClient;

		const messages: ChatMessage[] = [
			{ role: "user", content: "Привет" },
			{ role: "assistant", content: "Здравствуйте!" },
			{ role: "user", content: "Расскажите о вакансиях" },
		];
		await compactConversation(messages, chat);

		expect(capturedContent).toContain("Кандидат: Привет");
		expect(capturedContent).toContain("Бот: Здравствуйте!");
		expect(capturedContent).toContain("Кандидат: Расскажите о вакансиях");
	});

	it("uses temperature=0 and numPredict for deterministic output", async () => {
		let calledOpts: Record<string, unknown> = {};
		const chat: ChatClient = {
			async complete(_messages: ChatMessage[], opts?: ChatCompletionOpts) {
				calledOpts = (opts ?? {}) as Record<string, unknown>;
				return "summary";
			},
		} as unknown as ChatClient;

		await compactConversation([{ role: "user", content: "test" }], chat);
		expect(calledOpts.temperature).toBe(0);
		expect(typeof calledOpts.numPredict).toBe("number");
	});
});
