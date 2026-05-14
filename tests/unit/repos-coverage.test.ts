// Coverage harness for four repos that the pre-this-PR baseline showed
// at ~0-5% line coverage: userbot-send-queue, pairwise-matches,
// shadow-evaluations, coach-proposals. The point isn't depth — it's to
// exercise every method at least once so a column-rename or SQL typo
// stops landing green (as `solo_match_a_id` did, see ops-routes PR).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { CoachProposalsRepo } from "@/db/repos/coach-proposals.ts";
import { PairwiseMatchesRepo } from "@/db/repos/pairwise-matches.ts";
import { ShadowEvaluationsRepo } from "@/db/repos/shadow-evaluations.ts";
import {
  dequeuePending,
  enqueue,
  MAX_SEND_ATTEMPTS,
  markFailed,
  markSent,
} from "@/db/repos/userbot-send-queue.ts";
import type { CoachProposal } from "@/sales/coach.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

// Skip the argon2 password hash — coach_proposals.decided_by_admin_id has a
// FK to admins(id) so we just need a row with the right id, not a real login.
async function insertAdminId(): Promise<number> {
  const [row] = await sql<
    { id: number }[]
  >`INSERT INTO admins (email, password_hash) VALUES ('test@x', 'unused') RETURNING id`;
  return row!.id;
}

// ─── userbot-send-queue ────────────────────────────────────────────────

describe("userbot-send-queue", () => {
  test("enqueue inserts a row and returns its id", async () => {
    const id = await enqueue(sql, 12345, "hello");
    expect(id).toBeGreaterThan(0);

    const [row] = await sql<
      { tg_user_id: number; text: string; sent_at: number | null; attempts: number }[]
    >`SELECT tg_user_id, text, sent_at, attempts FROM userbot_send_queue WHERE id = ${id}`;
    expect(row?.tg_user_id).toBe(12345);
    expect(row?.text).toBe("hello");
    expect(row?.sent_at).toBeNull();
    expect(row?.attempts).toBe(0);
  });

  test("dequeuePending claims unsent rows and bumps attempts", async () => {
    const id1 = await enqueue(sql, 1, "a");
    const id2 = await enqueue(sql, 2, "b");

    const claimed = await dequeuePending(sql);
    expect(claimed.map((r) => r.id).sort((x, y) => x - y)).toEqual([id1, id2]);
    expect(claimed.every((r) => r.attempts === 1)).toBe(true);

    // Second drain bumps to attempts=2 (they're still unsent).
    const claimed2 = await dequeuePending(sql);
    expect(claimed2.every((r) => r.attempts === 2)).toBe(true);
  });

  test("dequeuePending excludes rows with sent_at NOT NULL", async () => {
    const sentId = await enqueue(sql, 100, "already sent");
    await markSent(sql, sentId);
    const pendingId = await enqueue(sql, 101, "still pending");

    const claimed = await dequeuePending(sql);
    expect(claimed.map((r) => r.id)).toEqual([pendingId]);
  });

  test("dequeuePending excludes rows past MAX_SEND_ATTEMPTS (parked)", async () => {
    const stuckId = await enqueue(sql, 200, "stuck");
    // Simulate hitting the cap.
    await sql`UPDATE userbot_send_queue SET attempts = ${MAX_SEND_ATTEMPTS} WHERE id = ${stuckId}`;
    const freshId = await enqueue(sql, 201, "fresh");

    const claimed = await dequeuePending(sql);
    expect(claimed.map((r) => r.id)).toEqual([freshId]);
  });

  test("markSent populates sent_at", async () => {
    const id = await enqueue(sql, 300, "x");
    await markSent(sql, id);
    const [row] = await sql<{ sent_at: number | null }[]>`
      SELECT sent_at FROM userbot_send_queue WHERE id = ${id}
    `;
    expect(row?.sent_at).toBeGreaterThan(0);
  });

  test("markFailed populates error", async () => {
    const id = await enqueue(sql, 400, "x");
    await markFailed(sql, id, "FLOOD_WAIT");
    const [row] = await sql<{ error: string | null; sent_at: number | null }[]>`
      SELECT error, sent_at FROM userbot_send_queue WHERE id = ${id}
    `;
    expect(row?.error).toBe("FLOOD_WAIT");
    // markFailed must NOT mark the row as sent — the drain retries it.
    expect(row?.sent_at).toBeNull();
  });
});

