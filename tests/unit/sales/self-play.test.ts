import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "@/db/repos/skill-outcomes.ts";
import { SkillsRepo, seedSkillCatalogue } from "@/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { parseVerdict } from "@/sales/self-play/judge.ts";
import { runSelfPlayMatch } from "@/sales/self-play/orchestrator.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "@/sales/self-play/personas.ts";
import { alinaInfinity } from "@/sales/styles/alina-infinity.ts";

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
  let db: ReturnType<typeof openDb>;
  let kb: KbRepo;
  let skills: SkillsRepo;
  let outcomes: SkillOutcomesRepo;
  let ratings: StyleRatingsRepo;
  let styles: StylesRepo;

  beforeEach(() => {
    db = openDb({ path: ":memory:", embeddingDim: DIM });
    kb = new KbRepo(db);
    skills = new SkillsRepo(db);
    outcomes = new SkillOutcomesRepo(db);
    ratings = new StyleRatingsRepo(db);
    styles = new StylesRepo(db);
    seedSkillCatalogue(skills);
    seedBuiltinStyles(styles, [alinaInfinity]);
    // Attach a couple of skills so attribution has slugs to record.
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    skills.setSkillsForStyle(styleRow.id, ["social-proof-stat", "tactical-empathy"]);
  });
  afterEach(() => db.close());

  test("won match records outcomes + bumps style ELO", async () => {
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    // Sales replies once; candidate concludes immediately with a strong commit;
    // judge returns "won".
    const salesChat = scriptedChat(["хочешь анкету заполним?"]);
    const candidateChat = scriptedChat(["ок, давай оформляться"]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"explicit yes"}']);

    const result = await runSelfPlayMatch(
      {
        db,
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

    const aggs = outcomes.aggregate();
    expect(aggs.length).toBe(2);
    for (const a of aggs) expect(a.wins).toBe(1);

    const rating = ratings.bySlug(alinaInfinity.slug)!;
    expect(rating.wins).toBe(1);
    expect(rating.elo).toBeGreaterThan(1500);
  });

  test("lost match records losses", async () => {
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    const salesChat = scriptedChat(["рассказывай про себя?"]);
    const candidateChat = scriptedChat(["не интересно, передумала"]);
    const judgeChat = scriptedChat(['{"outcome":"lost","reason":"candidate refused"}']);
    const result = await runSelfPlayMatch(
      {
        db,
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
    const aggs = outcomes.aggregate();
    for (const a of aggs) expect(a.losses).toBe(1);
    expect(ratings.bySlug(alinaInfinity.slug)!.losses).toBe(1);
  });

  test("respects maxTurns and falls through to judge when no early conclusion", async () => {
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    // Sales says something; candidate replies vaguely; loop exhausts; judge → draw.
    const salesChat = scriptedChat(["скажи возраст?", "понятно", "ок"]);
    const candidateChat = scriptedChat(["хм", "может", "не знаю"]);
    const judgeChat = scriptedChat(['{"outcome":"draw","reason":"timeout"}']);
    const result = await runSelfPlayMatch(
      {
        db,
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
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    const salesChat = scriptedChat(["привет!"]);
    const candidateChat = scriptedChat([""]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"should NOT be called"}']);
    const result = await runSelfPlayMatch(
      {
        db,
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
    const styleRow = styles.bySlug(alinaInfinity.slug)!;
    const salesChat = scriptedChat(["анкету заполним?"]);
    const candidateChat = scriptedChat(["я согласна"]);
    const judgeChat = scriptedChat(['{"outcome":"won","reason":"yes"}']);
    await runSelfPlayMatch(
      {
        db,
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
    const recent = outcomes.recent(10);
    expect(recent.length).toBe(2);
    for (const r of recent) expect(r.source).toBe("self_play");
  });
});
