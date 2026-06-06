import type { ChatClient } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { applyEditsToStyle, parseProposal, proposeStyleEdits } from "./coach.ts";
import type { ISelfPlayMatchesRepo } from "./store.ts";
import { STYLES } from "./styles/index.ts";

const baseStyle = STYLES[0]!; // marina-prime
const chat = (t: string): ChatClient => ({ complete: async () => t }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({ complete: async () => { throw new Error("boom"); } }) as unknown as ChatClient;

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
    const p = parseProposal('{"summary":"S","edits":{"voice_tone":"warm","skills_attach":["mirroring"]},"rationale":["r1"]}');
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
      hooks_add: [{ kind: "scarcity", text: "мест мало" }, { kind: "made_up", text: "x" }],
    });
    expect(out.hooks.some((h) => h.text === "мест мало")).toBe(true);
    expect(out.hooks.some((h) => h.text === "x")).toBe(false);
  });
  it("stage_guidance: новая стадия создаётся", () => {
    const out = applyEditsToStyle(baseStyle, { stage_guidance: { close: "дожимай мягко" } });
    expect(out.stages.close?.guidance).toBe("дожимай мягко");
  });
  it("fewshot_add: валидный добавляется (со стадией), пустой дропается", () => {
    const out = applyEditsToStyle(baseStyle, {
      fewshot_add: [{ user: "u", assistant: "a", stage: "opener" }, { user: "", assistant: "a" }],
    });
    expect(out.fewShot.find((f) => f.user === "u")?.stage).toBe("opener");
    expect(out.fewShot.some((f) => f.user === "")).toBe(false);
  });
});

describe("proposeStyleEdits", () => {
  it("нет проигрышей/ничьих → нечего коучить", async () => {
    const p = await proposeStyleEdits({ style: baseStyle, matchesRepo: fakeMatches([]), chat: chatThrows() });
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
  it("LLM упал → summary с ошибкой", async () => {
    const p = await proposeStyleEdits({ style: baseStyle, matchesRepo: fakeMatches([{ id: 1 }]), chat: chatThrows() });
    expect(p.summary).toContain("Coach LLM call failed");
  });
});
