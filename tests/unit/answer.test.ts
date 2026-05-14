import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import {
  answerWithRag,
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  NO_CONTEXT_MARKER,
  personaFactReply,
} from "@/rag/answer.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

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

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let kb: KbRepo;

beforeEach(() => {
  kb = new KbRepo(sql);
});

async function seed(): Promise<{ qVec: number[] }> {
  const doc = await kb.upsertDocument({
    source: "s://t",
    title: "t",
    contentHash: "h1",
  });
  await kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: "Refunds are processed within 5 business days.",
    tokenCount: 10,
    embedding: vec(1),
  });
  await kb.insertChunkWithEmbedding({
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

  // Regression: bare "как зовут?" without pronoun used to leak into RAG and
  // produce an off-topic escalation reply ("секунду, уточню...") instead of
  // the persona's name. Ditto "имя?", "ваше имя?", "представься".
  test("matches bare forms without pronoun (the regression we fixed)", () => {
    expect(isPersonaSmalltalkQuestion("как зовут?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("Как зовут")).toBe(true);
    expect(isPersonaSmalltalkQuestion("имя?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("Имя?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("ваше имя?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("твоё имя")).toBe(true);
    expect(isPersonaSmalltalkQuestion("как ваше имя?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("вас как зовут?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("как звать?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("как тебя называть?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("представься")).toBe(true);
    expect(isPersonaSmalltalkQuestion("Представься пожалуйста")).toBe(true);
    expect(isPersonaSmalltalkQuestion("представьтесь")).toBe(true);
    expect(isPersonaSmalltalkQuestion("кто вы?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("с кем я общаюсь?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("с кем разговариваю?")).toBe(true);
  });

  test("matches English forms", () => {
    expect(isPersonaSmalltalkQuestion("what's your name?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("Who are you?")).toBe(true);
  });

  test("false when job/location mixed in (work intent wins)", () => {
    expect(isPersonaSmalltalkQuestion("как тебя зовут есть работа в китае?")).toBe(false);
    expect(isPersonaSmalltalkQuestion("как зовут? есть вакансии?")).toBe(false);
    expect(isPersonaSmalltalkQuestion("представься, какой график?")).toBe(false);
  });

  test("false on completely unrelated questions (no false positives)", () => {
    expect(isPersonaSmalltalkQuestion("сколько платят в Дубае?")).toBe(false);
    expect(isPersonaSmalltalkQuestion("привет")).toBe(false);
    expect(isPersonaSmalltalkQuestion("здравствуйте")).toBe(false);
    expect(isPersonaSmalltalkQuestion("")).toBe(false);
    expect(isPersonaSmalltalkQuestion("   ")).toBe(false);
    // "Имя" inside a sentence ABOUT something else — still a smalltalk
    // word, but the work-intent gate isn't triggered. We accept this edge:
    // the cost of a false-positive on a vague mention is one wasted reply,
    // not a stall, so it's harmless.
  });
});

describe("isPersonalFactQuestion", () => {
  test("detects city questions", () => {
    expect(isPersonalFactQuestion("где живешь?")).toBe("city");
    expect(isPersonalFactQuestion("где ты живешь?")).toBe("city");
    expect(isPersonalFactQuestion("где живёшь")).toBe("city");
    expect(isPersonalFactQuestion("откуда ты?")).toBe("city");
    expect(isPersonalFactQuestion("из какого города?")).toBe("city");
    expect(isPersonalFactQuestion("в каком городе?")).toBe("city");
    expect(isPersonalFactQuestion("где ты сейчас?")).toBe("city");
    expect(isPersonalFactQuestion("где находишься?")).toBe("city");
  });

  test("detects age questions", () => {
    expect(isPersonalFactQuestion("сколько тебе лет?")).toBe("age");
    expect(isPersonalFactQuestion("сколько лет?")).toBe("age");
    expect(isPersonalFactQuestion("тебе сколько лет?")).toBe("age");
    expect(isPersonalFactQuestion("какой возраст?")).toBe("age");
    expect(isPersonalFactQuestion("твой возраст?")).toBe("age");
    expect(isPersonalFactQuestion("возраст?")).toBe("age");
  });

  test("detects relationship status questions", () => {
    expect(isPersonalFactQuestion("ты замужем?")).toBe("status");
    expect(isPersonalFactQuestion("замужем?")).toBe("status");
    expect(isPersonalFactQuestion("есть парень?")).toBe("status");
    expect(isPersonalFactQuestion("есть муж?")).toBe("status");
    expect(isPersonalFactQuestion("в отношениях?")).toBe("status");
    expect(isPersonalFactQuestion("ты одна?")).toBe("status");
  });

  test("detects phone / contact requests", () => {
    expect(isPersonalFactQuestion("какой твой номер?")).toBe("phone");
    expect(isPersonalFactQuestion("дай номер")).toBe("phone");
    expect(isPersonalFactQuestion("номер?")).toBe("phone");
    expect(isPersonalFactQuestion("телефон?")).toBe("phone");
    expect(isPersonalFactQuestion("есть whatsapp?")).toBe("phone");
    expect(isPersonalFactQuestion("скинь номер телефона")).toBe("phone");
  });

  test("returns null when job/offer intent is mixed in", () => {
    expect(isPersonalFactQuestion("где живешь, есть работа в китае?")).toBeNull();
    expect(isPersonalFactQuestion("сколько лет и какая зарплата?")).toBeNull();
    expect(isPersonalFactQuestion("ты замужем и какой график?")).toBeNull();
  });

  test("returns null on unrelated questions", () => {
    expect(isPersonalFactQuestion("привет")).toBeNull();
    expect(isPersonalFactQuestion("как дела?")).toBeNull();
    expect(isPersonalFactQuestion("")).toBeNull();
    expect(isPersonalFactQuestion("   ")).toBeNull();
  });
});

describe("personaFactReply", () => {
  const persona = {
    name: "Алина",
    role: "human" as const,
    facts: { city: "Шаохинге", age: "26", status: "Не замужем." },
  };

  test("city fact wraps in natural sentence", () => {
    const reply = personaFactReply(persona, "city");
    expect(reply).toContain("Шаохинге");
    expect(reply).toBeTruthy();
  });

  test("age fact appends лет when value is digits only", () => {
    const reply = personaFactReply(persona, "age");
    expect(reply).toContain("26");
    expect(reply).toContain("лет");
  });

  test("status returned verbatim", () => {
    expect(personaFactReply(persona, "status")).toBe("Не замужем.");
  });

  test("phone fact wraps in a natural sentence", () => {
    const p = {
      name: "Алина",
      role: "human" as const,
      facts: { phone: "+1 365 860 2690" },
    };
    const reply = personaFactReply(p, "phone");
    expect(reply).toContain("+1 365 860 2690");
    expect(reply).toContain("Мой номер");
  });

  test("returns null when fact key not configured", () => {
    expect(personaFactReply({ name: "Алина", role: "human" }, "city")).toBeNull();
    expect(personaFactReply({ name: "Алина", role: "human", facts: {} }, "city")).toBeNull();
  });
});

describe("answerWithRag", () => {
  test("retrieves chunks, builds prompt with their text, returns LLM answer", async () => {
    const { qVec } = await seed();
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

  test("personal fact question with facts configured: no embed/LLM call", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("must not run");
    const result = await answerWithRag({
      question: "где живешь?",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human", facts: { city: "Шаохинге" } },
    });
    expect(embedder.calls).toEqual([]);
    expect(chat.lastMessages).toBeNull();
    expect(result.text).toContain("Шаохинге");
    expect(result.usedChunkIds).toEqual([]);
  });

  test("personal fact question without facts configured: falls through to RAG", async () => {
    await seed();
    const embedder = fakeEmbedder({ "где живешь?": vec(1) });
    const chat = fakeChat("RAG answer");
    const result = await answerWithRag({
      question: "где живешь?",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human" }, // no facts
    });
    // Embedder was called (RAG ran)
    expect(embedder.calls).toContain("где живешь?");
    expect(result.text).toBe("RAG answer");
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
    // Em-dashes are post-processed away even on the shortcut path:
    // env-configured persona / company values can smuggle unicode in.
    expect(result.text).not.toContain("—");
    expect(result.text).not.toContain("–");
  });

  test("smalltalk reply varies across calls (no fixed scripted tail)", async () => {
    // 30 calls — with a 6-element tail pool the chance all match the same
    // reply is ~6 * (1/6)^30 ≈ 1.6e-23. Even with 4-element pool it's safe.
    const persona = {
      name: "Алина",
      role: "human" as const,
      company: "INFINITY AGENCY",
    };
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const embedder = fakeEmbedder({});
      const chat = fakeChat("never");
      const result = await answerWithRag({
        question: "как тебя зовут?",
        kb,
        embedder,
        chat,
        persona,
      });
      seen.add(result.text);
    }
    expect(seen.size).toBeGreaterThan(1);
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
    await seed();
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
    await seed();
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
    await seed();
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
    await seed();
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

  test("conversationSummary is injected into legacy persona prompt", async () => {
    await seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "что было раньше",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human" },
      conversationSummary: "ранее кандидат уточнял про Дубай и контракт",
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(sys).toContain("Дубай");
  });

  test("conversationSummary is injected into sales-style prompt", async () => {
    await seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "вопрос",
      kb,
      embedder,
      chat,
      style: flirtyBelfort,
      stage: "qualify",
      conversationSummary: "до этого обсуждали релокацию в Стамбул",
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(sys).toContain("Стамбул");
  });

  test("empty conversationSummary does NOT inject the heading", async () => {
    await seed();
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ok");
    await answerWithRag({
      question: "вопрос",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human" },
      conversationSummary: "   ",
    });
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).not.toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
  });

  test("topicRouting=true filters retrieval to classified topic, falls back when no match", async () => {
    const visaDoc = await kb.upsertDocument({
      source: "kb://v",
      title: "v",
      contentHash: "v",
      topic: "visa",
    });
    const paymentDoc = await kb.upsertDocument({
      source: "kb://p",
      title: "p",
      contentHash: "p",
      topic: "payment",
    });
    const visaChunk = await kb.insertChunkWithEmbedding({
      documentId: visaDoc.id,
      chunkIndex: 0,
      text: "Виза 30 дней",
      tokenCount: 3,
      embedding: vec(1),
    });
    await kb.insertChunkWithEmbedding({
      documentId: paymentDoc.id,
      chunkIndex: 0,
      text: "1500 в день",
      tokenCount: 3,
      embedding: vec(2),
    });

    const embedder = fakeEmbedder({ "какая виза нужна?": vec(2) });
    const chat = fakeChat("ok");

    const result = await answerWithRag({
      question: "какая виза нужна?",
      kb,
      embedder,
      chat,
      topK: 5,
      topicRouting: true,
    });
    // Even though embedding seed favors payment chunk, topic filter
    // restricts to visa-tagged docs → only visa chunk is returned.
    expect(result.usedChunkIds).toContain(visaChunk.id);
    expect(result.usedChunkIds).not.toContain(paymentDoc.id);
    expect(result.telemetry.topic).toBe("visa");
  });

  test("topicRouting falls back to global when classifier returns null", async () => {
    await seed();
    const embedder = fakeEmbedder({ привет: vec(1) });
    const chat = fakeChat("Reply text");
    const result = await answerWithRag({
      question: "привет", // doesn't match any topic
      kb,
      embedder,
      chat,
      topicRouting: true,
    });
    expect(result.text).toBe("Reply text");
    expect(result.telemetry.topic).toBeUndefined();
  });

  test("hybridSearch=true uses BM25+vector fusion for retrieval", async () => {
    const doc = await kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
    // Two chunks with disjoint topics. The query keyword "Стамбул" appears only
    // in chunk #2 — pure vector search (vec(1) vs vec(2) distance ≈ √2) would
    // return chunk #1 first, but BM25 lifts chunk #2 via the keyword match.
    // RRF fusion should include chunk #2 in the results.
    await kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Refunds in 5 business days",
      tokenCount: 10,
      embedding: vec(1),
    });
    const istanbul = await kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 1,
      // Use "Стамбул" (not "Стамбуле") so that the FTS prefix query generated
      // from "Стамбул контракт" → `"Стамбул"*` matches this exact token.
      text: "Стамбул контракт 60 дней оплата в долларах",
      tokenCount: 10,
      embedding: vec(2),
    });

    // Query uses "Стамбул" (base form) so sanitizeFtsQuery produces "Стамбул"*
    // which prefix-matches the chunk text above.
    const embedder = fakeEmbedder({ "Стамбул контракт": vec(1) });
    const chat = fakeChat("ok");

    const result = await answerWithRag({
      question: "Стамбул контракт",
      kb,
      embedder,
      chat,
      topK: 2,
      hybridSearch: true,
    });

    expect(result.usedChunkIds).toContain(istanbul.id);
  });

  test("telemetry: smalltalk path skips retrieval/generation, marks path", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("nope");
    const result = await answerWithRag({
      question: "тебя как зовут?",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human", company: "X" },
    });
    expect(result.telemetry.path).toBe("smalltalk");
    expect(result.telemetry.total_ms).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.retrieval_ms).toBeUndefined();
    expect(result.telemetry.generation_ms).toBeUndefined();
  });

  test("telemetry: persona_fact path", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("nope");
    const result = await answerWithRag({
      question: "где живешь?",
      kb,
      embedder,
      chat,
      persona: { name: "Алина", role: "human", facts: { city: "Шаохинге" } },
    });
    expect(result.telemetry.path).toBe("persona_fact");
  });

  test("telemetry: no_context path when retrieval is empty", async () => {
    const embedder = fakeEmbedder({});
    const chat = fakeChat("ignored");
    const result = await answerWithRag({
      question: "anything",
      kb,
      embedder,
      chat,
    });
    expect(result.telemetry.path).toBe("no_context");
    expect(result.telemetry.retrieval_ms).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.top_distances).toEqual([]);
  });

  test("telemetry: ok path with top_distances + generation_ms", async () => {
    const { qVec } = await seed();
    const embedder = fakeEmbedder({ "How do refunds work?": qVec });
    const chat = fakeChat("Refunds take 5 business days.");

    const result = await answerWithRag({
      question: "How do refunds work?",
      kb,
      embedder,
      chat,
      topK: 2,
    });

    expect(result.telemetry.path).toBe("ok");
    expect(result.telemetry.top_distances).toBeDefined();
    expect(result.telemetry.top_distances!.length).toBeGreaterThan(0);
    expect(result.telemetry.generation_ms).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.retrieval_ms).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.total_ms).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.hybrid).toBeUndefined();
    expect(result.telemetry.original_query).toBeUndefined();
  });

  test("telemetry: hybrid=true marker when hybrid retrieval is used", async () => {
    const { qVec } = await seed();
    const embedder = fakeEmbedder({ test: qVec });
    const chat = fakeChat("ok");
    const result = await answerWithRag({
      question: "test",
      kb,
      embedder,
      chat,
      hybridSearch: true,
      topK: 2,
    });
    expect(result.telemetry.hybrid).toBe(true);
  });

  test("includes prior conversation messages between system and current user", async () => {
    await seed();
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

describe("isBotPresenceQuestion", () => {
  test("matches direct bot/human/AI questions in Russian", () => {
    expect(isBotPresenceQuestion("ты бот?")).toBe(true);
    expect(isBotPresenceQuestion("ты человек?")).toBe(true);
    expect(isBotPresenceQuestion("ты ИИ?")).toBe(true);
    expect(isBotPresenceQuestion("ты робот?")).toBe(true);
    expect(isBotPresenceQuestion("ты нейросеть?")).toBe(true);
    expect(isBotPresenceQuestion("ты chatgpt?")).toBe(true);
    expect(isBotPresenceQuestion("человек?")).toBe(true);
    expect(isBotPresenceQuestion("бот?")).toBe(true);
  });

  test("matches English forms", () => {
    expect(isBotPresenceQuestion("are you a bot?")).toBe(true);
    expect(isBotPresenceQuestion("are you human")).toBe(true);
    expect(isBotPresenceQuestion("are you AI?")).toBe(true);
  });

  test("returns false on identity smalltalk (handled separately)", () => {
    expect(isBotPresenceQuestion("как тебя зовут?")).toBe(false);
    expect(isBotPresenceQuestion("кто ты?")).toBe(false);
  });

  test("returns false when question carries job intent", () => {
    expect(isBotPresenceQuestion("ты бот, есть работа в Китае?")).toBe(false);
    expect(isBotPresenceQuestion("ты человек или бот, какая зарплата?")).toBe(false);
  });

  test("returns false on empty/unrelated", () => {
    expect(isBotPresenceQuestion("")).toBe(false);
    expect(isBotPresenceQuestion("привет!")).toBe(false);
    expect(isBotPresenceQuestion("сколько лет?")).toBe(false);
  });
});

describe("botPresenceReply", () => {
  test("role=human positively asserts human regardless of question form", () => {
    const reply = botPresenceReply({
      name: "Алина",
      role: "human",
      company: "INFINITY AGENCY",
    });
    // Same reply for "ты бот?" and "ты человек?" — both arrive at the same
    // shortcut, both must produce a human-affirming answer.
    expect(reply.toLowerCase()).toContain("живой человек");
    expect(reply).toContain("Алина");
    expect(reply).toContain("INFINITY AGENCY");
  });

  test("role=assistant openly admits being AI", () => {
    const reply = botPresenceReply({ name: "Алина", role: "assistant" });
    expect(reply.toLowerCase()).toContain("ии-ассистент");
    expect(reply).toContain("Алина");
  });

  test("falls back to default name when persona name is empty", () => {
    const reply = botPresenceReply({ name: "", role: "human" });
    expect(reply).toContain("Менеджер");
  });
});

describe("answerWithRag bot-presence shortcut", () => {
  test("bypasses retrieval and LLM for 'ты бот?' / 'ты человек?'", async () => {
    const kb = new KbRepo(sql);
    const embedder = fakeEmbedder({});
    const chat: ChatClient & { calls: number } = {
      calls: 0,
      async complete() {
        this.calls++;
        return "should not be called";
      },
    };
    const res = await answerWithRag({
      question: "ты человек?",
      kb,
      embedder,
      chat,
      persona: {
        name: "Алина",
        role: "human",
        company: "INFINITY AGENCY",
      },
    });
    expect(chat.calls).toBe(0);
    expect(embedder.calls.length).toBe(0);
    expect(res.text.toLowerCase()).toContain("живой человек");
    expect(res.telemetry.path).toBe("smalltalk");
  });
});