// ─── pairwise-matches ──────────────────────────────────────────────────

describe("PairwiseMatchesRepo", () => {
  const insertArgs = (overrides: Partial<Parameters<PairwiseMatchesRepo["insert"]>[0]> = {}) => ({
    styleASlug: "alina",
    styleBSlug: "masha",
    personaSlug: "skeptic",
    winner: "a" as const,
    judgeReason: "more concrete",
    matchAId: null,
    matchBId: null,
    eloAAfter: 1520,
    eloBAfter: 1480,
    ...overrides,
  });

  test("insert + byId roundtrip", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    const row = await repo.insert(insertArgs());
    expect(row.id).toBeGreaterThan(0);
    expect(row.winner).toBe("a");
    expect(row.elo_a_after).toBe(1520);

    const reloaded = await repo.byId(row.id);
    expect(reloaded?.id).toBe(row.id);
  });

  test("byId returns null for unknown id", async () => {
    expect(await new PairwiseMatchesRepo(sql).byId(99999)).toBeNull();
  });

  test("list with no filter returns all rows newest-first", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    const a = await repo.insert(insertArgs({ styleASlug: "a1" }));
    const b = await repo.insert(insertArgs({ styleASlug: "a2" }));
    const c = await repo.insert(insertArgs({ styleASlug: "a3" }));

    const rows = await repo.list();
    expect(rows.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  test("list filters by every named option", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "masha", winner: "a" }));
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "anya", winner: "b" }));
    await repo.insert(
      insertArgs({ styleASlug: "masha", styleBSlug: "alina", personaSlug: "buyer" }),
    );

    expect((await repo.list({ styleASlug: "alina" })).length).toBe(2);
    expect((await repo.list({ styleBSlug: "alina" })).length).toBe(1);
    expect((await repo.list({ styleASlug: "alina", styleBSlug: "masha" })).length).toBe(1);
    expect((await repo.list({ personaSlug: "buyer" })).length).toBe(1);
    expect((await repo.list({ winner: "a" })).length).toBe(2);
    // All-four-filters branch.
    expect(
      (
        await repo.list({
          styleASlug: "alina",
          styleBSlug: "masha",
          personaSlug: "skeptic",
          winner: "a",
        })
      ).length,
    ).toBe(1);
  });

  test("list honors limit", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    for (let i = 0; i < 5; i++) await repo.insert(insertArgs({ judgeReason: `r${i}` }));
    expect((await repo.list({ limit: 2 })).length).toBe(2);
  });

  test("matrix aggregates a_wins / b_wins / draws per (a, b) pair", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "masha", winner: "a" }));
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "masha", winner: "a" }));
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "masha", winner: "b" }));
    await repo.insert(insertArgs({ styleASlug: "alina", styleBSlug: "masha", winner: "draw" }));

    const matrix = await repo.matrix();
    expect(matrix.length).toBe(1);
    const [r] = matrix;
    expect(r?.style_a_slug).toBe("alina");
    expect(r?.style_b_slug).toBe("masha");
    expect(r?.a_wins).toBe(2);
    expect(r?.b_wins).toBe(1);
    expect(r?.draws).toBe(1);
    expect(r?.total).toBe(4);
  });

  test("count tracks the row total", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    expect(await repo.count()).toBe(0);
    await repo.insert(insertArgs());
    await repo.insert(insertArgs());
    expect(await repo.count()).toBe(2);
  });

  test("delete returns true on hit, false on miss", async () => {
    const repo = new PairwiseMatchesRepo(sql);
    const row = await repo.insert(insertArgs());
    expect(await repo.delete(row.id)).toBe(true);
    expect(await repo.byId(row.id)).toBeNull();
    expect(await repo.delete(row.id)).toBe(false);
  });
});

// ─── coach-proposals (seeds shadow-evaluations below) ──────────────────

const SAMPLE_PROPOSAL: CoachProposal = {
  summary: "tighten openers; reduce hedge words",
  edits: {
    voice_tone: "direct, friendly",
    hooks_add: [{ kind: "scarcity", text: "ограниченные места" }],
    stage_guidance: { opener: "short and curious" },
  },
  rationale: ["Lost matches show buyer disengaging after 2nd turn", "Hedge words dilute trust"],
};

