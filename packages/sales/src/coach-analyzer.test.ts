import type { MessageRow } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { CoachAnalyzer, extractUserAssistantPairs } from "./coach-analyzer.ts";

function msg(opts: Partial<MessageRow> & { id: number; role: MessageRow["role"]; text: string }): MessageRow {
  return {
    id: opts.id,
    tenantId: 1,
    conversationId: 100,
    role: opts.role,
    text: opts.text,
    tgMessageId: null,
    metaJson: null,
    createdAt: 0,
    stage: null,
    deletedAt: null,
  };
}

describe("extractUserAssistantPairs", () => {
  it("Собирает alternating user→assistant пары", () => {
    const out = extractUserAssistantPairs([
      msg({ id: 1, role: "user", text: "привет" }),
      msg({ id: 2, role: "assistant", text: "здравствуй" }),
      msg({ id: 3, role: "user", text: "сколько" }),
      msg({ id: 4, role: "assistant", text: "уточню" }),
    ]);
    expect(out).toEqual([
      { userText: "привет", assistantText: "здравствуй", assistantMessageId: 2 },
      { userText: "сколько", assistantText: "уточню", assistantMessageId: 4 },
    ]);
  });

  it("human-роль считается assistant'ом (operator reply)", () => {
    const out = extractUserAssistantPairs([
      msg({ id: 1, role: "user", text: "?" }),
      msg({ id: 2, role: "human", text: "manual reply" }),
    ]);
    expect(out).toEqual([{ userText: "?", assistantText: "manual reply", assistantMessageId: 2 }]);
  });

  it("два user подряд (бот не ответил) — пропускает первый", () => {
    const out = extractUserAssistantPairs([
      msg({ id: 1, role: "user", text: "first" }),
      msg({ id: 2, role: "user", text: "second" }),
      msg({ id: 3, role: "assistant", text: "reply" }),
    ]);
    expect(out).toEqual([{ userText: "second", assistantText: "reply", assistantMessageId: 3 }]);
  });

  it("system-роль игнорируется", () => {
    const out = extractUserAssistantPairs([
      msg({ id: 1, role: "system", text: "init" }),
      msg({ id: 2, role: "user", text: "hi" }),
      msg({ id: 3, role: "assistant", text: "hi back" }),
    ]);
    expect(out).toEqual([{ userText: "hi", assistantText: "hi back", assistantMessageId: 3 }]);
  });

  it("пустой text → skip pair", () => {
    const out = extractUserAssistantPairs([
      msg({ id: 1, role: "user", text: "" }),
      msg({ id: 2, role: "assistant", text: "reply" }),
    ]);
    expect(out).toEqual([]);
  });
});

class FakeChat implements ChatClient {
  public calls = 0;
  public lastMessages: ChatMessage[] | undefined;
  constructor(private readonly outputs: string[]) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    const out = this.outputs[this.calls] ?? "[]";
    this.calls += 1;
    return out;
  }
}

