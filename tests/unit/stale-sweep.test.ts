import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "@/db/repos/skill-outcomes.ts";
import { StylesRepo } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import type { AttributionDeps } from "@/leads/outcome-attribution.ts";
import { runStaleLeadSweep } from "@/leads/stale-sweep.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let users: UsersRepo;
let leads: LeadsRepo;
let deps: AttributionDeps;

beforeEach(() => {
  users = new UsersRepo(sql);
  leads = new LeadsRepo(sql);
  deps = {
    db: sql,
    outcomes: new SkillOutcomesRepo(sql),
    ratings: new StyleRatingsRepo(sql),
    messages: new MessagesRepo(sql),
    conversations: new ConversationsRepo(sql),
    styles: new StylesRepo(sql),
  };
});

/** Force a lead's `updated_at` back by `days` so the sweep sees it as stale. */
async function backdate(leadId: number, days: number): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  await sql`UPDATE leads SET updated_at = ${epoch} WHERE id = ${leadId}`;
}

describe("runStaleLeadSweep — per-state cutoff", () => {
  test("docs_pending lead aged 20 days is NOT closed (30-day cutoff)", async () => {
    const u = await users.create({ tgUserId: 7001 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    await leads.setState(l.id, "approved");
    await leads.setState(l.id, "docs_pending");
    await backdate(l.id, 20);

    await runStaleLeadSweep(deps);
    expect((await leads.byId(l.id))?.state).toBe("docs_pending");
  });

  test("docs_pending lead aged 35 days IS closed", async () => {
    const u = await users.create({ tgUserId: 7002 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    await leads.setState(l.id, "approved");
    await leads.setState(l.id, "docs_pending");
    await backdate(l.id, 35);

    const result = await runStaleLeadSweep(deps);
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect((await leads.byId(l.id))?.state).toBe("closed");
  });

  test("intake_pending lead aged 20 days IS closed (14-day cutoff unchanged)", async () => {
    const u = await users.create({ tgUserId: 7003 });
    const l = await leads.ensureForUser(u.id);
    await backdate(l.id, 20);

    await runStaleLeadSweep(deps);
    expect((await leads.byId(l.id))?.state).toBe("closed");
  });

  test("fresh docs_pending lead is left alone", async () => {
    const u = await users.create({ tgUserId: 7004 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    await leads.setState(l.id, "approved");
    await leads.setState(l.id, "docs_pending");

    await runStaleLeadSweep(deps);
    expect((await leads.byId(l.id))?.state).toBe("docs_pending");
  });
});
