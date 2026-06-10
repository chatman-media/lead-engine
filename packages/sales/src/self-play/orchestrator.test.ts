// Unit tests for self-play orchestration: runSelfPlayMatch (orchestrator),
// runPairwiseMatch (pairwise) и runShadowEval (shadow-eval). Все коллабораторы
// (repos / chat clients / kb / embedder) — in-memory фейки; answerWithRag
// прогоняется по-настоящему на фейковом KB (style задан → не no_context).
// Без БД и сети.

import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import type { IKbStore } from "@chatman-media/kb";
import { runPairwiseMatch } from "./pairwise.ts";
import { runShadowEval } from "../shadow-eval.ts";
import {
  _testCandidateConcluded,
  runSelfPlayMatch,
  type SelfPlayDeps,
} from "./orchestrator.ts";
import type { CandidatePersona } from "./personas.ts";
import {
  SELF_PLAY_DEFAULT_STALL_REPLY,
  SELF_PLAY_STALL_CTA_FALLBACK,
} from "../prompts/orchestrator.ts";
import { StyleSchema, type Style } from "../types.ts";

const STYLE_A: Style = StyleSchema.parse({
  slug: "style-a",
  displayName: "Style A",
  persona: { name: "Алекс", role: "human", company: "Acme" },
  voice: { tone: "дружелюбный", language: "ru" },
  framework: "SPIN",
  stages: { qualify: { goal: "понять запрос" } },
  guardrails: {},
  model: {},
});
const STYLE_B: Style = StyleSchema.parse({ ...STYLE_A, slug: "style-b", displayName: "Style B" });

const PERSONA: CandidatePersona = {
  slug: "test-persona",
  displayName: "Тест",
  systemPrompt: "Ты кандидат. Отвечай коротко.",
  opener: "привет, увидела ваше объявление, расскажите про вакансию",
  judgingHint: "candidate commits to anketa = win",
} as CandidatePersona;

const kb: IKbStore = {
  search: async () => [],
  hybridSearch: async () => [],
  prioritySearch: async () => [],
} as unknown as IKbStore;

const embedder: EmbeddingClient = {
  embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
  dim: 3,
};

const salesChat: ChatClient = {
  complete: async () => "Здравствуйте! Расскажу про вакансию и условия.",
} as unknown as ChatClient;

/** judge: разный ответ для pairwise («comparing TWO») и solo-judge. */
function judgeChat(soloOutcome = "won", pairwiseWinner = "b"): ChatClient {
  return {
    complete: async (msgs: ChatMessage[]) => {
      const sys = String(msgs[0]?.content ?? "");
      if (sys.includes("comparing TWO")) {
        return `{"winner":"${pairwiseWinner}","reason":"B closed better"}`;
      }
      return `{"outcome":"${soloOutcome}","reason":"committed"}`;
    },
  } as unknown as ChatClient;
}

/** candidate: сразу «соглашается» → диалог завершается за 1 ход. */
const candidateConcludes: ChatClient = {
  complete: async () => "давай оформляем анкету",
} as unknown as ChatClient;

interface FakeState {
  outcomes: Array<{ skillSlug: string; outcome: string }>;
  ratings: Map<number, number>;
  matches: number;
  pairwise: number;
  shadowUpdates: Array<Record<string, unknown>>;
}

