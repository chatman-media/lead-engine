/**
 * Coach-LLM proposal parser tests.
 *
 * proposeStyleEdits itself spawns an LLM call — covered by integration runs.
 * What we test here is the JSON normalization logic, since the model output
 * is the most fragile contract: dropped fields, wrong types, extra prose
 * around the JSON, etc. The parser must NEVER throw and must always return
 * a valid CoachProposal shape.
 */
import { describe, expect, test } from "bun:test";

import { applyEditsToStyle, parseProposal } from "@/sales/coach.ts";
import type { Style } from "@/sales/types.ts";

const BASE_STYLE: Style = {
  slug: "test-style-v1",
  displayName: "Test",
  persona: { name: "Алина", role: "human", company: "INFINITY" },
  voice: { tone: "warm and direct", language: "ru", forbid: ["официально"] },
  framework: "AIDA",
  hooks: [{ kind: "social_proof", text: "наши девочки..." }],
  stages: {
    opener: { goal: "engage", guidance: "lead with curiosity", groundingRequired: false },
  },
  fewShot: [],
  guardrails: { noMinors: true, botDisclosureOnDirectQuestion: true, forbiddenTopics: [] },
  model: { id: "qwen3:latest", temperature: 0.8, maxTokens: 256 },
};

describe("parseProposal", () => {
  test("parses fully-populated proposal", () => {
    const raw = JSON.stringify({
      summary: "Style is too generic in opener.",
      edits: {
        voice_tone: "warmer, more conversational",
        voice_forbid_add: ["официально сообщаю", "согласно регламенту"],
        hooks_add: [{ kind: "social_proof", text: "Наши девочки в Шанхае получают..." }],
        stage_guidance: { opener: "Use a sincere observation." },
        fewshot_add: [{ user: "сколько платят?", assistant: "От $3k.", stage: "qualify" }],
        skills_attach: ["liking-genuine-compliment", "tactical-empathy"],
        skills_detach: ["scarcity-spots-left"],
      },
      rationale: [
        "Match #5 lost because opener felt scripted.",
        "Match #7 missed an empathy beat.",
      ],
    });
    const p = parseProposal(raw);
    expect(p.summary).toContain("opener");
    expect(p.edits.voice_tone).toBe("warmer, more conversational");
    expect(p.edits.voice_forbid_add).toEqual(["официально сообщаю", "согласно регламенту"]);
    expect(p.edits.hooks_add).toHaveLength(1);
    expect(p.edits.stage_guidance?.opener).toBeDefined();
    expect(p.edits.fewshot_add).toHaveLength(1);
    expect(p.edits.skills_attach).toContain("liking-genuine-compliment");
    expect(p.edits.skills_detach).toContain("scarcity-spots-left");
    expect(p.rationale).toHaveLength(2);
  });

  test("strips code fences", () => {
    const raw = '```json\n{"summary":"x","edits":{},"rationale":[]}\n```';
    expect(parseProposal(raw).summary).toBe("x");
  });

  test("extracts JSON when wrapped in commentary", () => {
    const raw =
      'Here is my analysis:\n{"summary":"y","edits":{"voice_tone":"x"},"rationale":[]}\nThanks!';
    const p = parseProposal(raw);
    expect(p.summary).toBe("y");
    expect(p.edits.voice_tone).toBe("x");
  });

  test("filters non-string skill slugs", () => {
    const raw = JSON.stringify({
      summary: "z",
      edits: { skills_attach: ["valid-slug", 123, null, "another"] },
      rationale: [],
    });
    expect(parseProposal(raw).edits.skills_attach).toEqual(["valid-slug", "another"]);
  });

  test("drops malformed hook entries", () => {
    const raw = JSON.stringify({
      summary: "z",
      edits: {
        hooks_add: [
          { kind: "social_proof", text: "ok" },
          { kind: "bad" }, // missing text
          "just a string",
          { text: "no kind" },
        ],
      },
      rationale: [],
    });
    expect(parseProposal(raw).edits.hooks_add).toHaveLength(1);
  });

  test("returns empty proposal on totally unparseable output", () => {
    const p = parseProposal("the salesperson should be more persuasive");
    expect(p.summary).toContain("unparseable");
    expect(p.edits).toEqual({});
    expect(p.raw).toContain("persuasive");
  });

  test("never throws on malformed shapes", () => {
    expect(() => parseProposal("null")).not.toThrow();
    expect(() => parseProposal("[]")).not.toThrow();
    expect(() => parseProposal('"just a string"')).not.toThrow();
    expect(() => parseProposal("")).not.toThrow();
  });

  test("partial edits object — only the populated fields appear", () => {
    const raw = '{"summary":"s","edits":{"voice_tone":"warm"},"rationale":["r1"]}';
    const p = parseProposal(raw);
    expect(p.edits.voice_tone).toBe("warm");
    expect(p.edits.skills_attach).toBeUndefined();
    expect(p.edits.hooks_add).toBeUndefined();
  });
});

