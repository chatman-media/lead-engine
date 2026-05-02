import { describe, expect, test } from "bun:test";

import {
  ESCALATION_REPLIES,
  PLACEHOLDER_REPLIES,
  PROCESSING_FAILURE_REPLIES,
  QUEUED_REPLIES,
  pickHumanStallPhrase,
} from "@/telegram/human-replies.ts";

const ALL_POOLS = [
  ESCALATION_REPLIES,
  QUEUED_REPLIES,
  PLACEHOLDER_REPLIES,
  PROCESSING_FAILURE_REPLIES,
] as const;

/**
 * Words that would break the human-manager illusion. The bot must NEVER tell
 * a candidate it's a robot, an AI, an assistant, or that "an operator will
 * write later" — the persona depends on the candidate believing they're
 * talking to a real person.
 */
const FORBIDDEN_TOKENS = [
  /\bбот\b/i,
  /\bассистент/i,
  /\bии\b/i,
  /\bоператор/i,
  /\bколлега\b/i,
  /\bнейросет/i,
  /\bAI\b/,
  /\bbot\b/i,
];

/**
 * Tone words from the bad earlier version. They're not "wrong" per se but
 * sound like a teenage blogger, not a recruiter — and don't appear in the
 * real-agent corpus we calibrated against. Keep them out of the pools.
 */
const FORBIDDEN_CRINGE = [
  /щас\s+дорисую/i,
  /дорисую\s+ответ/i,
  /не\s+теряла/i,
  /минуточку\s+совсем/i,
  /чуть\s+затянул/i,
  /дубль(нуть|нёшь)/i,
  /своим\s+записи/i, // typo from the earlier version
];

describe("human-replies pools — content sanity", () => {
  test("no pool is empty", () => {
    for (const pool of ALL_POOLS) {
      expect(pool.length).toBeGreaterThan(0);
    }
  });

  test.each(ALL_POOLS.flatMap((p) => p.map((s) => [s] as const)))(
    "phrase %s never names the bot as bot/AI/assistant/operator",
    (phrase) => {
      for (const pattern of FORBIDDEN_TOKENS) {
        expect(phrase).not.toMatch(pattern);
      }
    },
  );

  test.each(ALL_POOLS.flatMap((p) => p.map((s) => [s] as const)))(
    "phrase %s avoids cringy / unprofessional turns of phrase",
    (phrase) => {
      for (const pattern of FORBIDDEN_CRINGE) {
        expect(phrase).not.toMatch(pattern);
      }
    },
  );

  test.each(ALL_POOLS.flatMap((p) => p.map((s) => [s] as const)))(
    "phrase %s is a complete sentence with terminal punctuation",
    (phrase) => {
      expect(phrase.length).toBeGreaterThan(8);
      expect(phrase.length).toBeLessThan(200);
      expect(phrase[phrase.length - 1]).toMatch(/[.!?]/);
    },
  );

  test("all pools contain Russian Cyrillic (not English-only)", () => {
    for (const pool of ALL_POOLS) {
      for (const phrase of pool) {
        expect(phrase).toMatch(/[А-Яа-яЁё]/);
      }
    }
  });
});

describe("pickHumanStallPhrase — determinism + distribution", () => {
  test("same (conversationId, text) always returns the same phrase", () => {
    const a = pickHumanStallPhrase(ESCALATION_REPLIES, 42, "hello");
    const b = pickHumanStallPhrase(ESCALATION_REPLIES, 42, "hello");
    const c = pickHumanStallPhrase(ESCALATION_REPLIES, 42, "hello");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("different conversation ids can produce different phrases", () => {
    // With 4 phrases × ~50 conversations there should be at least 2 distinct picks.
    const picks = new Set<string>();
    for (let i = 0; i < 50; i++) {
      picks.add(pickHumanStallPhrase(ESCALATION_REPLIES, i, "hi"));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  test("different texts within the same conversation can produce different phrases", () => {
    const picks = new Set<string>();
    const samples = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (const t of samples) {
      picks.add(pickHumanStallPhrase(ESCALATION_REPLIES, 1, t));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  test("returned phrase is always one of the pool", () => {
    for (let i = 0; i < 200; i++) {
      const phrase = pickHumanStallPhrase(ESCALATION_REPLIES, i, `t${i}`);
      expect(ESCALATION_REPLIES).toContain(phrase);
    }
  });

  test("single-element pool always returns that element", () => {
    const single = ["only"] as const;
    expect(pickHumanStallPhrase(single, 1, "x")).toBe("only");
    expect(pickHumanStallPhrase(single, 999, "y")).toBe("only");
  });

  test("empty pool returns empty string (defensive — never used in production)", () => {
    expect(pickHumanStallPhrase([], 1, "x")).toBe("");
  });

  test("Unicode text doesn't crash and is deterministic", () => {
    const a = pickHumanStallPhrase(ESCALATION_REPLIES, 42, "привет, как дела?");
    const b = pickHumanStallPhrase(ESCALATION_REPLIES, 42, "привет, как дела?");
    expect(a).toBe(b);
    expect(ESCALATION_REPLIES).toContain(a);
  });

  test("over 1000 random conversations, distribution covers all pool entries", () => {
    // Light statistical sanity check — every variant should appear at least
    // once in 1000 picks. If the hash is degenerate (collapses to one bucket)
    // this fails.
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const p = pickHumanStallPhrase(QUEUED_REPLIES, i, `msg-${i}`);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    expect(counts.size).toBe(QUEUED_REPLIES.length);
    for (const [, n] of counts) {
      // Each variant should land at least 50 of 1000 (5%) — well below the
      // 25% expected for uniform distribution, but enough to detect a hash
      // that's badly biased.
      expect(n).toBeGreaterThan(50);
    }
  });
});
