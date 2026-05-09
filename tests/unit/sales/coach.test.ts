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

import { parseProposal } from "@/sales/coach.ts";

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
