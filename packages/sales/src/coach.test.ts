import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { applyEditsToStyle, parseProposal, proposeStyleEdits } from "./coach.ts";
import type { ISelfPlayMatchesRepo } from "./store.ts";
import { STYLES } from "./styles/index.ts";
import { StyleSchema } from "./types.ts";

const baseStyle = STYLES[0]; // marina-prime
if (!baseStyle) throw new Error("missing base style fixture");
const chat = (t: string): ChatClient => ({ complete: async () => t }) as unknown as ChatClient;
const chatCapture = (t: string, calls: ChatMessage[][]): ChatClient =>
  ({
    complete: async (messages: ChatMessage[]) => {
      calls.push(messages);
      return t;
    },
  }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("boom");
    },
  }) as unknown as ChatClient;

function fakeMatches(list: Array<{ id: number }>): ISelfPlayMatchesRepo {
  return {
    list: async () => list,
    byId: async (id: number) => ({
      id,
      outcome: "lost",
      persona_slug: "anxious",
      judge_reason: "lost early",
      skills: [],
      transcript: [
        { role: "candidate", text: "привет" },
        { role: "salesperson", text: "здравствуйте" },
      ],
    }),
  } as unknown as ISelfPlayMatchesRepo;
}

describe("parseProposal", () => {
  it("валидный JSON → нормализованный proposal", () => {
    const p = parseProposal(
      '{"summary":"S","edits":{"voice_tone":"warm","skills_attach":["mirroring"]},"rationale":["r1"]}',
    );
    expect(p.summary).toBe("S");
    expect(p.edits.voice_tone).toBe("warm");
    expect(p.edits.skills_attach).toEqual(["mirroring"]);
    expect(p.rationale).toEqual(["r1"]);
  });
  it("неразборчиво → fallback + raw", () => {
    const p = parseProposal("совсем не json");
    expect(p.summary).toContain("unparseable");
    expect(p.raw).toBe("совсем не json");
  });
  it("фильтрует мусорные типы в edits/rationale", () => {
    const p = parseProposal(
      '{"summary":"S","edits":{"voice_forbid_add":["ok",123],"hooks_add":[{"kind":"scarcity","text":"t"},{"bad":1}],"stage_guidance":{"close":"c","x":1}},"rationale":["r",5]}',
    );
    expect(p.edits.voice_forbid_add).toEqual(["ok"]);
    expect(p.edits.hooks_add).toEqual([{ kind: "scarcity", text: "t" }]);
    expect(p.edits.stage_guidance).toEqual({ close: "c" });
    expect(p.rationale).toEqual(["r"]);
  });
  it("нормализует fewshot_add и skills_detach (фильтр мусора)", () => {
    const p = parseProposal(
      '{"summary":"S","edits":{"fewshot_add":[{"user":"u","assistant":"a","stage":"close"},{"user":"u2","assistant":2}],"skills_detach":["mirroring",7]},"rationale":[]}',
    );
    expect(p.edits.fewshot_add).toEqual([{ user: "u", assistant: "a", stage: "close" }]);
    expect(p.edits.skills_detach).toEqual(["mirroring"]);
  });
});