describe("CoachProposalsRepo", () => {
  test("insert + byId parses edits/rationale JSON back into structured fields", async () => {
    const repo = new CoachProposalsRepo(sql);
    const row = await repo.insert({
      styleSlug: "alina",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    expect(row.status).toBe("pending");

    const detail = await repo.byId(row.id);
    expect(detail?.summary).toBe(SAMPLE_PROPOSAL.summary);
    expect(detail?.edits.voice_tone).toBe("direct, friendly");
    expect(detail?.rationale).toEqual(SAMPLE_PROPOSAL.rationale);
  });

  test("byId tolerates corrupt edits_json / rationale_json (returns empty defaults)", async () => {
    // The byId parser swallows JSON.parse failures so a botched insert doesn't
    // 500 the admin coach page — verify that invariant.
    const repo = new CoachProposalsRepo(sql);
    await sql`
      INSERT INTO coach_proposals (style_slug, sample_size, persona_filter, summary, edits_json, rationale_json)
      VALUES ('s', 0, NULL, 'bad', '{not json', 'also not json')
    `;
    const [r] = await sql<{ id: number }[]>`SELECT id FROM coach_proposals WHERE summary = 'bad'`;
    const detail = await repo.byId(r!.id);
    expect(detail?.edits).toEqual({});
    expect(detail?.rationale).toEqual([]);
  });

  test("byId returns null for unknown id", async () => {
    expect(await new CoachProposalsRepo(sql).byId(99999)).toBeNull();
  });

  test("list filters by style + status", async () => {
    const repo = new CoachProposalsRepo(sql);
    const adminId = await insertAdminId();
    await repo.insert({
      styleSlug: "alina",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.insert({
      styleSlug: "masha",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    const applied = await repo.insert({
      styleSlug: "alina",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.decide({ id: applied.id, status: "applied", adminId });

    expect((await repo.list()).length).toBe(3);
    expect((await repo.list({ styleSlug: "alina" })).length).toBe(2);
    expect((await repo.list({ status: "pending" })).length).toBe(2);
    expect((await repo.list({ styleSlug: "alina", status: "applied" })).length).toBe(1);
  });

  test("list honors limit", async () => {
    const repo = new CoachProposalsRepo(sql);
    for (let i = 0; i < 3; i++) {
      await repo.insert({
        styleSlug: "s",
        sampleSize: 1,
        personaFilter: null,
        proposal: SAMPLE_PROPOSAL,
      });
    }
    expect((await repo.list({ limit: 2 })).length).toBe(2);
  });

  test("decide flips pending → applied/dismissed; refuses a non-pending row", async () => {
    const repo = new CoachProposalsRepo(sql);
    const adminId = await insertAdminId();
    const row = await repo.insert({
      styleSlug: "s",
      sampleSize: 1,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });

    expect(await repo.decide({ id: row.id, status: "applied", adminId })).toBe(true);
    // Second decide on the same row is a no-op — the WHERE clause requires status='pending'.
    expect(await repo.decide({ id: row.id, status: "dismissed", adminId })).toBe(false);

    const detail = await repo.byId(row.id);
    expect(detail?.status).toBe("applied");
    expect(detail?.decided_by_admin_id).toBe(adminId);
    expect(detail?.decided_at).toBeGreaterThan(0);
  });

  test("countPending only counts status=pending rows", async () => {
    const repo = new CoachProposalsRepo(sql);
    const adminId = await insertAdminId();
    await repo.insert({
      styleSlug: "s",
      sampleSize: 1,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    const decided = await repo.insert({
      styleSlug: "s",
      sampleSize: 1,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.decide({ id: decided.id, status: "dismissed", adminId });

    expect(await repo.countPending()).toBe(1);
  });

  test("delete returns true on hit, false on miss", async () => {
    const repo = new CoachProposalsRepo(sql);
    const row = await repo.insert({
      styleSlug: "s",
      sampleSize: 1,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    expect(await repo.delete(row.id)).toBe(true);
    expect(await repo.delete(row.id)).toBe(false);
  });
});

// ─── shadow-evaluations (needs a coach_proposals row for the FK) ───────

describe("ShadowEvaluationsRepo", () => {
  async function seedProposalId(): Promise<number> {
    const repo = new CoachProposalsRepo(sql);
    const row = await repo.insert({
      styleSlug: "alina",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    return row.id;
  }

  test("insert seeds counters at zero and status=running", async () => {
    const proposalId = await seedProposalId();
    const repo = new ShadowEvaluationsRepo(sql);
    const row = await repo.insert({
      proposalId,
      parentStyleSlug: "alina",
      parentStyleId: 1,
      newStyleSlug: "alina-v2",
      newStyleId: 2,
      pairsPlanned: 10,
    });
    expect(row.status).toBe("running");
    expect(row.pairs_planned).toBe(10);
    expect(row.pairs_done).toBe(0);
    expect(row.a_wins).toBe(0);
    expect(row.decision).toBeNull();
    expect(row.completed_at).toBeNull();
  });

  test("bumpPairResult routes one increment to the right column per winner", async () => {
    const proposalId = await seedProposalId();
    const repo = new ShadowEvaluationsRepo(sql);
    const row = await repo.insert({
      proposalId,
      parentStyleSlug: "p",
      parentStyleId: 1,
      newStyleSlug: "n",
      newStyleId: 2,
      pairsPlanned: 5,
    });

    await repo.bumpPairResult(row.id, "a");
    await repo.bumpPairResult(row.id, "a");
    await repo.bumpPairResult(row.id, "b");
    await repo.bumpPairResult(row.id, "draw");

    const reloaded = await repo.byId(row.id);
    expect(reloaded?.pairs_done).toBe(4);
    expect(reloaded?.a_wins).toBe(2);
    expect(reloaded?.b_wins).toBe(1);
    expect(reloaded?.draws).toBe(1);
  });

  test("complete sets status, decision, win_rate_lb, completed_at", async () => {
    const proposalId = await seedProposalId();
    const repo = new ShadowEvaluationsRepo(sql);
    const row = await repo.insert({
      proposalId,
      parentStyleSlug: "p",
      parentStyleId: 1,
      newStyleSlug: "n",
      newStyleId: 2,
      pairsPlanned: 5,
    });

    await repo.complete(row.id, 0.62, "keep");
    const reloaded = await repo.byId(row.id);
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.decision).toBe("keep");
    expect(reloaded?.win_rate_lb).toBeCloseTo(0.62);
    expect(reloaded?.completed_at).toBeGreaterThan(0);
  });

  test("fail sets status=failed and error_message", async () => {
    const proposalId = await seedProposalId();
    const repo = new ShadowEvaluationsRepo(sql);
    const row = await repo.insert({
      proposalId,
      parentStyleSlug: "p",
      parentStyleId: 1,
      newStyleSlug: "n",
      newStyleId: 2,
      pairsPlanned: 5,
    });

    await repo.fail(row.id, "LLM timeout after 3 retries");
    const reloaded = await repo.byId(row.id);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.error_message).toBe("LLM timeout after 3 retries");
    expect(reloaded?.completed_at).toBeGreaterThan(0);
  });

  test("byId returns null for unknown id", async () => {
    expect(await new ShadowEvaluationsRepo(sql).byId(99999)).toBeNull();
  });

  test("latestForProposal returns the most-recent eval for that proposal", async () => {
    const proposalId = await seedProposalId();
    const repo = new ShadowEvaluationsRepo(sql);
    const a = await repo.insert({
      proposalId,
      parentStyleSlug: "p",
      parentStyleId: 1,
      newStyleSlug: "n",
      newStyleId: 2,
      pairsPlanned: 5,
    });
    const b = await repo.insert({
      proposalId,
      parentStyleSlug: "p",
      parentStyleId: 1,
      newStyleSlug: "n",
      newStyleId: 2,
      pairsPlanned: 5,
    });

    const latest = await repo.latestForProposal(proposalId);
    expect(latest?.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  test("latestForProposal returns null when no evals exist", async () => {
    const proposalId = await seedProposalId();
    expect(await new ShadowEvaluationsRepo(sql).latestForProposal(proposalId)).toBeNull();
  });
});