function makeDeps(over: Partial<SelfPlayDeps> = {}, state?: FakeState): SelfPlayDeps & { _state: FakeState } {
  const s: FakeState = state ?? {
    outcomes: [],
    ratings: new Map(),
    matches: 0,
    pairwise: 0,
    shadowUpdates: [],
  };
  let nextId = 1;
  const deps = {
    users: { upsert: async () => ({ id: nextId++ }) },
    conversations: { create: async () => ({ id: nextId++ }) },
    leads: { create: async () => ({ id: nextId++ }) },
    kb,
    skills: {
      skillsForStyle: async () => [
        {
          slug: "mirror",
          display_name: "Зеркало",
          prompt_fragment: "отражай",
          applicable_stages: [],
          is_enabled: true,
        },
      ],
    },
    outcomes: {
      record: async (o: { skillSlug: string; outcome: string }) => {
        s.outcomes.push(o);
      },
      aggregates: async () => [],
    },
    ratings: {
      getRating: async (id: number) => s.ratings.get(id) ?? 1500,
      setRating: async (id: number, r: number) => {
        s.ratings.set(id, r);
      },
    },
    matches: {
      insert: async () => {
        s.matches++;
        return s.matches;
      },
      byId: async () => null,
      list: async () => [],
    },
    salesChat,
    candidateChat: candidateConcludes,
    judgeChat: judgeChat(),
    embedder,
    reflect: false,
    ...over,
  } as unknown as SelfPlayDeps & { _state: FakeState };
  deps._state = s;
  return deps;
}

