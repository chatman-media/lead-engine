// Unit tests for the RAG answer pipeline (answer.ts): retrieveHits,
// answerWithRag (+ its answerFromHits branches), answerWithRagStream and
// generateSoftFallback. The KB store, embedder and chat client are faked so
// every branch (shortcuts, no-context, structured output, tool loop, fact
// check drops, retrieval failure, streaming) runs without network or DB.

import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import { z } from "zod";
import {
  answerWithRag,
  answerWithRagStream,
  generateSoftFallback,
  NO_CONTEXT_MARKER,
  retrieveHits,
} from "./answer.ts";
import type { AnswerInput } from "./answer-types.ts";
import type { KbSearchHit } from "./types.ts";

const hit = (id: number, over: Partial<KbSearchHit> = {}): KbSearchHit => ({
  chunk_id: id,
  distance: 0.1,
  text: `chunk ${id}`,
  document_id: 1,
  source: "src",
  title: `title ${id}`,
  ...over,
});

const embedder: EmbeddingClient = {
  embed: async (inputs: string[]) => inputs.map(() => [1, 0, 0]),
  dim: 3,
};

function fakeKb(
  over: Partial<Record<keyof FakeKbCalls, unknown>> = {},
  hits: KbSearchHit[] = [hit(1)],
) {
  const calls: FakeKbCalls = { search: 0, hybrid: 0, priority: 0 };
  const store = {
    search: async (_e: number[], _k: number, topic?: string | null) => {
      calls.search++;
      calls.lastTopic = topic ?? null;
      return (over.search as KbSearchHit[] | undefined) ?? hits;
    },
    hybridSearch: async () => {
      calls.hybrid++;
      return (over.hybrid as KbSearchHit[] | undefined) ?? hits;
    },
    prioritySearch: async () => {
      calls.priority++;
      return (over.priority as KbSearchHit[] | undefined) ?? hits;
    },
  } as unknown as AnswerInput["kb"];
  return { store, calls };
}
interface FakeKbCalls {
  search: number;
  hybrid: number;
  priority: number;
  lastTopic?: string | null;
}

/** Chat client whose complete() returns a fixed string and records messages. */
function fakeChat(
  reply: string | ((m: ChatMessage[]) => string),
  extra: Partial<ChatClient> = {},
): ChatClient & { lastMessages?: ChatMessage[] } {
  const c: ChatClient & { lastMessages?: ChatMessage[] } = {
    complete: async (messages: ChatMessage[]) => {
      c.lastMessages = messages;
      return typeof reply === "function" ? reply(messages) : reply;
    },
    ...extra,
  };
  return c;
}

const baseInput = (over: Partial<AnswerInput> = {}): AnswerInput => {
  const { store } = fakeKb();
  return {
    question: "Расскажи про вакансию в Китае и условия", // job intent → not a shortcut
    kb: store,
    embedder,
    chat: fakeChat("ответ модели"),
    ...over,
  };
};

describe("retrieveHits", () => {
  it("single-query vector search, без topic", async () => {
    const { store, calls } = fakeKb();
    const r = await retrieveHits(baseInput({ kb: store }));
    expect(r.hits).toHaveLength(1);
    expect(calls.search).toBe(1);
    expect(r.searchQuery).toContain("вакансию");
  });

  it("hybridSearch path", async () => {
    const { store, calls } = fakeKb();
    await retrieveHits(baseInput({ kb: store, hybridSearch: true }));
    expect(calls.hybrid).toBe(1);
    expect(calls.search).toBe(0);
  });

  it("booksPriority path", async () => {
    const { store, calls } = fakeKb();
    const r = await retrieveHits(baseInput({ kb: store, booksPriority: true }));
    expect(calls.priority).toBe(1);
    expect(r.usedTopic).toBeNull();
  });

  it("topicRouting: пустой результат по topic → fallback на global (usedTopic=null)", async () => {
    let first = true;
    const store = {
      search: async () => {
        if (first) {
          first = false;
          return [];
        }
        return [hit(2)];
      },
      hybridSearch: async () => [],
      prioritySearch: async () => [],
    } as unknown as AnswerInput["kb"];
    const r = await retrieveHits(
      baseInput({ kb: store, topicRouting: true, question: "виза china" }),
    );
    // fell back to global → got the hit, usedTopic reset to null
    expect(r.usedTopic).toBeNull();
  });

  it("maxDistance фильтрует далёкие хиты (non-hybrid)", async () => {
    const { store } = fakeKb({}, [hit(1, { distance: 0.1 }), hit(2, { distance: 0.9 })]);
    const r = await retrieveHits(baseInput({ kb: store, maxDistance: 0.5 }));
    expect(r.hits.map((h) => h.chunk_id)).toEqual([1]);
  });

  it("multiQuery → expandQueries + RRF merge", async () => {
    const { store, calls } = fakeKb({}, [hit(1), hit(2)]);
    // expandQueries uses chat to generate variants; a chat returning lines works,
    // but multiQuery merges per-query result lists regardless of expansion output.
    const r = await retrieveHits(
      baseInput({ kb: store, multiQuery: true, chat: fakeChat("вариант1\nвариант2") }),
    );
    expect(r.queries.length).toBeGreaterThanOrEqual(1);
    expect(calls.search).toBeGreaterThanOrEqual(1);
  });

  it("embedder без вектора → throw", async () => {
    const empty: EmbeddingClient = { embed: async () => [], dim: 3 };
    await expect(retrieveHits(baseInput({ embedder: empty }))).rejects.toThrow(/no vector/);
  });
});