describe("applyEditsToStyle", () => {
  test("does not mutate the original", () => {
    const original = JSON.parse(JSON.stringify(BASE_STYLE));
    applyEditsToStyle(BASE_STYLE, { voice_tone: "icy" });
    expect(BASE_STYLE).toEqual(original);
  });

  test("voice_tone replaces", () => {
    const out = applyEditsToStyle(BASE_STYLE, { voice_tone: "playful, less corporate" });
    expect(out.voice.tone).toBe("playful, less corporate");
  });

  test("voice_forbid_add appends and dedupes", () => {
    const out = applyEditsToStyle(BASE_STYLE, {
      voice_forbid_add: ["согласно регламенту", "официально", "красавица"],
    });
    expect(out.voice.forbid).toContain("согласно регламенту");
    expect(out.voice.forbid).toContain("красавица");
    expect(out.voice.forbid.filter((s) => s === "официально")).toHaveLength(1); // not duplicated
  });

  test("hooks_add filters invalid kinds", () => {
    const out = applyEditsToStyle(BASE_STYLE, {
      hooks_add: [
        { kind: "scarcity", text: "3 места" },
        { kind: "made_up_kind", text: "x" },
        { kind: "authority", text: "контракт ДО вылета" },
      ],
    });
    expect(out.hooks).toHaveLength(3); // 1 base + 2 valid added
    expect(out.hooks.find((h) => h.kind === "scarcity")?.text).toBe("3 места");
    expect(out.hooks.find((h) => h.kind === "authority")).toBeDefined();
  });

  test("stage_guidance replaces existing + creates missing", () => {
    const out = applyEditsToStyle(BASE_STYLE, {
      stage_guidance: { opener: "lead with sincere observation", close: "ask for anketa directly" },
    });
    expect(out.stages.opener?.guidance).toBe("lead with sincere observation");
    expect(out.stages.close).toBeDefined();
    expect(out.stages.close?.guidance).toBe("ask for anketa directly");
  });

  test("fewshot_add appends with valid stages", () => {
    const out = applyEditsToStyle(BASE_STYLE, {
      fewshot_add: [
        { user: "сколько платят", assistant: "от $3k", stage: "qualify" },
        { user: "x", assistant: "y", stage: "made-up-stage" },
        { user: "только пользовательский", assistant: "ответ" },
      ],
    });
    expect(out.fewShot).toHaveLength(3);
    expect(out.fewShot[0]?.stage).toBe("qualify");
    expect(out.fewShot[1]?.stage).toBeUndefined(); // invalid stage stripped
    expect(out.fewShot[2]?.stage).toBeUndefined();
  });

  test("empty edits object → identical (deep-equal) style", () => {
    const out = applyEditsToStyle(BASE_STYLE, {});
    expect(out).toEqual(BASE_STYLE);
  });

  test("ignores empty/whitespace edit values", () => {
    const out = applyEditsToStyle(BASE_STYLE, {
      voice_tone: "   ",
      voice_forbid_add: ["", "  "],
      hooks_add: [{ kind: "scarcity", text: "  " }],
      fewshot_add: [{ user: "", assistant: "" }],
    });
    expect(out.voice.tone).toBe(BASE_STYLE.voice.tone);
    expect(out.voice.forbid).toEqual(BASE_STYLE.voice.forbid);
    expect(out.hooks).toEqual(BASE_STYLE.hooks);
    expect(out.fewShot).toEqual([]);
  });
});
