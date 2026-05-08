import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SelfPlayMatchesRepo } from "@/db/repos/self-play-matches.ts";
import { openDb } from "@/db/sqlite.ts";

function createLead(db: ReturnType<typeof openDb>): number {
  const u = db
    .query<{ id: number }, [number]>(
      `INSERT INTO users (tg_user_id, status) VALUES (?, 'new') RETURNING id`,
    )
    .get(-Math.floor(Math.random() * 1e9))!;
  const lead = db
    .query<{ id: number }, [number]>(`INSERT INTO leads (user_id) VALUES (?) RETURNING id`)
    .get(u.id)!;
  return lead.id;
}

let db: ReturnType<typeof openDb>;
let repo: SelfPlayMatchesRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
  repo = new SelfPlayMatchesRepo(db);
});
afterEach(() => db.close());

describe("SelfPlayMatchesRepo", () => {
  test("insert + byId roundtrip preserves transcript and skills", () => {
    // Synthesise a real lead row first so the lead_id FK holds. The
    // orchestrator always does this; the test mirrors that.
    const leadId = createLead(db);
    const inserted = repo.insert({
      styleSlug: "alina-infinity-v1",
      personaSlug: "eager-kate",
      outcome: "won",
      judgeReason: "explicit yes",
      transcript: [
        { role: "candidate", text: "привет!" },
        { role: "salesperson", text: "привет, Катя!" },
        { role: "candidate", text: "ок, я согласна" },
      ],
      turns: 2,
      skills: ["social-proof-stat", "tactical-empathy"],
      leadId,
    });
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.outcome).toBe("won");

    const detail = repo.byId(inserted.id);
    expect(detail).not.toBeNull();
    expect(detail?.transcript.length).toBe(3);
    expect(detail?.transcript[0]?.role).toBe("candidate");
    expect(detail?.skills).toEqual(["social-proof-stat", "tactical-empathy"]);
    expect(detail?.lead_id).toBe(leadId);
  });

  test("byId returns null for missing", () => {
    expect(repo.byId(99999)).toBeNull();
  });

  test("list orders by id DESC and respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({
        styleSlug: "a",
        personaSlug: "p",
        outcome: i % 2 === 0 ? "won" : "lost",
        judgeReason: `m${i}`,
        transcript: [{ role: "candidate", text: "hi" }],
        turns: 1,
        skills: [],
        leadId: null,
      });
    }
    const list = repo.list({ limit: 3 });
    expect(list.length).toBe(3);
    expect(list[0]!.id).toBeGreaterThan(list[1]!.id);
    expect(list[1]!.id).toBeGreaterThan(list[2]!.id);
  });

  test("filters by style/persona/outcome compose with AND", () => {
    repo.insert({
      styleSlug: "alpha",
      personaSlug: "kate",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    repo.insert({
      styleSlug: "alpha",
      personaSlug: "anya",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    repo.insert({
      styleSlug: "beta",
      personaSlug: "kate",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });

    expect(repo.list({ styleSlug: "alpha" }).length).toBe(2);
    expect(repo.list({ personaSlug: "kate" }).length).toBe(2);
    expect(repo.list({ outcome: "won" }).length).toBe(1);
    expect(repo.list({ styleSlug: "alpha", outcome: "lost" }).length).toBe(1);
    expect(repo.list({ styleSlug: "beta", personaSlug: "kate", outcome: "lost" }).length).toBe(1);
  });

  test("matrix aggregates W/L/D by (style, persona)", () => {
    for (const o of ["won", "won", "lost", "draw"] as const) {
      repo.insert({
        styleSlug: "alpha",
        personaSlug: "kate",
        outcome: o,
        judgeReason: null,
        transcript: [],
        turns: 1,
        skills: [],
        leadId: null,
      });
    }
    repo.insert({
      styleSlug: "beta",
      personaSlug: "kate",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    const m = repo.matrix();
    const alphaKate = m.find((r) => r.style_slug === "alpha" && r.persona_slug === "kate")!;
    expect(alphaKate.won).toBe(2);
    expect(alphaKate.lost).toBe(1);
    expect(alphaKate.draw).toBe(1);
    expect(alphaKate.total).toBe(4);
  });

  test("delete removes the row", () => {
    const r = repo.insert({
      styleSlug: "a",
      personaSlug: "p",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    expect(repo.delete(r.id)).toBe(true);
    expect(repo.byId(r.id)).toBeNull();
    expect(repo.delete(r.id)).toBe(false);
  });

  test("malformed transcript_json falls back to empty array (defensive)", () => {
    const r = repo.insert({
      styleSlug: "a",
      personaSlug: "p",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    db.run(`UPDATE self_play_matches SET transcript_json = ? WHERE id = ?`, ["{not json", r.id]);
    expect(repo.byId(r.id)?.transcript).toEqual([]);
  });
});