describe("applyEditsToStyle", () => {
  it("voice_tone заменяется, forbid дедуп-добавляется, оригинал иммутабелен", () => {
    const before = baseStyle.voice.tone;
    const out = applyEditsToStyle(baseStyle, {
      voice_tone: "  новый тон  ",
      voice_forbid_add: ["уникальное-слово", baseStyle.voice.forbid[0] ?? "x"],
    });
    expect(out.voice.tone).toBe("новый тон");
    expect(out.voice.forbid).toContain("уникальное-слово");
    expect(out).not.toBe(baseStyle);
    expect(baseStyle.voice.tone).toBe(before); // не мутировали
  });
  it("hooks: валидный kind добавляется, невалидный отбрасывается", () => {
    const out = applyEditsToStyle(baseStyle, {
      hooks_add: [
        { kind: "scarcity", text: "мест мало" },
        { kind: "made_up", text: "x" },
      ],
    });
    expect(out.hooks.some((h) => h.text === "мест мало")).toBe(true);
    expect(out.hooks.some((h) => h.text === "x")).toBe(false);
  });
  it("stage_guidance: новая стадия создаётся", () => {
    const out = applyEditsToStyle(baseStyle, {
      stage_guidance: { close: "дожимай мягко" },
    });
    expect(out.stages.close?.guidance).toBe("дожимай мягко");
  });
  it("stage_guidance: отсутствующая стадия создаётся с минимальным конфигом", () => {
    const minimal = StyleSchema.parse({
      slug: "min-style",
      displayName: "Min",
      persona: { name: "Аня", role: "human", company: "Acme" },
      voice: { tone: "тёплый", language: "ru" },
      framework: "SPIN",
      stages: { qualify: { goal: "понять запрос" } },
      guardrails: {},
      model: {},
    });
    const out = applyEditsToStyle(minimal, {
      stage_guidance: { objection: "снимай возражения мягко" },
    });
    expect(out.stages.objection).toEqual({
      goal: "objection",
      guidance: "снимай возражения мягко",
      groundingRequired: false,
    });
    // существующая стадия обновляется, а не пересоздаётся
    const out2 = applyEditsToStyle(minimal, {
      stage_guidance: { qualify: "уточняй бюджет" },
    });
    expect(out2.stages.qualify?.goal).toBe("понять запрос");
    expect(out2.stages.qualify?.guidance).toBe("уточняй бюджет");
  });
  it("fewshot_add: валидный добавляется (со стадией), пустой дропается", () => {
    const out = applyEditsToStyle(baseStyle, {
      fewshot_add: [
        { user: "u", assistant: "a", stage: "opener" },
        { user: "", assistant: "a" },
      ],
    });
    expect(out.fewShot.find((f) => f.user === "u")?.stage).toBe("opener");
    expect(out.fewShot.some((f) => f.user === "")).toBe(false);
  });
});

describe("proposeStyleEdits", () => {
  it("нет проигрышей/ничьих → нечего коучить", async () => {
    const p = await proposeStyleEdits({
      style: baseStyle,
      matchesRepo: fakeMatches([]),
      chat: chatThrows(),
    });
    expect(p.summary).toContain("nothing to coach");
    expect(p.edits).toEqual({});
  });
  it("есть сэмпл → LLM-вызов + parseProposal", async () => {
    const p = await proposeStyleEdits({
      style: baseStyle,
      matchesRepo: fakeMatches([{ id: 1 }]),
      chat: chat('{"summary":"diag","edits":{"voice_tone":"x"},"rationale":[]}'),
    });
    expect(p.summary).toBe("diag");
  });
  it("использует tool-call feedback как coach signal даже без lost/draw матчей", async () => {
    const calls: ChatMessage[][] = [];
    const p = await proposeStyleEdits({
      style: baseStyle,
      matchesRepo: fakeMatches([]),
      chat: chatCapture(
        '{"summary":"tool diag","edits":{"stage_guidance":{"close":"verify quote before order"}},"rationale":["bad args feedback"]}',
        calls,
      ),
      toolFeedbackSignals: [
        {
          toolName: "create_exchange_order",
          source: "llm_reply",
          label: "bad_args",
          error: true,
          note: "quote id should be verified before order creation",
          args: { quoteId: "q1" },
          result: { error: "needs verification" },
        },
      ],
    });
    expect(p.summary).toBe("tool diag");
    const prompt = calls[0]?.map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain("SAMPLE OF 0 LOST/DRAW MATCHES");
    expect(prompt).toContain("TOOL-CALL FEEDBACK SIGNALS (1)");
    expect(prompt).toContain("create_exchange_order");
    expect(prompt).toContain("Label: bad_args");
    expect(prompt).toContain("quote id should be verified");
  });
  it("несериализуемые args в tool feedback → '<unserializable>' в промпте", async () => {
    const calls: ChatMessage[][] = [];
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const p = await proposeStyleEdits({
      style: baseStyle,
      matchesRepo: fakeMatches([]),
      chat: chatCapture('{"summary":"ok","edits":{},"rationale":[]}', calls),
      toolFeedbackSignals: [
        {
          toolName: "create_exchange_order",
          source: "llm_reply",
          label: "other",
          error: false,
          args: circular,
          result: { ok: true },
        },
      ],
    });
    expect(p.summary).toBe("ok");
    const prompt = calls[0]?.map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain('"<unserializable>"');
    expect(prompt).toContain('{"ok":true}');
  });
  it("LLM упал → summary с ошибкой", async () => {
    const p = await proposeStyleEdits({
      style: baseStyle,
      matchesRepo: fakeMatches([{ id: 1 }]),
      chat: chatThrows(),
    });
    expect(p.summary).toContain("Coach LLM call failed");
  });
});
