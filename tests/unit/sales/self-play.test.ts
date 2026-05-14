import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "@/db/repos/skill-outcomes.ts";
import { SkillsRepo, seedSkillCatalogue } from "@/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { parseVerdict } from "@/sales/self-play/judge.ts";
import { runSelfPlayMatch } from "@/sales/self-play/orchestrator.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "@/sales/self-play/personas.ts";
import { alinaInfinity } from "@/sales/styles/alina-infinity.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const DIM = 1536;

function vec(seed: number): number[] {
  const arr = new Array<number>(DIM).fill(0);
  arr[seed % DIM] = 1;
  return arr;
}

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs: string[]) {
      return inputs.map((t) => vec(t.length));
    },
  };
}

/** Scripted chat client — returns the next reply from the queue, or
 *  cycles the last reply if the queue is empty. Lets us script entire
 *  self-play matches deterministically. */
function scriptedChat(
  replies: string[],
): ChatClient & { calls: ChatMessage[][]; reset: () => void } {
  const queue = [...replies];
  const calls: ChatMessage[][] = [];
  return {
    calls,
    reset() {
      calls.length = 0;
    },
    async complete(messages: ChatMessage[]) {
      calls.push(messages);
      return queue.shift() ?? replies[replies.length - 1] ?? "(empty)";
    },
  };
}

describe("candidateConcluded regression — bare 'ок' prefix shouldn't close", () => {
  // The conclusion detector used to include `^ок` as a standalone alternative,
  // which made any candidate reply starting with "ок" (e.g. "ок, а сколько
  // платят?") prematurely end the match — every real run capped at 2-3 turns
  // and judges had nothing to call but draw.
  test("'ок, а сколько платят?' → not concluded (it's a follow-up question)", async () => {
    const { _testCandidateConcluded } = await import("@/sales/self-play/orchestrator.ts");
    expect(_testCandidateConcluded("ок, а сколько платят?")).toBe(false);
  });

  test("'ок, и где жить?' → not concluded", async () => {
    const { _testCandidateConcluded } = await import("@/sales/self-play/orchestrator.ts");
    expect(_testCandidateConcluded("ок, и где жить?")).toBe(false);
  });

  test("'ок, давай анкету' → concluded (explicit action verb)", async () => {
    const { _testCandidateConcluded } = await import("@/sales/self-play/orchestrator.ts");
    expect(_testCandidateConcluded("ок, давай анкету")).toBe(true);
  });

  test("'я согласна, давай оформляться' → concluded", async () => {
    const { _testCandidateConcluded } = await import("@/sales/self-play/orchestrator.ts");
    expect(_testCandidateConcluded("я согласна, давай оформляться")).toBe(true);
  });

  test("'это развод' → concluded (refusal)", async () => {
    const { _testCandidateConcluded } = await import("@/sales/self-play/orchestrator.ts");
    expect(_testCandidateConcluded("это развод")).toBe(true);
  });
});

describe("personas catalogue", () => {
  test("at least 5 personas with unique slugs + non-empty fields", () => {
    expect(CANDIDATE_PERSONAS.length).toBeGreaterThanOrEqual(5);
    const slugs = new Set(CANDIDATE_PERSONAS.map((p) => p.slug));
    expect(slugs.size).toBe(CANDIDATE_PERSONAS.length);
    for (const p of CANDIDATE_PERSONAS) {
      expect(p.systemPrompt.length).toBeGreaterThan(50);
      expect(p.opener.length).toBeGreaterThan(0);
      expect(p.judgingHint.length).toBeGreaterThan(0);
    }
    expect(CANDIDATE_BY_SLUG.size).toBe(CANDIDATE_PERSONAS.length);
  });
});

describe("parseVerdict", () => {
  test("parses bare JSON verdict", () => {
    expect(parseVerdict('{"outcome":"won","reason":"clear yes"}')).toEqual({
      outcome: "won",
      reason: "clear yes",
    });
  });

  test("strips ```json fences", () => {
    expect(parseVerdict('```json\n{"outcome":"draw","reason":"ambiguous"}\n```')).toEqual({
      outcome: "draw",
      reason: "ambiguous",
    });
  });

  test("falls back to regex when surrounded by chatter", () => {
    const v = parseVerdict(
      'Sure, here is my verdict: {"outcome": "lost", "reason": "candidate refused"} hope this helps',
    );
    expect(v.outcome).toBe("lost");
    expect(v.reason).toBe("candidate refused");
  });

  test("returns draw + raw when unparseable", () => {
    const v = parseVerdict("garbage non-json output");
    expect(v.outcome).toBe("draw");
    expect(v.raw).toBe("garbage non-json output");
  });

  test("rejects bogus outcome value (falls through to draw)", () => {
    const v = parseVerdict('{"outcome":"obliterated","reason":"x"}');
    expect(v.outcome).toBe("draw");
  });
});

