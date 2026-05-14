import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "@/db/repos/skill-outcomes.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { attributeLeadOutcome, leadOutcome } from "@/leads/outcome-attribution.ts";
import { runStaleLeadSweep } from "@/leads/stale-sweep.ts";
import { ELO_BASELINE } from "@/sales/elo.ts";
import { alinaInfinity } from "@/sales/styles/alina-infinity.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let users: UsersRepo;
let conversations: ConversationsRepo;
let messages: MessagesRepo;
let leads: LeadsRepo;
let styles: StylesRepo;
let outcomes: SkillOutcomesRepo;
let ratings: StyleRatingsRepo;

beforeEach(async () => {
  users = new UsersRepo(sql);
  conversations = new ConversationsRepo(sql);
  messages = new MessagesRepo(sql);
  leads = new LeadsRepo(sql);
  styles = new StylesRepo(sql);
  outcomes = new SkillOutcomesRepo(sql);
  ratings = new StyleRatingsRepo(sql);
  await seedBuiltinStyles(styles, [alinaInfinity]);
});

async function seedConversationWithSkills(skillsByMsg: string[][]): Promise<{
  leadId: number;
  convId: number;
}> {
  const u = await users.create({ tgUserId: 5000 + Math.floor(Math.random() * 9000) });
  const c = await conversations.ensureForUser(u.id);
  // Pin the conversation to alina-infinity-v1 for style attribution.
  const styleRow = (await styles.bySlug(alinaInfinity.slug))!;
  await sql`UPDATE conversations SET style_id = ${styleRow.id} WHERE id = ${c.id}`;
  for (const used of skillsByMsg) {
    await messages.add({
      conversationId: c.id,
      role: "assistant",
      text: "reply",
      meta: { telemetry: { path: "ok", skills_used: used } },
    });
  }
  const lead = await leads.ensureForUser(u.id);
  return { leadId: lead.id, convId: c.id };
}

describe("leadOutcome", () => {
  test("docs_complete + submitted → won", () => {
    expect(leadOutcome({ state: "docs_complete" } as never)?.outcome).toBe("won");
    expect(leadOutcome({ state: "submitted" } as never)?.outcome).toBe("won");
  });
  test("rejected → draw", () => {
    expect(leadOutcome({ state: "rejected" } as never)?.outcome).toBe("draw");
  });
  test("closed → lost", () => {
    expect(leadOutcome({ state: "closed" } as never)?.outcome).toBe("lost");
  });
  test("non-terminal states return null", () => {
    expect(leadOutcome({ state: "intake_pending" } as never)).toBeNull();
    expect(leadOutcome({ state: "approved" } as never)).toBeNull();
  });
});

