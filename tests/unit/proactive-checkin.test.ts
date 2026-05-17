import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { runProactiveCheckins } from "@/leads/proactive-checkin.ts";
import type { LeadsService } from "@/leads/service.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let users: UsersRepo;
let leads: LeadsRepo;
let sentCheckins: Array<{ userId: number; text: string }>;
let service: LeadsService;

beforeEach(() => {
  users = new UsersRepo(sql);
  leads = new LeadsRepo(sql);
  sentCheckins = [];
  // Stub: the scheduler only calls sendProactiveCheckin. The real send
  // path (relayToCandidate) is covered by leads-relay tests.
  service = {
    sendProactiveCheckin: async (input: { user: { id: number }; text: string }) => {
      sentCheckins.push({ userId: input.user.id, text: input.text });
    },
  } as unknown as LeadsService;
});

/** Force the epoch a lead entered `state` back by `days` so a check-in is due. */
async function backdateStageEntry(leadId: number, state: string, days: number): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  await sql`
    UPDATE lead_events SET created_at = ${epoch}
    WHERE lead_id = ${leadId} AND to_state = ${state}
  `;
}

async function makeLeadInState(
  tgUserId: number,
  state: "docs_pending" | "submitted",
): Promise<number> {
  const u = await users.create({ tgUserId });
  const l = await leads.ensureForUser(u.id);
  await leads.setState(l.id, "intake_complete");
  await leads.setState(l.id, "approved");
  await leads.setState(l.id, "docs_pending");
  if (state === "submitted") {
    await leads.setState(l.id, "docs_complete");
    await leads.setState(l.id, "submitted");
  }
  return l.id;
}

describe("runProactiveCheckins", () => {
  test("nudges a docs_pending lead that has waited past the interval", async () => {
    const leadId = await makeLeadInState(9001, "docs_pending");
    await backdateStageEntry(leadId, "docs_pending", 5);

    const result = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });

    expect(result.sent).toBe(1);
    expect(sentCheckins.length).toBe(1);
    expect(sentCheckins[0]?.text.length).toBeGreaterThan(0);
    expect((await leads.byId(leadId))?.last_checkin_at).not.toBeNull();
  });

  test("nudges a submitted lead that has waited past the interval", async () => {
    const leadId = await makeLeadInState(9002, "submitted");
    await backdateStageEntry(leadId, "submitted", 6);

    const result = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });

    expect(result.sent).toBe(1);
  });

  test("leaves a freshly-entered waiting lead alone", async () => {
    await makeLeadInState(9003, "docs_pending");

    const result = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });

    expect(result.sent).toBe(0);
    expect(sentCheckins.length).toBe(0);
  });

  test("does not nudge the same lead twice within the interval", async () => {
    const leadId = await makeLeadInState(9004, "docs_pending");
    await backdateStageEntry(leadId, "docs_pending", 5);

    const first = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });
    expect(first.sent).toBe(1);

    // last_checkin_at was just set to now — the next pass sees nothing due.
    const second = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });
    expect(second.sent).toBe(0);
  });

  test("ignores leads that are not in a waiting stage", async () => {
    // intake_pending (created) and an approved (pre-docs) lead.
    const u1 = await users.create({ tgUserId: 9005 });
    await leads.ensureForUser(u1.id);
    const u2 = await users.create({ tgUserId: 9006 });
    const l2 = await leads.ensureForUser(u2.id);
    await leads.setState(l2.id, "intake_complete");
    await leads.setState(l2.id, "approved");

    const result = await runProactiveCheckins({ leads, users, service, intervalDays: 4 });

    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
  });
});
