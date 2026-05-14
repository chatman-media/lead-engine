import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let users: UsersRepo;
let leads: LeadsRepo;
let adminId: number;

beforeEach(async () => {
  users = new UsersRepo(sql);
  leads = new LeadsRepo(sql);
  // Create one admin so the decided_by_admin_id FK can be exercised in tests.
  const admins = new AdminsRepo(sql);
  const admin = await admins.create({ email: "op@x.test", password: "longenough" });
  adminId = admin.id;
});

describe("LeadsRepo", () => {
  test("ensureForUser is idempotent and starts at intake_pending", async () => {
    const u = await users.create({ tgUserId: 100 });
    const a = await leads.ensureForUser(u.id);
    const b = await leads.ensureForUser(u.id);
    expect(a.id).toBe(b.id);
    expect(a.state).toBe("intake_pending");
  });

  test("setState records adminId/decided_at on approve and reject", async () => {
    const u = await users.create({ tgUserId: 101 });
    const lead = await leads.ensureForUser(u.id);
    const approved = await leads.setState(lead.id, "approved", { adminId });
    expect(approved?.state).toBe("approved");
    expect(approved?.decided_by_admin_id).toBe(adminId);
    expect(approved?.decided_at).toBeGreaterThan(0);
  });

  test("setState records rejected_reason only on reject", async () => {
    const u = await users.create({ tgUserId: 102 });
    const lead = await leads.ensureForUser(u.id);
    const rejected = await leads.setState(lead.id, "rejected", {
      adminId,
      rejectedReason: "non-fit profile",
    });
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.rejected_reason).toBe("non-fit profile");

    const u2 = await users.create({ tgUserId: 103 });
    const lead2 = await leads.ensureForUser(u2.id);
    const approved = await leads.setState(lead2.id, "approved", {
      adminId,
      rejectedReason: "should be ignored",
    });
    // approve never carries rejected_reason
    expect(approved?.rejected_reason).toBeNull();
  });

  test("allocateApplicationId is sequential and idempotent per lead", async () => {
    const ua = await users.create({ tgUserId: 200 });
    const ub = await users.create({ tgUserId: 201 });
    const a = await leads.ensureForUser(ua.id);
    const b = await leads.ensureForUser(ub.id);

    const idA1 = await leads.allocateApplicationId(a.id);
    const idA2 = await leads.allocateApplicationId(a.id); // same lead → same id
    expect(idA1).toBe(idA2);

    const year = new Date().getFullYear();
    expect(idA1.startsWith(`VS-${year}-`)).toBe(true);

    const idB = await leads.allocateApplicationId(b.id);
    expect(idB).not.toBe(idA1);
    // Sequential: numeric tail strictly increases
    const seqA = parseInt(idA1.split("-")[2]!, 10);
    const seqB = parseInt(idB.split("-")[2]!, 10);
    expect(seqB).toBe(seqA + 1);
  });

  test("setOpsCardMessage stores ops chat + message ids", async () => {
    const u = await users.create({ tgUserId: 300 });
    const lead = await leads.ensureForUser(u.id);
    await leads.setOpsCardMessage(lead.id, -100123, 555);
    const after = await leads.byId(lead.id);
    expect(after?.ops_chat_id).toBe(-100123);
    expect(after?.ops_message_id).toBe(555);
  });

  test("byOpsMessage round-trips and returns null on miss", async () => {
    const u = await users.create({ tgUserId: 301 });
    const lead = await leads.ensureForUser(u.id);
    await leads.setOpsCardMessage(lead.id, -100456, 777);
    const found = await leads.byOpsMessage(-100456, 777);
    expect(found?.id).toBe(lead.id);
    expect(await leads.byOpsMessage(-100456, 999)).toBeNull();
    expect(await leads.byOpsMessage(-100999, 777)).toBeNull();
  });

  test("countByState returns zero baseline + observed counts", async () => {
    const u1 = await users.create({ tgUserId: 400 });
    const u2 = await users.create({ tgUserId: 401 });
    const u3 = await users.create({ tgUserId: 402 });
    const l1 = await leads.ensureForUser(u1.id);
    const l2 = await leads.ensureForUser(u2.id);
    const l3 = await leads.ensureForUser(u3.id);
    await leads.setState(l2.id, "intake_complete");
    await leads.setState(l3.id, "rejected", { adminId });
    const counts = await leads.countByState();
    expect(counts.intake_pending).toBe(1);
    expect(counts.intake_complete).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.approved).toBe(0);
    void l1;
  });

  test("list orders intake_complete + docs_complete to the top", async () => {
    const make = async (tg: number, state: Parameters<typeof leads.setState>[1]) => {
      const u = await users.create({ tgUserId: tg });
      const l = await leads.ensureForUser(u.id);
      if (state !== "intake_pending") await leads.setState(l.id, state);
      return l.id;
    };
    const intakePending = await make(500, "intake_pending");
    const ready = await make(501, "intake_complete");
    const docsReady = await make(502, "docs_complete");
    const submitted = await make(503, "submitted");
    const order = (await leads.list()).map((l) => l.id);
    expect(order[0]).toBe(ready);
    expect(order[1]).toBe(docsReady);
    // intake_pending and submitted come after the high-priority states
    expect(order.indexOf(intakePending)).toBeGreaterThan(1);
    expect(order.indexOf(submitted)).toBeGreaterThan(1);
  });

  test("user_id UNIQUE: only one open lead per user", async () => {
    const u = await users.create({ tgUserId: 600 });
    await leads.ensureForUser(u.id);
    // postgres.js tagged templates are lazy thenables — drive them explicitly
    // through try/catch instead of expect().rejects.toThrow(), which has a
    // known hang interaction with the pending-query lifecycle on constraint
    // violations.
    let threw = false;
    try {
      await sql`INSERT INTO leads (user_id) VALUES (${u.id})`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("delete removes the row", async () => {
    const u = await users.create({ tgUserId: 700 });
    const l = await leads.ensureForUser(u.id);
    expect(await leads.delete(l.id)).toBe(true);
    expect(await leads.byId(l.id)).toBeNull();
  });

  test("ensureForUser writes a synthetic 'created' event", async () => {
    const u = await users.create({ tgUserId: 800 });
    const l = await leads.ensureForUser(u.id);
    const evs = await leads.events(l.id);
    expect(evs.length).toBe(1);
    expect(evs[0]!.from_state).toBeNull();
    expect(evs[0]!.to_state).toBe("intake_pending");
    expect(evs[0]!.by_admin_id).toBeNull();
  });

  test("setState appends a transition event with admin + notes", async () => {
    const u = await users.create({ tgUserId: 801 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    await leads.setState(l.id, "rejected", {
      adminId,
      rejectedReason: "не подходит",
    });
    const evs = await leads.events(l.id);
    expect(evs.length).toBe(3); // created + 2 transitions
    expect(evs[1]!.from_state).toBe("intake_pending");
    expect(evs[1]!.to_state).toBe("intake_complete");
    expect(evs[1]!.by_admin_id).toBeNull();
    expect(evs[1]!.notes).toBeNull();

    expect(evs[2]!.from_state).toBe("intake_complete");
    expect(evs[2]!.to_state).toBe("rejected");
    expect(evs[2]!.by_admin_id).toBe(adminId);
    expect(evs[2]!.notes).toBe("не подходит");
  });

  test("setState skips event when state is unchanged (no-op transitions)", async () => {
    const u = await users.create({ tgUserId: 802 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_pending"); // same as current
    const evs = await leads.events(l.id);
    expect(evs.length).toBe(1); // only the synthetic 'created'
  });

  test("allocateApplicationId emits a self-loop event with the id in notes", async () => {
    const u = await users.create({ tgUserId: 803 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    await leads.setState(l.id, "approved", { adminId });
    const appId = await leads.allocateApplicationId(l.id);

    const evs = await leads.events(l.id);
    const idEv = evs.find((e) => e.notes?.startsWith("application_id="));
    expect(idEv).toBeDefined();
    expect(idEv!.notes).toBe(`application_id=${appId}`);
    // self-loop: from === to (state didn't change just because of allocation)
    expect(idEv!.from_state).toBe(idEv!.to_state);
  });

  test("allocateApplicationId is still idempotent — second call doesn't double-log", async () => {
    const u = await users.create({ tgUserId: 804 });
    const l = await leads.ensureForUser(u.id);
    await leads.allocateApplicationId(l.id);
    const eventsAfterFirst = (await leads.events(l.id)).length;
    await leads.allocateApplicationId(l.id); // should be no-op
    const eventsAfterSecond = (await leads.events(l.id)).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });

  test("delete cascades — events for a deleted lead disappear", async () => {
    const u = await users.create({ tgUserId: 805 });
    const l = await leads.ensureForUser(u.id);
    await leads.setState(l.id, "intake_complete");
    expect((await leads.events(l.id)).length).toBe(2);
    await leads.delete(l.id);
    expect((await leads.events(l.id)).length).toBe(0);
  });

  test("addNote / notes round-trip, ordered freshest first", async () => {
    const u = await users.create({ tgUserId: 900 });
    const l = await leads.ensureForUser(u.id);
    await leads.addNote({ leadId: l.id, body: "first", byAdminId: adminId });
    await new Promise((r) => setTimeout(r, 1100)); // unixepoch is integer-second
    await leads.addNote({ leadId: l.id, body: "second", byAdminId: adminId });
    const list = await leads.notes(l.id);
    expect(list.map((n) => n.body)).toEqual(["second", "first"]);
    expect(list[0]!.by_admin_id).toBe(adminId);
  });

  test("addNote rejects whitespace-only body", async () => {
    const u = await users.create({ tgUserId: 901 });
    const l = await leads.ensureForUser(u.id);
    await expect(leads.addNote({ leadId: l.id, body: "   " })).rejects.toThrow();
    expect((await leads.notes(l.id)).length).toBe(0);
  });

  test("addNote trims whitespace edges of body", async () => {
    const u = await users.create({ tgUserId: 902 });
    const l = await leads.ensureForUser(u.id);
    await leads.addNote({ leadId: l.id, body: "  trim me  " });
    expect((await leads.notes(l.id))[0]!.body).toBe("trim me");
  });

  test("deleteNote removes the row, returns false on missing id", async () => {
    const u = await users.create({ tgUserId: 903 });
    const l = await leads.ensureForUser(u.id);
    const note = await leads.addNote({ leadId: l.id, body: "kill me" });
    expect(await leads.deleteNote(note.id)).toBe(true);
    expect((await leads.notes(l.id)).length).toBe(0);
    expect(await leads.deleteNote(note.id)).toBe(false);
  });

  test("delete cascades — notes for a deleted lead disappear", async () => {
    const u = await users.create({ tgUserId: 904 });
    const l = await leads.ensureForUser(u.id);
    await leads.addNote({ leadId: l.id, body: "n1" });
    await leads.addNote({ leadId: l.id, body: "n2" });
    await leads.delete(l.id);
    expect((await leads.notes(l.id)).length).toBe(0);
  });
});