describe("runSelfPlayMatch (integration with scripted LLMs)", () => {
  const sql = getTestSql();
  beforeAll(() => setupTestDb(sql));
  afterEach(() => cleanTestDb(sql));
  afterAll(() => sql.end());

  let kb: KbRepo;
  let skills: SkillsRepo;
  let outcomes: SkillOutcomesRepo;
  let ratings: StyleRatingsRepo;
  let styles: StylesRepo;

  beforeEach(async () => {
    kb = new KbRepo(sql);
    skills = new SkillsRepo(sql);
    outcomes = new SkillOutcomesRepo(sql);
    ratings = new StyleRatingsRepo(sql);
    styles = new StylesRepo(sql);
    await seedSkillCatalogue(skills);
    await seedBuiltinStyles(styles, [alinaInfinity]);
    // Attach a couple of skills so attribution has slugs to record.
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    await skills.setSkillsForStyle(styleRow.id, ["social-proof-stat", "tactical-empathy"]);
  });

  test("won match records outcomes + bumps style ELO", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    // Sales replies once; candidate concludes immediately with a strong commit;
    // judge returns "won".
    const salesChat = scriptedChat(["хочешь анкету заполним?"]);
    const candidateChat = scriptedChat(["ок, давай оформляться"]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"explicit yes"}']);

    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("eager-kate")!,
        maxTurns: 5,
      },
    );

    expect(result.outcome).toBe("won");
    expect(result.transcript[0]!.role).toBe("candidate"); // opener from persona
    expect(result.skillsAttributed.sort()).toEqual(["social-proof-stat", "tactical-empathy"]);

    const aggs = await outcomes.aggregate();
    expect(aggs.length).toBe(2);
    for (const a of aggs) expect(a.wins).toBe(1);

    const rating = (await ratings.bySlug(alinaInfinity.slug))!;
    expect(rating.wins).toBe(1);
    expect(rating.elo).toBeGreaterThan(1500);
  });

  test("reflect catches a fabrication and replaces with a stall reply", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    // Sales LLM is hit twice per turn when reflect=on:
    //   1) generation
    //   2) reflect verifier
    // Need vacanciesBlock so answerWithRag has CONTEXT and proceeds to
    // generation; otherwise it short-circuits to NO_CONTEXT (path=no_context).
    const salesChat = scriptedChat([
      "Ближайший вылет в январь-февраль 2025 года", // fabrication
      '{"grounded":false,"reason":"date not in CONTEXT"}', // reflect verdict → ungrounded
      "Ок, удобно тебе анкету сейчас?", // turn 1 grounded reply
      '{"grounded":true}', // reflect verdict turn 1
    ]);
    const candidateChat = scriptedChat(["ну ладно", "ок, давай оформляться"]);
    const judgeChat = scriptedChat([
      '["specific-next-step"]',
      '{"outcome":"won","reason":"agreed at turn 1"}',
    ]);

    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
        reflect: true,
        stallReply: "Секунду, уточню",
        vacanciesBlock: "АКТУАЛЬНЫЕ ВАКАНСИИ:\n- Корея, караоке хостес",
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("time-pressed-zhanna")!,
        maxTurns: 3,
      },
    );

    expect(result.fabricationsCaught).toBe(1);
    const transcriptText = result.transcript.map((m) => m.text).join("\n");
    expect(transcriptText).not.toContain("январь-февраль");
    expect(transcriptText).toContain("Секунду, уточню");
  });

  test("reflect=false: fabrication leaks through (legacy behaviour)", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    const salesChat = scriptedChat(["Ближайший вылет январь 2025"]);
    const candidateChat = scriptedChat(["ок, давай оформляться"]);
    const judgeChat = scriptedChat([
      '["social-proof-stat"]',
      '{"outcome":"won","reason":"agreed"}',
    ]);

    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
        reflect: false,
        vacanciesBlock: "АКТУАЛЬНЫЕ ВАКАНСИИ:\n- Корея",
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("eager-kate")!,
        maxTurns: 3,
      },
    );

    expect(result.fabricationsCaught).toBe(0);
    expect(result.transcript.map((m) => m.text).join("\n")).toContain("январь 2025");
  });

  test("lost match records losses", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    const salesChat = scriptedChat(["рассказывай про себя?"]);
    const candidateChat = scriptedChat(["не интересно, передумала"]);
    const judgeChat = scriptedChat(['{"outcome":"lost","reason":"candidate refused"}']);
    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("skeptic-anya")!,
        maxTurns: 5,
      },
    );
    expect(result.outcome).toBe("lost");
    const aggs = await outcomes.aggregate();
    for (const a of aggs) expect(a.losses).toBe(1);
    expect((await ratings.bySlug(alinaInfinity.slug))!.losses).toBe(1);
  });

  test("respects maxTurns and falls through to judge when no early conclusion", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    // Sales says something; candidate replies vaguely; loop exhausts; judge → draw.
    const salesChat = scriptedChat(["скажи возраст?", "понятно", "ок"]);
    const candidateChat = scriptedChat(["хм", "может", "не знаю"]);
    const judgeChat = scriptedChat(['{"outcome":"draw","reason":"timeout"}']);
    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("cold-shopping-tanya")!,
        maxTurns: 3,
      },
    );
    expect(result.outcome).toBe("draw");
    // turns counted from full transcript (candidate+sales=2 messages per turn).
    expect(result.transcript.length).toBeGreaterThan(2);
  });

  test("empty candidate reply ends as 'lost' without calling judge", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    const salesChat = scriptedChat(["привет!"]);
    const candidateChat = scriptedChat([""]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"should NOT be called"}']);
    const result = await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("cold-shopping-tanya")!,
      },
    );
    expect(result.outcome).toBe("lost");
    expect(result.verdict.reason).toContain("ghosted");
  });

  test("self-play outcomes use source='self_play' (queryable, distinct from real leads)", async () => {
    const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
    const salesChat = scriptedChat(["анкету заполним?"]);
    const candidateChat = scriptedChat(["я согласна"]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"yes"}']);
    await runSelfPlayMatch(
      {
        db: sql,
        kb,
        skills,
        outcomes,
        ratings,
        salesChat,
        candidateChat,
        judgeChat,
        embedder: fakeEmbedder(),
      },
      {
        style: alinaInfinity,
        styleId: styleRow.id,
        persona: CANDIDATE_BY_SLUG.get("eager-kate")!,
        maxTurns: 5,
      },
    );
    const recent = await outcomes.recent(10);
    expect(recent.length).toBe(2);
    for (const r of recent) expect(r.source).toBe("self_play");
  });
});
