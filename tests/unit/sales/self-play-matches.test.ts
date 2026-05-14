import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { LeadsRepo } from "@/db/repos/leads.ts";
import { SelfPlayMatchesRepo } from "@/db/repos/self-play-matches.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

async function createLead(): Promise<number> {
  const users = new UsersRepo(sql);
  const leads = new LeadsRepo(sql);
  const u = await users.create({ tgUserId: -Math.floor(Math.random() * 1e9) });
  const lead = await leads.ensureForUser(u.id);
  return lead.id;
}

let repo: SelfPlayMatchesRepo;

beforeEach(() => {
  repo = new SelfPlayMatchesRepo(sql);
});

describe("SelfPlayMatchesRepo", () => {
  test("insert + byId roundtrip preserves transcript and skills", async () => {
    // Synthesise a real lead row first so the lead_id FK holds. The
    // orchestrator always does this; the test mirrors that.
    const leadId = await createLead();
    const inserted = await repo.insert({
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

    const detail = await repo.byId(inserted.id);
    expect(detail).not.toBeNull();
    expect(detail?.transcript.length).toBe(3);
    expect(detail?.transcript[0]?.role).toBe("candidate");
    expect(detail?.skills).toEqual(["social-proof-stat", "tactical-empathy"]);
    expect(detail?.lead_id).toBe(leadId);
  });

  test("byId returns null for missing", async () => {
    expect(await repo.byId(99999)).toBeNull();
  });

  test("list orders by id DESC and respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insert({
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
    const list = await repo.list({ limit: 3 });
    expect(list.length).toBe(3);
    expect(list[0]!.id).toBeGreaterThan(list[1]!.id);
    expect(list[1]!.id).toBeGreaterThan(list[2]!.id);
  });

  test("filters by style/persona/outcome compose with AND", async () => {
    await repo.insert({
      styleSlug: "alpha",
      personaSlug: "kate",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    await repo.insert({
      styleSlug: "alpha",
      personaSlug: "anya",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    await repo.insert({
      styleSlug: "beta",
      personaSlug: "kate",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });

    expect((await repo.list({ styleSlug: "alpha" })).length).toBe(2);
    expect((await repo.list({ personaSlug: "kate" })).length).toBe(2);
    expect((await repo.list({ outcome: "won" })).length).toBe(1);
    expect((await repo.list({ styleSlug: "alpha", outcome: "lost" })).length).toBe(1);
    expect(
      (await repo.list({ styleSlug: "beta", personaSlug: "kate", outcome: "lost" })).length,
    ).toBe(1);
  });

  test("matrix aggregates W/L/D by (style, persona)", async () => {
    for (const o of ["won", "won", "lost", "draw"] as const) {
      await repo.insert({
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
    await repo.insert({
      styleSlug: "beta",
      personaSlug: "kate",
      outcome: "lost",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    const m = await repo.matrix();
    const alphaKate = m.find((r) => r.style_slug === "alpha" && r.persona_slug === "kate")!;
    expect(alphaKate.won).toBe(2);
    expect(alphaKate.lost).toBe(1);
    expect(alphaKate.draw).toBe(1);
    expect(alphaKate.total).toBe(4);
  });

  test("delete removes the row", async () => {
    const r = await repo.insert({
      styleSlug: "a",
      personaSlug: "p",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    expect(await repo.delete(r.id)).toBe(true);
    expect(await repo.byId(r.id)).toBeNull();
    expect(await repo.delete(r.id)).toBe(false);
  });

  test("malformed transcript_json falls back to empty array (defensive)", async () => {
    const r = await repo.insert({
      styleSlug: "a",
      personaSlug: "p",
      outcome: "won",
      judgeReason: null,
      transcript: [],
      turns: 1,
      skills: [],
      leadId: null,
    });
    await sql`UPDATE self_play_matches SET transcript_json = '{not json}' WHERE id = ${r.id}`;
    expect((await repo.byId(r.id))?.transcript).toEqual([]);
  });
});