describe("answerWithRag — persona shortcuts", () => {
  it("smalltalk «кто ты?» → path=smalltalk, без LLM", async () => {
    const chat = fakeChat(() => {
      throw new Error("should not call LLM");
    });
    const r = await answerWithRag(baseInput({ question: "кто ты?", chat }));
    expect(r.telemetry.path).toBe("smalltalk");
    expect(r.hits).toHaveLength(0);
  });

  it("bot-presence «ты бот?» → path=smalltalk", async () => {
    const r = await answerWithRag(baseInput({ question: "ты бот?" }));
    expect(r.telemetry.path).toBe("smalltalk");
  });

  it("personal-fact «где ты живёшь?» с persona.facts → path=persona_fact", async () => {
    const r = await answerWithRag(
      baseInput({
        question: "где ты живёшь?",
        persona: { name: "Аня", role: "human", facts: { city: "Москва" } },
      }),
    );
    expect(r.telemetry.path).toBe("persona_fact");
    expect(r.text).toContain("Москва");
  });
});

describe("answerWithRag — main paths", () => {
  it("happy path: hits + LLM → path=ok, usedChunkIds", async () => {
    const onTel: unknown[] = [];
    const r = await answerWithRag(baseInput({ onTelemetry: (t) => onTel.push(t) }));
    expect(r.telemetry.path).toBe("ok");
    expect(r.text.toLowerCase()).toBe("ответ модели");
    expect(r.usedChunkIds).toEqual([1]);
    expect(onTel).toHaveLength(1);
  });

  it("нет hits, нет style/vac/tools → NO_CONTEXT_MARKER", async () => {
    const { store } = fakeKb({ search: [] });
    const r = await answerWithRag(baseInput({ kb: store }));
    expect(r.text).toBe(NO_CONTEXT_MARKER);
    expect(r.telemetry.path).toBe("no_context");
  });

  it("retrieval падает → отвечаем без базы (graceful)", async () => {
    const store = {
      search: async () => {
        throw new Error("vector down");
      },
      hybridSearch: async () => [],
      prioritySearch: async () => [],
    } as unknown as AnswerInput["kb"];
    // no style → with zero hits answerFromHits returns no_context (no throw)
    const r = await answerWithRag(baseInput({ kb: store }));
    expect(r.text).toBe(NO_CONTEXT_MARKER);
  });

  it("structured output через completeStructured", async () => {
    const schema = z.object({ ok: z.boolean() });
    const chat = fakeChat("unused", {
      completeStructured: async () => '{"ok":true}',
    });
    const r = await answerWithRag({ ...baseInput({ chat }), outputSchema: schema });
    expect(r.output).toEqual({ ok: true });
    expect(r.telemetry.path).toBe("ok");
  });

  it("structured output fallback (нет completeStructured) → inject + complete temp0", async () => {
    const schema = z.object({ n: z.number() });
    const chat = fakeChat('{"n":7}');
    const r = await answerWithRag({ ...baseInput({ chat }), outputSchema: schema });
    expect(r.output).toEqual({ n: 7 });
  });

  it("fact-check (reflect): ungrounded → дроп в NO_CONTEXT_MARKER, path=ungrounded", async () => {
    const chat = fakeChat((m) => {
      // checkFacts uses the last system prompt asking for JSON verdict
      const sys = m[0]?.content ?? "";
      return sys.includes("grounded")
        ? '{"grounded":false,"vacancyOk":true,"reason":"выдумал"}'
        : "сырой ответ";
    });
    const r = await answerWithRag(baseInput({ chat, reflect: true, stage: "pitch" }));
    expect(r.telemetry.path).toBe("ungrounded");
    expect(r.text).toBe(NO_CONTEXT_MARKER);
  });

  it("vacancyGuard: mismatched vacancy → дроп", async () => {
    const chat = fakeChat((m) => {
      const sys = m[0]?.content ?? "";
      return sys.includes("grounded")
        ? '{"grounded":true,"vacancyOk":false,"reason":"цифры"}'
        : "ответ с вакансией";
    });
    const r = await answerWithRag(
      baseInput({ chat, vacanciesBlock: "Вакансия 2000$", stage: "pitch" }),
    );
    expect(r.telemetry.path).toBe("ungrounded");
  });

  it("grounding-exempt стадия (qualify) без vacancy → fact-check скипается", async () => {
    let factCheckCalled = false;
    const chat = fakeChat((m) => {
      if ((m[0]?.content ?? "").includes("grounded")) {
        factCheckCalled = true;
        return '{"grounded":false,"vacancyOk":true}';
      }
      return "вопрос кандидату";
    });
    const r = await answerWithRag(baseInput({ chat, reflect: true, stage: "qualify" }));
    expect(factCheckCalled).toBe(false);
    expect(r.telemetry.path).toBe("ok");
  });

  it("tool-loop: модель отвечает без вызова tools → early-return ok", async () => {
    const chat = fakeChat("unused", {
      completeWithTools: async () => ({ content: "финальный ответ", toolCalls: [] }),
    }) as ChatClient;
    const tool = {
      name: "quote",
      description: "d",
      parameters: z.object({}),
      execute: async () => "x",
    };
    const r = await answerWithRag(
      baseInput({ chat, tools: [tool] as unknown as AnswerInput["tools"] }),
    );
    expect(r.text.toLowerCase()).toBe("финальный ответ");
    expect(r.telemetry.path).toBe("ok");
  });
});