class FakeSkillOutcomes {
  public recorded: Array<{ leadId: number; skillSlug: string; outcome: string; messageId: number | null }> = [];
  private seen = new Set<string>();
  async record(opts: {
    leadId: number;
    skillSlug: string;
    outcome: "won" | "lost" | "draw";
    source: string;
    conversationId?: number | null;
    messageId?: number | null;
    nowEpoch: number;
  }): Promise<boolean> {
    const key = `${opts.leadId}:${opts.skillSlug}:${opts.source}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.recorded.push({
      leadId: opts.leadId,
      skillSlug: opts.skillSlug,
      outcome: opts.outcome,
      messageId: opts.messageId ?? null,
    });
    return true;
  }
}

class FakeMessages {
  constructor(private readonly rows: readonly MessageRow[]) {}
  async recent(_conversationId: number, _limit: number): Promise<MessageRow[]> {
    return [...this.rows];
  }
}

describe("CoachAnalyzer", () => {
  const lead = {
    id: 42,
    tenantId: 1,
    userId: 1,
    state: "ready_to_work",
    intakeJson: null,
    visaDocsJson: null,
    applicationId: null,
    opsChatId: null,
    opsMessageId: null,
    rejectedReason: null,
    decidedByAdminId: null,
    decidedAt: null,
    lastCheckinAt: null,
    visaInterviewField: null,
    createdAt: 0,
    updatedAt: 0,
  };

  it("анализирует пары и пишет skill_outcomes", async () => {
    const chat = new FakeChat(['["social-proof-stat","tactical-empathy"]', '["mirroring"]']);
    const analyzer = new CoachAnalyzer({
      availableSlugs: ["social-proof-stat", "tactical-empathy", "mirroring"],
      resolveChat: () => chat,
    });
    const messages = new FakeMessages([
      msg({ id: 1, role: "user", text: "сколько платят" }),
      msg({ id: 2, role: "assistant", text: "70% наших закрывают за месяц" }),
      msg({ id: 3, role: "user", text: "не уверена" }),
      msg({ id: 4, role: "assistant", text: "не уверена?" }),
    ]);
    const outcomes = new FakeSkillOutcomes();
    const result = await analyzer.analyzeLead(
      { messages: messages as never, skillOutcomes: outcomes as never },
      {
        lead,
        conversationId: 100,
        styleSlug: "empathetic-nepq-v1",
        outcome: "won",
        source: "lead_submitted",
        nowEpoch: 1700000000,
      },
    );
    expect(result.pairsAnalyzed).toBe(2);
    expect(result.outcomesRecorded).toBe(3);
    expect(result.outcomesDuplicate).toBe(0);
    expect(chat.calls).toBe(2);
    expect(outcomes.recorded.map((r) => r.skillSlug).sort()).toEqual([
      "mirroring",
      "social-proof-stat",
      "tactical-empathy",
    ]);
  });

  it("idempotency: повторный analyze того же lead → 0 newly recorded", async () => {
    const chat = new FakeChat(['["mirroring"]', '["mirroring"]']);
    const analyzer = new CoachAnalyzer({
      availableSlugs: ["mirroring"],
      resolveChat: () => chat,
    });
    const messages = new FakeMessages([
      msg({ id: 1, role: "user", text: "x" }),
      msg({ id: 2, role: "assistant", text: "x?" }),
    ]);
    const outcomes = new FakeSkillOutcomes();
    await analyzer.analyzeLead(
      { messages: messages as never, skillOutcomes: outcomes as never },
      {
        lead,
        conversationId: 100,
        styleSlug: null,
        outcome: "won",
        source: "lead_submitted",
        nowEpoch: 0,
      },
    );
    const r2 = await analyzer.analyzeLead(
      { messages: messages as never, skillOutcomes: outcomes as never },
      {
        lead,
        conversationId: 100,
        styleSlug: null,
        outcome: "won",
        source: "lead_submitted",
        nowEpoch: 0,
      },
    );
    expect(r2.outcomesRecorded).toBe(0);
    expect(r2.outcomesDuplicate).toBe(1);
  });

  it("LLM возвращает пустой массив → 0 outcomes", async () => {
    const chat = new FakeChat(["[]"]);
    const analyzer = new CoachAnalyzer({
      availableSlugs: ["mirroring"],
      resolveChat: () => chat,
    });
    const messages = new FakeMessages([
      msg({ id: 1, role: "user", text: "factual?" }),
      msg({ id: 2, role: "assistant", text: "yes." }),
    ]);
    const outcomes = new FakeSkillOutcomes();
    const result = await analyzer.analyzeLead(
      { messages: messages as never, skillOutcomes: outcomes as never },
      {
        lead,
        conversationId: 100,
        styleSlug: null,
        outcome: "won",
        source: "lead_submitted",
        nowEpoch: 0,
      },
    );
    expect(result.pairsAnalyzed).toBe(1);
    expect(result.outcomesRecorded).toBe(0);
  });

  it("нет user→assistant пар → 0 LLM calls", async () => {
    const chat = new FakeChat([]);
    const analyzer = new CoachAnalyzer({
      availableSlugs: ["mirroring"],
      resolveChat: () => chat,
    });
    const messages = new FakeMessages([
      msg({ id: 1, role: "user", text: "alone" }),
    ]);
    const outcomes = new FakeSkillOutcomes();
    const result = await analyzer.analyzeLead(
      { messages: messages as never, skillOutcomes: outcomes as never },
      {
        lead,
        conversationId: 100,
        styleSlug: null,
        outcome: "lost",
        source: "lead_rejected",
        nowEpoch: 0,
      },
    );
    expect(result.pairsAnalyzed).toBe(0);
    expect(chat.calls).toBe(0);
  });
});