describe("runSelfPlayMatch", () => {
  it("happy: candidate соглашается → won, транскрипт + persist + ELO", async () => {
    const deps = makeDeps();
    const r = await runSelfPlayMatch(deps, { style: STYLE_A, styleId: 1, persona: PERSONA });
    expect(r.outcome).toBe("won");
    expect(r.transcript.length).toBeGreaterThanOrEqual(2);
    expect(r.transcript[0]!.role).toBe("candidate");
    expect(r.skillsAttributed).toContain("mirror");
    expect(r.persisted).toBe(true);
    expect(r.matchId).toBe(1);
    // ELO обновлён (won → выше 1500)
    expect(deps._state.ratings.get(1)).toBeGreaterThan(1500);
    expect(deps._state.outcomes.some((o) => o.outcome === "won")).toBe(true);
  });

  it("candidate вернул пустой ответ → lost (ghosted)", async () => {
    const deps = makeDeps({
      candidateChat: { complete: async () => "   " } as unknown as ChatClient,
    });
    const r = await runSelfPlayMatch(deps, { style: STYLE_A, styleId: 1, persona: PERSONA });
    expect(r.outcome).toBe("lost");
    expect(r.verdict.reason).toMatch(/ghosted/);
  });

  it("candidate LLM упал → draw", async () => {
    const deps = makeDeps({
      candidateChat: {
        complete: async () => {
          throw new Error("candidate down");
        },
      } as unknown as ChatClient,
    });
    const r = await runSelfPlayMatch(deps, { style: STYLE_A, styleId: 1, persona: PERSONA });
    expect(r.outcome).toBe("draw");
    expect(r.verdict.reason).toMatch(/candidate LLM failed/);
  });

  it("нет skills → leadId -1, без persist outcome", async () => {
    const deps = makeDeps({
      skills: { skillsForStyle: async () => [] } as never,
    });
    const r = await runSelfPlayMatch(deps, { style: STYLE_A, styleId: 1, persona: PERSONA });
    expect(r.leadId).toBe(-1);
    expect(deps._state.outcomes.length).toBe(0);
  });

  it("ungrounded-ответы подменяются stall, 3 подряд → CTA-фолбэк", async () => {
    // salesChat и для генерации, и для fact-check: генерация выдаёт «факт»,
    // checkFacts (детектим по блоку АКТУАЛЬНЫЕ ВАКАНСИИ в промпте) валит vacancyOk.
    const fabricatingSales: ChatClient = {
      complete: async (msgs: ChatMessage[]) => {
        const last = String(msgs[msgs.length - 1]?.content ?? "");
        if (last.includes("АКТУАЛЬНЫЕ ВАКАНСИИ")) {
          return '{"grounded":true,"vacancyOk":false,"reason":"salary mismatch"}';
        }
        return "Зарплата 9000 евро в день, гарантирую.";
      },
    } as unknown as ChatClient;
    const candidateKeepsAsking: ChatClient = {
      complete: async () => "понятно, а какой график работы?",
    } as unknown as ChatClient;
    const deps = makeDeps({
      salesChat: fabricatingSales,
      candidateChat: candidateKeepsAsking,
      reflect: true,
      vacanciesBlock: "Вакансия: хостес, Париж, 2000 EUR",
    });
    const r = await runSelfPlayMatch(deps, {
      style: STYLE_A,
      styleId: 1,
      persona: PERSONA,
      maxTurns: 3,
    });
    const sales = r.transcript
      .filter((m) => m.role === "salesperson")
      .map((m) => m.text);
    expect(sales).toEqual([
      SELF_PLAY_DEFAULT_STALL_REPLY,
      SELF_PLAY_DEFAULT_STALL_REPLY,
      SELF_PLAY_STALL_CTA_FALLBACK,
    ]);
    expect(r.fabricationsCaught).toBe(3);
  });

  it("stallCtaReply стиля приоритетнее CTA-фолбэка, кастомный stallReply из deps", async () => {
    const styleWithCta: Style = StyleSchema.parse({
      ...STYLE_A,
      slug: "style-cta",
      voice: {
        tone: "дружелюбный",
        language: "ru",
        stallCtaReply: "Запишемся на звонок?",
      },
    });
    const fabricatingSales: ChatClient = {
      complete: async (msgs: ChatMessage[]) => {
        const last = String(msgs[msgs.length - 1]?.content ?? "");
        if (last.includes("АКТУАЛЬНЫЕ ВАКАНСИИ")) {
          return '{"grounded":true,"vacancyOk":false,"reason":"city mismatch"}';
        }
        return "Работа в Лондоне, жильё бесплатно.";
      },
    } as unknown as ChatClient;
    const deps = makeDeps({
      salesChat: fabricatingSales,
      candidateChat: {
        complete: async () => "а можно подробнее про условия?",
      } as unknown as ChatClient,
      reflect: true,
      vacanciesBlock: "Вакансия: хостес, Париж, 2000 EUR",
      stallReply: "Минутку, проверю по базе.",
    });
    const r = await runSelfPlayMatch(deps, {
      style: styleWithCta,
      styleId: 9,
      persona: PERSONA,
      maxTurns: 3,
    });
    const sales = r.transcript
      .filter((m) => m.role === "salesperson")
      .map((m) => m.text);
    expect(sales).toEqual([
      "Минутку, проверю по базе.",
      "Минутку, проверю по базе.",
      "Запишемся на звонок?",
    ]);
  });

  it("ошибка skill-грейдинга → warning, матч продолжается до вердикта", async () => {
    const working = judgeChat();
    const deps = makeDeps();
    let judgeAccess = 0;
    Object.defineProperty(deps, "judgeChat", {
      configurable: true,
      get() {
        judgeAccess += 1;
        if (judgeAccess === 1) throw new Error("grader down");
        return working;
      },
    });
    const r = await runSelfPlayMatch(deps, {
      style: STYLE_A,
      styleId: 1,
      persona: PERSONA,
    });
    expect(r.warnings).toEqual(["turn 1 skill grading: grader down"]);
    expect(r.outcome).toBe("won");
  });

  it("persist match падает → persisted=false, matchId=null", async () => {
    const deps = makeDeps({
      matches: {
        insert: async () => {
          throw new Error("db down");
        },
        byId: async () => null,
        list: async () => [],
      } as never,
    });
    const r = await runSelfPlayMatch(deps, { style: STYLE_A, styleId: 1, persona: PERSONA });
    expect(r.persisted).toBe(false);
    expect(r.matchId).toBeNull();
  });
});

describe("_testCandidateConcluded", () => {
  it("распознаёт согласие, отказ и нейтральные реплики", () => {
    expect(_testCandidateConcluded("давай оформим анкету")).toBe(true);
    expect(_testCandidateConcluded("я согласна, оформляйте")).toBe(true);
    expect(_testCandidateConcluded("ок, давай оформим заявку")).toBe(true);
    expect(_testCandidateConcluded("мне это не интересно")).toBe(true);
    expect(_testCandidateConcluded("отстаньте от меня, это развод")).toBe(true);
    expect(_testCandidateConcluded("сколько платят и какой график?")).toBe(
      false,
    );
  });
});

