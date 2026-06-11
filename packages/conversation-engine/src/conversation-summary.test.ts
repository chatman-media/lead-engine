import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import {
	loadRollingConversationContext,
	parseConversationSummaryPayload,
} from "./conversation-summary.ts";
import type { MessageRow, MessagesRepo } from "./dal/messages.ts";

function row(
	id: number,
	text: string,
	role: MessageRow["role"] = "user",
): MessageRow {
	return {
		id,
		tenantId: 1,
		conversationId: 100,
		role,
		text,
		tgMessageId: null,
		metaJson: null,
		createdAt: 1700000000 + id,
		stage: null,
		deletedAt: null,
	};
}

function messagesRepo(
	rows: MessageRow[],
): Pick<
	MessagesRepo,
	"recent" | "countByConversation" | "forConversationSummary"
> {
	return {
		recent: async (_conversationId, limit) => rows.slice(-limit),
		countByConversation: async () => rows.length,
		forConversationSummary: async (_conversationId, opts) =>
			rows
				.filter(
					(item) =>
						item.id < opts.beforeMessageId &&
						(opts.afterMessageId == null || item.id > opts.afterMessageId) &&
						item.deletedAt == null &&
						item.role !== "system",
				)
				.slice(0, opts.limit),
	};
}

function chatReturning(
	reply: string,
	captured: ChatMessage[][] = [],
): ChatClient {
	return {
		complete: async (messages: ChatMessage[]) => {
			captured.push(messages);
			return reply;
		},
	} as unknown as ChatClient;
}

describe("conversation rolling summary", () => {
	it("parses structured, JSON-string, and plain legacy summary values", () => {
		expect(
			parseConversationSummaryPayload(
				'{"version":1,"summary":"old facts","throughMessageId":12,"updatedAt":100}',
			),
		).toMatchObject({ summary: "old facts", throughMessageId: 12 });
		expect(parseConversationSummaryPayload('"json string"')).toMatchObject({
			summary: "json string",
			throughMessageId: 0,
		});
		expect(parseConversationSummaryPayload("plain string")).toMatchObject({
			summary: "plain string",
			throughMessageId: 0,
		});
	});

	it("summarizes only messages older than the raw recent window", async () => {
		const captured: ChatMessage[][] = [];
		let savedJson = "";
		const ctx = await loadRollingConversationContext({
			conversationId: 100,
			messages: messagesRepo([
				row(1, "old 1"),
				row(2, "old 2", "assistant"),
				row(3, "old 3"),
				row(4, "raw 4"),
				row(5, "raw 5", "assistant"),
				row(6, "current question"),
			]),
			conversations: {
				findById: async () => ({ summaryJson: null }),
				setSummaryJson: async (_id, json) => {
					savedJson = json;
				},
			},
			chat: chatReturning("summary of old rows", captured),
			currentMessageId: 6,
			options: { recentWindow: 2, summarizeAfterMessages: 3 },
			nowEpoch: 123,
		});

		expect(ctx.history.map((item) => item.id)).toEqual([4, 5]);
		expect(ctx.conversationSummary).toBe("summary of old rows");
		const prompt = captured[0]?.find((m) => m.role === "user")?.content ?? "";
		expect(prompt).toContain("old 1");
		expect(prompt).toContain("old 2");
		expect(prompt).toContain("old 3");
		expect(prompt).not.toContain("raw 4");
		expect(JSON.parse(savedJson)).toMatchObject({
			version: 1,
			summary: "summary of old rows",
			throughMessageId: 3,
			updatedAt: 123,
		});
	});

	it("updates existing summary from messages after throughMessageId only", async () => {
		const captured: ChatMessage[][] = [];
		let savedJson = "";
		const ctx = await loadRollingConversationContext({
			conversationId: 100,
			messages: messagesRepo([
				row(1, "already summarized"),
				row(2, "already summarized"),
				row(3, "already summarized"),
				row(4, "new old fact"),
				row(5, "raw 5"),
				row(6, "raw 6"),
				row(7, "current"),
			]),
			conversations: {
				findById: async () => ({
					summaryJson: JSON.stringify({
						version: 1,
						summary: "previous summary",
						throughMessageId: 3,
						updatedAt: 100,
					}),
				}),
				setSummaryJson: async (_id, json) => {
					savedJson = json;
				},
			},
			chat: chatReturning("updated summary", captured),
			currentMessageId: 7,
			options: { recentWindow: 2, summarizeAfterMessages: 3 },
			nowEpoch: 200,
		});

		expect(ctx.history.map((item) => item.id)).toEqual([5, 6]);
		expect(ctx.conversationSummary).toBe("updated summary");
		const prompt = captured[0]?.find((m) => m.role === "user")?.content ?? "";
		expect(prompt).toContain("ПРЕДЫДУЩЕЕ SUMMARY");
		expect(prompt).toContain("previous summary");
		expect(prompt).toContain("new old fact");
		expect(prompt).not.toContain("already summarized");
		expect(JSON.parse(savedJson)).toMatchObject({
			summary: "updated summary",
			throughMessageId: 4,
			updatedAt: 200,
		});
	});

	it("returns legacy summary when there are no new old messages", async () => {
		const ctx = await loadRollingConversationContext({
			conversationId: 100,
			messages: messagesRepo([row(1, "raw 1"), row(2, "current")]),
			conversations: {
				findById: async () => ({ summaryJson: '"legacy summary"' }),
				setSummaryJson: async () => {
					throw new Error("should not save");
				},
			},
			chat: chatReturning("should not be called"),
			currentMessageId: 2,
			options: { recentWindow: 1, summarizeAfterMessages: 2 },
		});

		expect(ctx.history.map((item) => item.id)).toEqual([1]);
		expect(ctx.conversationSummary).toBe("legacy summary");
	});
});
