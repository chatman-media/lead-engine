import { describe, expect, it } from "bun:test";
import type { ISelfPlayMatchesRepo, SelfPlayMatchRecord } from "../store.ts";
import type { SelfPlayMatchResult } from "./orchestrator.ts";
import type { PairwiseMatchResult } from "./pairwise.ts";
import {
  exportPairwiseMatchJsonl,
  exportSelfPlayMatchesFromRepoJsonl,
  exportSelfPlayMatchJsonl,
  formatQualityLabJsonl,
  toQualityLabSelfPlayRecord,
} from "./export.ts";

const EXPORTED_AT = "2026-06-08T00:00:00.000Z";

const selfPlayResult: SelfPlayMatchResult = {
  styleSlug: "style-a",
  personaSlug: "skeptic-anya",
  turns: 2,
  transcript: [
    { role: "candidate", text: "привет\nрасскажите условия" },
    { role: "salesperson", text: "Расскажу коротко и без воды." },
    { role: "candidate", text: "давай оформляем анкету" },
  ],
  skillsAttributed: ["mirroring", "labeling"],
  verdict: { outcome: "won", reason: "candidate committed" },
  outcome: "won",
  leadId: 42,
  fabricationsCaught: 1,
  matchId: 7,
  persisted: true,
  warnings: ["turn 1 skill grading: skipped"],
};

describe("quality-lab JSONL export", () => {
  it("exports runtime self-play result as one JSONL record", () => {
    const jsonl = exportSelfPlayMatchJsonl(selfPlayResult, {
      exportedAt: EXPORTED_AT,
      source: "unit-test",
    });
    const parsed = JSON.parse(jsonl);

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "self_play_match",
      exportedAt: EXPORTED_AT,
      source: "unit-test",
      match: {
        matchId: 7,
        styleSlug: "style-a",
        personaSlug: "skeptic-anya",
        outcome: "won",
        turns: 2,
        leadId: 42,
        persisted: true,
        skills: ["mirroring", "labeling"],
        judge: { outcome: "won", reason: "candidate committed" },
        fabricationsCaught: 1,
        warnings: ["turn 1 skill grading: skipped"],
      },
    });
    expect(parsed.match.transcript).toHaveLength(3);
    expect(parsed.match.transcript[0].text).toContain("\n");
  });

  it("can omit transcript for compact exports", () => {
    const parsed = JSON.parse(
      exportSelfPlayMatchJsonl(selfPlayResult, {
        exportedAt: EXPORTED_AT,
        includeTranscript: false,
      }),
    );

    expect(parsed.match.transcript).toBeUndefined();
    expect(parsed.match.turns).toBe(2);
  });

  it("exports pairwise result with nested match summaries", () => {
    const result: PairwiseMatchResult = {
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      matchA: selfPlayResult,
      matchB: {
        ...selfPlayResult,
        styleSlug: "style-b",
        outcome: "lost",
        verdict: { outcome: "lost", reason: "candidate pushed back" },
        matchId: 8,
      },
      verdict: { winner: "a", reason: "A closed cleaner" },
      eloAAfter: 1516,
      eloBAfter: 1484,
      pairwiseId: 3,
      persisted: true,
    };

    const parsed = JSON.parse(
      exportPairwiseMatchJsonl(result, {
        exportedAt: EXPORTED_AT,
        includeTranscript: false,
      }),
    );

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "pairwise_match",
      pairwiseId: 3,
      styleASlug: "style-a",
      styleBSlug: "style-b",
      winner: "a",
      reason: "A closed cleaner",
      persisted: true,
      elo: { aAfter: 1516, bAfter: 1484 },
      matchA: { matchId: 7, styleSlug: "style-a", outcome: "won" },
      matchB: { matchId: 8, styleSlug: "style-b", outcome: "lost" },
    });
    expect(parsed.matchA.transcript).toBeUndefined();
    expect(parsed.matchB.transcript).toBeUndefined();
  });

  it("exports recent repo matches and marks missing full transcripts", async () => {
    const fullMatch: SelfPlayMatchRecord = {
      id: 10,
      style_slug: "style-a",
      persona_slug: "skeptic-anya",
      outcome: "draw",
      skills: ["mirroring"],
      judge_reason: "no close",
      transcript: [
        { role: "candidate", text: "условия?" },
        { role: "salesperson", text: "обсудим" },
      ],
    };
    const requestedIds: number[] = [];
    const repo: Pick<ISelfPlayMatchesRepo, "byId" | "list"> = {
      list: async (opts) => {
        expect(opts).toEqual({
          styleSlug: "style-a",
          limit: 2,
          personaSlug: "skeptic-anya",
        });
        return [
          {
            id: 10,
            style_slug: "style-a",
            persona_slug: "skeptic-anya",
            outcome: "draw",
            skills: ["mirroring"],
            judge_reason: "no close",
          },
          {
            id: 11,
            style_slug: "style-a",
            persona_slug: "skeptic-anya",
            outcome: "won",
            skills: [],
            judge_reason: null,
          },
        ];
      },
      byId: async (id) => {
        requestedIds.push(id);
        return id === 10 ? fullMatch : null;
      },
    };

    const lines = (
      await exportSelfPlayMatchesFromRepoJsonl(repo, {
        styleSlug: "style-a",
        personaSlug: "skeptic-anya",
        limit: 2,
        exportedAt: EXPORTED_AT,
      })
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(requestedIds).toEqual([10, 11]);
    expect(lines[0].match.transcript).toHaveLength(2);
    expect(lines[0].match.turns).toBe(1);
    expect(lines[1].match.transcript).toBeUndefined();
    expect(lines[1].match.transcriptUnavailable).toBe(true);
  });

  it("formats empty record sets as an empty string", () => {
    expect(formatQualityLabJsonl([])).toBe("");
  });

  it("normalizes stored match summaries without transcript", () => {
    const record = toQualityLabSelfPlayRecord(
      {
        id: 99,
        style_slug: "style-a",
        persona_slug: "skeptic-anya",
        outcome: "lost",
        skills: ["urgency"],
        judge_reason: "ghosted",
      },
      { exportedAt: EXPORTED_AT },
    );

    expect(record.match).toEqual({
      matchId: 99,
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "lost",
      turns: null,
      skills: ["urgency"],
      judge: { outcome: "lost", reason: "ghosted" },
    });
  });
});
