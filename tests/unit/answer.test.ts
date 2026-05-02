import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import { openDb } from "@/db/sqlite.ts";
import { answerWithRag, isPersonaSmalltalkQuestion, NO_CONTEXT_MARKER } from "@/rag/answer.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";

const DIM = 1536;

function vec(seed: number): number[] {
  const arr = new Array<number>(DIM).fill(0);
  arr[seed % DIM] = 1;
  return arr;
}

function fakeEmbedder(map: Record<string, number[]>): EmbeddingClient & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    dim: DIM,
    calls,
    async embed(inputs) {
      for (const i of inputs) calls.push(i);
      return inputs.map((t) => map[t] ?? vec(t.length));
    },
  } as EmbeddingClient & { calls: string[] };
}

function fakeChat(reply: string): ChatClient & {
  lastMessages: ChatMessage[] | null;
} {
  const wrapper = {
    lastMessages: null as ChatMessage[] | null,
    async complete(messages: ChatMessage[]) {
      wrapper.lastMessages = messages;
      return reply;
    },
  };
  return wrapper as ChatClient & { lastMessages: ChatMessage[] | null };
}

let db: ReturnType<typeof openDb>;
let kb: KbRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:", embeddingDim: DIM });
  kb = new KbRepo(db);
});
afterEach(() => db.close());

function seed(): { qVec: number[] } {
  const doc = kb.upsertDocument({
    source: "s://t",
    title: "t",
    contentHash: "h1",
  });
  kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: "Refunds are processed within 5 business days.",
    tokenCount: 10,
    embedding: vec(1),
  });
  kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 1,
    text: "Office hours: Mon-Fri 9-18 UTC.",
    tokenCount: 8,
    embedding: vec(2),
  });
  return { qVec: vec(1) };
}

describe("isPersonaSmalltalkQuestion", () => {
  test("matches common Russian name intents", () => {
    expect(isPersonaSmalltalkQuestion("тебя как зовут?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("Как тебя зовут")).toBe(true);
    expect(isPersonaSmalltalkQuestion("кто ты?")).toBe(true);
  });

  test("false when job/location mixed in", () => {
    expect(
      isPersonaSmalltalkQuestion("как тебя зовут есть работа в китае?"),
    ).toBe(false);
  });
});

describe("answerWithRag", () => {
  test("retrieves chunks, builds prompt with their text, returns LLM answer", async () => {
    const { qVec } = seed();
    const embedder = fakeEmbedder({ "How do refunds work?": qVec });
    const chat = fakeChat("Refunds take 5 business days.");

    const result = await answerWithRag({
      question: "How do refunds work?",
      kb,
      embedder,
      chat,
      topK: 2,
    });

    expect(result.text).toBe("Refunds take 5 business days.");
    expect(result.usedChunkIds.length).toBeGreaterThan(0);
    expect(embedder.calls).toEqual(["How do refunds work?"]);

    const sys = chat.lastMessages?.[0];
    expect(sys?.role).toBe("system");
    expect(sys?.content).toContain("Refunds are processed within 5");
    const user = chat.lastMessages?.[chat.lastMessages.length - 1];
    expect(user?.role).toBe("user");
    expect(user?.content).toBe("How do refunds work?");
  });

  test("persona-only name question: no embed/LLM, uses env persona", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("must not run");
    const result = await answerWithRag({
      question: "тебя как зовут?",
      kb,
      embedder,
      chat,
      persona: {
        name: "Алина",
        role: "human",
        company: "INFINITY AGENCY",
      },
    });
    expect(embedder.calls).toEqual([]);
    expect(chat.lastMessages).toBeNull();
    expect(result.text).toContain("Алина");
    expect(result.text).toContain("INFINITY");
    expect(result.usedChunkIds).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  test("persona-only with sales style: uses style persona name", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("must not run");
    const result = await answerWithRag({
      question: "тебя как зовут?",
      kb,
      embedder,
      chat,
      style: flirtyBelfort,
      stage: "opener",
    });
    expect(embedder.calls).toEqual([]);
    expect(chat.lastMessages).toBeNull();
    expect(result.text).toContain(flirtyBelfort.persona.name);
  });

  test("returns NO_CONTEXT_MARKER when retrieval is empty", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("should not be called");
    const result = await answerWithRag({
      question: "anything",
      kb,
      embedder,
      chat,
    });
    expect(result.text).toBe(NO_CONTEXT_MARKER);
    expect(result.usedChunkIds).toEqual([]);
    expect(chat.lastMessages).toBeNull();
  });

  test("when style is provided, the system prompt comes from composeSystemPrompt (sales engine)", async () => {
    seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "сколько в Дубае платят?",
      kb,
      embedder,
      chat,
      style: flirtyBelfort,
      stage: "pitch",
    });
    const sys = chat.lastMessages?.[0];
    expect(sys?.role).toBe("system");
    // Style-specific markers
    expect(sys?.content).toContain(flirtyBelfort.persona.name); // "Алина"
    expect(sys?.content).toContain("ТЕКУЩИЙ ЭТАП: PITCH");
    expect(sys?.content).toContain("ХУКИ"); // hooks block
    expect(sys?.content).toContain("ФРЕЙМВОРК"); // framework block
    // KB context still injected
    expect(sys?.content).toContain("KB CONTEXT");
    // Legacy marker NOT present (different prompt template)
    expect(sys?.content).not.toContain("СТРОГИЕ ПРАВИЛА:");
  });

  test("style takes precedence over persona when both are provided", async () => {
    seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "hi",
      kb,
      embedder,
      chat,
      // legacy persona
      persona: { name: "LegacyBot", role: "assistant" },
      // sales-engine style
      style: flirtyBelfort,
      stage: "opener",
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    // Style's persona name wins
    expect(sys).toContain(flirtyBelfort.persona.name);
    expect(sys).not.toContain("LegacyBot");
  });

  test("includeFewShot=false skips few-shot block (used on follow-up turns)", async () => {
    seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "next message",
      kb,
      embedder,
      chat,
      style: flirtyBelfort,
      stage: "qualify",
      includeFewShot: false,
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).not.toContain("ПРИМЕРЫ ДИАЛОГА");
  });

  test("legacy persona path still works when no style is provided (back-compat)", async () => {
    seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "hi",
      kb,
      embedder,
      chat,
      persona: { name: "LegacyBot", role: "assistant", company: "Acme" },
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).toContain("LegacyBot");
    expect(sys).toContain("СТРОГИЕ ПРАВИЛА:"); // legacy template marker
    // Sales-engine markers absent
    expect(sys).not.toContain("ФРЕЙМВОРК");
    expect(sys).not.toContain("ТЕКУЩИЙ ЭТАП");
  });

  test("includes prior conversation messages between system and current user", async () => {
    seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "current question",
      kb,
      embedder,
      chat,
      history: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });
    const messages = chat.lastMessages!;
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "earlier question" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "earlier answer",
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "current question",
    });
  });
});