describe("attributeLeadOutcome", () => {
  test("records one outcome per skill demonstrated in last N replies", async () => {
    const { leadId } = await seedConversationWithSkills([
      ["social-proof-stat"],
      ["tactical-empathy", "calibrated-question"],
    ]);
    const lead = (await leads.setState(leadId, "docs_complete"))!;

    const r = await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      lead,
    );
    expect(r.outcomesRecorded).toBe(3);

    const agg = await outcomes.aggregate();
    const slugs = new Set(agg.map((a) => a.skill_slug));
    expect(slugs).toEqual(
      new Set(["social-proof-stat", "tactical-empathy", "calibrated-question"]),
    );
    for (const a of agg) expect(a.wins).toBe(1);
  });

  test("idempotent — second call on same lead/state inserts nothing new", async () => {
    const { leadId } = await seedConversationWithSkills([["social-proof-stat"]]);
    const lead = (await leads.setState(leadId, "docs_complete"))!;
    const r1 = await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      lead,
    );
    expect(r1.outcomesRecorded).toBe(1);
    const r2 = await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      lead,
    );
    expect(r2.outcomesRecorded).toBe(0);
    expect(r2.styleRatingUpdated).toBe(false);
    // ELO moved exactly once, not twice.
    const rating = (await ratings.bySlug(alinaInfinity.slug))!;
    expect(rating.wins).toBe(1);
  });

  test("rejected → draw outcome on every recent skill", async () => {
    const { leadId } = await seedConversationWithSkills([["accusation-audit"]]);
    const lead = (await leads.setState(leadId, "rejected"))!;
    await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      lead,
    );
    const agg = await outcomes.aggregate();
    expect(agg[0]!.skill_slug).toBe("accusation-audit");
    expect(agg[0]!.draws).toBe(1);
    expect((await ratings.bySlug(alinaInfinity.slug))!.draws).toBe(1);
  });

  test("non-terminal lead state → no-op", async () => {
    const { leadId } = await seedConversationWithSkills([["mirroring"]]);
    const lead = (await leads.setState(leadId, "approved"))!;
    const r = await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      lead,
    );
    expect(r.outcomesRecorded).toBe(0);
    expect(await outcomes.aggregate()).toEqual([]);
  });

  test("conversation with no skills_used metadata → 0 outcomes (no spurious rows)", async () => {
    const u = await users.create({ tgUserId: 8000 });
    const c = await conversations.ensureForUser(u.id);
    await messages.add({ conversationId: c.id, role: "assistant", text: "no telemetry" });
    const lead = await leads.ensureForUser(u.id);
    const submitted = (await leads.setState(lead.id, "submitted"))!;
    const r = await attributeLeadOutcome(
      { db: sql, outcomes, ratings, messages, conversations, styles },
      submitted,
    );
    expect(r.outcomesRecorded).toBe(0);
    expect(r.styleRatingUpdated).toBe(false);
  });
});

describe("StyleRatingsRepo", () => {
  test("first applyOutcome creates row at baseline +/- delta", async () => {
    const after = await ratings.applyOutcome("alina-infinity-v1", "won");
    expect(after.elo).toBeGreaterThan(ELO_BASELINE);
    expect(after.wins).toBe(1);
    expect(after.losses).toBe(0);
  });

  test("multiple outcomes accumulate", async () => {
    await ratings.applyOutcome("alina-infinity-v1", "won");
    await ratings.applyOutcome("alina-infinity-v1", "lost");
    await ratings.applyOutcome("alina-infinity-v1", "draw");
    const row = (await ratings.bySlug("alina-infinity-v1"))!;
    expect(row.wins + row.losses + row.draws).toBe(3);
  });
});

describe("runStaleLeadSweep", () => {
  test("closes leads stuck in non-terminal state past 14 days", async () => {
    const u = await users.create({ tgUserId: 6000 });
    const c = await conversations.ensureForUser(u.id);
    await messages.add({
      conversationId: c.id,
      role: "assistant",
      text: "x",
      meta: { telemetry: { skills_used: ["humor-disarm"] } },
    });
    const lead = await leads.ensureForUser(u.id);
    // Backdate updated_at past the 14d cutoff.
    const past = Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60;
    await sql`UPDATE leads SET updated_at = ${past} WHERE id = ${lead.id}`;

    const r = await runStaleLeadSweep({
      db: sql,
      outcomes,
      ratings,
      messages,
      conversations,
      styles,
    });
    expect(r.scanned).toBe(1);
    expect(r.closed).toBe(1);
    // Lead is now closed, attribution recorded a 'lost' for humor-disarm.
    expect((await leads.byId(lead.id))?.state).toBe("closed");
    const agg = await outcomes.aggregate();
    expect(agg[0]!.skill_slug).toBe("humor-disarm");
    expect(agg[0]!.losses).toBe(1);
  });

  test("does not touch leads in terminal state", async () => {
    const u = await users.create({ tgUserId: 6100 });
    await conversations.ensureForUser(u.id);
    const lead = await leads.ensureForUser(u.id);
    await leads.setState(lead.id, "rejected");
    const past = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    await sql`UPDATE leads SET updated_at = ${past} WHERE id = ${lead.id}`;
    const r = await runStaleLeadSweep({
      db: sql,
      outcomes,
      ratings,
      messages,
      conversations,
      styles,
    });
    expect(r.closed).toBe(0);
  });
});