describe("answerWithRagStream", () => {
  async function collect(it: AsyncIterable<string>): Promise<string> {
    let out = "";
    for await (const t of it) out += t;
    return out;
  }

  it("smalltalk shortcut → yield + telemetry", async () => {
    const tel: { path?: string }[] = [];
    const out = await collect(
      answerWithRagStream(baseInput({ question: "кто ты?", onTelemetry: (t) => tel.push(t) })),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(tel[0]?.path).toBe("smalltalk");
  });

  it("no-context → yield NO_CONTEXT_MARKER", async () => {
    const { store } = fakeKb({ search: [] });
    const out = await collect(answerWithRagStream(baseInput({ kb: store })));
    expect(out).toBe(NO_CONTEXT_MARKER);
  });

  it("stream() доступен → токены отдаются по одному", async () => {
    const chat = fakeChat("unused", {
      // eslint-disable-next-line require-yield
      stream: async function* () {
        yield "при";
        yield "вет";
      },
    }) as ChatClient;
    const out = await collect(answerWithRagStream(baseInput({ chat })));
    expect(out).toBe("привет");
  });

  it("нет stream() → fallback на complete()", async () => {
    const out = await collect(answerWithRagStream(baseInput({ chat: fakeChat("полный ответ") })));
    // complete() fallback runs sanitizeLlmOutput (capitalises the first letter)
    expect(out.toLowerCase()).toBe("полный ответ");
  });
});

describe("generateSoftFallback", () => {
  it("строит persona-промпт и санитизирует ответ", async () => {
    const chat = fakeChat("Уточню и вернусь!");
    const r = await generateSoftFallback({
      question: "сколько платят?",
      chat,
      persona: { name: "Аня", role: "human", company: "Acme" },
    });
    expect(r).toBe("Уточню и вернусь!");
    const sys = chat.lastMessages?.[0]?.content ?? "";
    expect(sys).toContain("Аня");
    expect(sys).toContain("Acme");
  });
});