describe("runPairwiseMatch", () => {
  it("два прогона + comparative judge → winner b, ELO пары обновлён, persist", async () => {
    const state: FakeState = {
      outcomes: [],
      ratings: new Map(),
      matches: 0,
      pairwise: 0,
      shadowUpdates: [],
    };
    const base = makeDeps({}, state);
    const deps = {
      ...base,
      pairwiseMatches: {
        insert: async () => {
          state.pairwise++;
          return state.pairwise;
        },
      },
    } as never;
    const r = await runPairwiseMatch(deps, {
      styleA: STYLE_A,
      styleAId: 1,
      styleB: STYLE_B,
      styleBId: 2,
      persona: PERSONA,
    });
    expect(r.verdict.winner).toBe("b");
    expect(r.persisted).toBe(true);
    expect(r.pairwiseId).toBe(1);
    expect(r.matchA.styleSlug).toBe("style-a");
    expect(r.matchB.styleSlug).toBe("style-b");
  });
});

describe("runShadowEval", () => {
  function shadowDeps(state: FakeState) {
    const base = makeDeps({}, state);
    return {
      ...base,
      shadowRepo: {
        update: async (_id: number, patch: Record<string, unknown>) => {
          state.shadowUpdates.push(patch);
        },
      },
      pairwiseMatches: { insert: async () => ++state.pairwise },
    } as never;
  }

  it("0 персон → complete/inconclusive, totalPairs 0", async () => {
    const state: FakeState = { outcomes: [], ratings: new Map(), matches: 0, pairwise: 0, shadowUpdates: [] };
    await runShadowEval(shadowDeps(state), {
      evalId: 1,
      parentStyle: STYLE_A,
      parentStyleId: 1,
      newStyle: STYLE_B,
      newStyleId: 2,
      personas: [],
      runs: 2,
      maxTurns: 4,
    });
    const last = state.shadowUpdates.at(-1)!;
    expect(last.status).toBe("complete");
    expect(last.decision).toBe("inconclusive");
    expect(last.totalPairs).toBe(0);
  });

  it("happy: гоняет пары, итоговый decision записан", async () => {
    const state: FakeState = { outcomes: [], ratings: new Map(), matches: 0, pairwise: 0, shadowUpdates: [] };
    await runShadowEval(shadowDeps(state), {
      evalId: 2,
      parentStyle: STYLE_A,
      parentStyleId: 1,
      newStyle: STYLE_B,
      newStyleId: 2,
      personas: [PERSONA],
      runs: 2,
      maxTurns: 4,
    });
    const final = state.shadowUpdates.at(-1)!;
    expect(final.status).toBe("complete");
    expect(["keep", "rollback", "inconclusive"]).toContain(final.decision as string);
    expect(final.totalPairs).toBe(2);
    expect(state.pairwise).toBe(2); // 1 персона × 2 прогона
  });

  it("ошибка в пайплайне → status failed", async () => {
    const state: FakeState = { outcomes: [], ratings: new Map(), matches: 0, pairwise: 0, shadowUpdates: [] };
    const base = makeDeps(
      { judgeChat: judgeChat() },
      state,
    );
    // pairwiseMatches.insert кидает → runPairwiseMatch ловит сам (persisted=false),
    // поэтому валим через ratings.getRating (вызывается в runPairwiseMatch вне try).
    const deps = {
      ...base,
      shadowRepo: {
        update: async (_id: number, patch: Record<string, unknown>) => {
          state.shadowUpdates.push(patch);
        },
      },
      pairwiseMatches: { insert: async () => 1 },
      ratings: {
        getRating: async () => {
          throw new Error("ratings down");
        },
        setRating: async () => {},
      },
    } as never;
    await runShadowEval(deps, {
      evalId: 3,
      parentStyle: STYLE_A,
      parentStyleId: 1,
      newStyle: STYLE_B,
      newStyleId: 2,
      personas: [PERSONA],
      runs: 1,
      maxTurns: 4,
    });
    expect(state.shadowUpdates.some((u) => u.status === "failed")).toBe(true);
  });
});
