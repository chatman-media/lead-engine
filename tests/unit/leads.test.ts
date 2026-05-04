import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;
let users: UsersRepo;
let leads: LeadsRepo;
let adminId: number;

beforeEach(async () => {
  db = openDb({ path: ":memory:" });
  users = new UsersRepo(db);
  leads = new LeadsRepo(db);
  // Create one admin so the decided_by_admin_id FK can be exercised in tests.
  const admins = new AdminsRepo(db);
  const admin = await admins.create({ email: "op@x.test", password: "longenough" });
  adminId = admin.id;
});
afterEach(() => db.close());

describe("LeadsRepo", () => {
  test("ensureForUser is idempotent and starts at intake_pending", () => {
    const u = users.create({ tgUserId: 100 });
    const a = leads.ensureForUser(u.id);
    const b = leads.ensureForUser(u.id);
    expect(a.id).toBe(b.id);
    expect(a.state).toBe("intake_pending");
  });

  test("setState records adminId/decided_at on approve and reject", () => {
    const u = users.create({ tgUserId: 101 });
    const lead = leads.ensureForUser(u.id);
    const approved = leads.setState(lead.id, "approved", { adminId });
    expect(approved?.state).toBe("approved");
    expect(approved?.decided_by_admin_id).toBe(adminId);
    expect(approved?.decided_at).toBeGreaterThan(0);
  });

  test("setState records rejected_reason only on reject", () => {
    const u = users.create({ tgUserId: 102 });
    const lead = leads.ensureForUser(u.id);
    const rejected = leads.setState(lead.id, "rejected", {
      adminId,
      rejectedReason: "non-fit profile",
    });
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.rejected_reason).toBe("non-fit profile");

    const u2 = users.create({ tgUserId: 103 });
    const lead2 = leads.ensureForUser(u2.id);
    const approved = leads.setState(lead2.id, "approved", {
      adminId,
      rejectedReason: "should be ignored",
    });
    // approve never carries rejected_reason
    expect(approved?.rejected_reason).toBeNull();
  });

  test("allocateApplicationId is sequential and idempotent per lead", () => {
    const ua = users.create({ tgUserId: 200 });
    const ub = users.create({ tgUserId: 201 });
    const a = leads.ensureForUser(ua.id);
    const b = leads.ensureForUser(ub.id);

    const idA1 = leads.allocateApplicationId(a.id);
    const idA2 = leads.allocateApplicationId(a.id); // same lead → same id
    expect(idA1).toBe(idA2);

    const year = new Date().getFullYear();
    expect(idA1.startsWith(`VS-${year}-`)).toBe(true);

    const idB = leads.allocateApplicationId(b.id);
    expect(idB).not.toBe(idA1);
    // Sequential: numeric tail strictly increases
    const seqA = parseInt(idA1.split("-")[2]!, 10);
    const seqB = parseInt(idB.split("-")[2]!, 10);
    expect(seqB).toBe(seqA + 1);
  });

  test("setOpsCardMessage stores ops chat + message ids", () => {
    const u = users.create({ tgUserId: 300 });
    const lead = leads.ensureForUser(u.id);
    leads.setOpsCardMessage(lead.id, -100123, 555);
    const after = leads.byId(lead.id);
    expect(after?.ops_chat_id).toBe(-100123);
    expect(after?.ops_message_id).toBe(555);
  });

  test("byOpsMessage round-trips and returns null on miss", () => {
    const u = users.create({ tgUserId: 301 });
    const lead = leads.ensureForUser(u.id);
    leads.setOpsCardMessage(lead.id, -100456, 777);
    const found = leads.byOpsMessage(-100456, 777);
    expect(found?.id).toBe(lead.id);
    expect(leads.byOpsMessage(-100456, 999)).toBeNull();
    expect(leads.byOpsMessage(-100999, 777)).toBeNull();
  });

  test("countByState returns zero baseline + observed counts", () => {
    const u1 = users.create({ tgUserId: 400 });
    const u2 = users.create({ tgUserId: 401 });
    const u3 = users.create({ tgUserId: 402 });
    const l1 = leads.ensureForUser(u1.id);
    const l2 = leads.ensureForUser(u2.id);
    const l3 = leads.ensureForUser(u3.id);
    leads.setState(l2.id, "intake_complete");
    leads.setState(l3.id, "rejected", { adminId });
    const counts = leads.countByState();
    expect(counts.intake_pending).toBe(1);
    expect(counts.intake_complete).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.approved).toBe(0);
    void l1;
  });

  test("list orders intake_complete + docs_complete to the top", () => {
    const make = (tg: number, state: Parameters<typeof leads.setState>[1]) => {
      const u = users.create({ tgUserId: tg });
      const l = leads.ensureForUser(u.id);
      if (state !== "intake_pending") leads.setState(l.id, state);
      return l.id;
    };
    const intakePending = make(500, "intake_pending");
    const ready = make(501, "intake_complete");
    const docsReady = make(502, "docs_complete");
    const submitted = make(503, "submitted");
    const order = leads.list().map((l) => l.id);
    expect(order[0]).toBe(ready);
    expect(order[1]).toBe(docsReady);
    // intake_pending and submitted come after the high-priority states
    expect(order.indexOf(intakePending)).toBeGreaterThan(1);
    expect(order.indexOf(submitted)).toBeGreaterThan(1);
  });

  test("user_id UNIQUE: only one open lead per user", () => {
    const u = users.create({ tgUserId: 600 });
    leads.ensureForUser(u.id);
    expect(() => {
      db.run(`INSERT INTO leads (user_id) VALUES (?)`, [u.id]);
    }).toThrow();
  });

  test("delete removes the row", () => {
    const u = users.create({ tgUserId: 700 });
    const l = leads.ensureForUser(u.id);
    expect(leads.delete(l.id)).toBe(true);
    expect(leads.byId(l.id)).toBeNull();
  });

  test("ensureForUser writes a synthetic 'created' event", () => {
    const u = users.create({ tgUserId: 800 });
    const l = leads.ensureForUser(u.id);
    const evs = leads.events(l.id);
    expect(evs.length).toBe(1);
    expect(evs[0]!.from_state).toBeNull();
    expect(evs[0]!.to_state).toBe("intake_pending");
    expect(evs[0]!.by_admin_id).toBeNull();
  });

  test("setState appends a transition event with admin + notes", () => {
    const u = users.create({ tgUserId: 801 });
    const l = leads.ensureForUser(u.id);
    leads.setState(l.id, "intake_complete");
    leads.setState(l.id, "rejected", {
      adminId,
      rejectedReason: "не подходит",
    });
    const evs = leads.events(l.id);
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

  test("setState skips event when state is unchanged (no-op transitions)", () => {
    const u = users.create({ tgUserId: 802 });
    const l = leads.ensureForUser(u.id);
    leads.setState(l.id, "intake_pending"); // same as current
    const evs = leads.events(l.id);
    expect(evs.length).toBe(1); // only the synthetic 'created'
  });

  test("allocateApplicationId emits a self-loop event with the id in notes", () => {
    const u = users.create({ tgUserId: 803 });
    const l = leads.ensureForUser(u.id);
    leads.setState(l.id, "intake_complete");
    leads.setState(l.id, "approved", { adminId });
    const appId = leads.allocateApplicationId(l.id);

    const evs = leads.events(l.id);
    const idEv = evs.find((e) => e.notes?.startsWith("application_id="));
    expect(idEv).toBeDefined();
    expect(idEv!.notes).toBe(`application_id=${appId}`);
    // self-loop: from === to (state didn't change just because of allocation)
    expect(idEv!.from_state).toBe(idEv!.to_state);
  });

  test("allocateApplicationId is still idempotent — second call doesn't double-log", () => {
    const u = users.create({ tgUserId: 804 });
    const l = leads.ensureForUser(u.id);
    leads.allocateApplicationId(l.id);
    const eventsAfterFirst = leads.events(l.id).length;
    leads.allocateApplicationId(l.id); // should be no-op
    const eventsAfterSecond = leads.events(l.id).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });

  test("delete cascades — events for a deleted lead disappear", () => {
    const u = users.create({ tgUserId: 805 });
    const l = leads.ensureForUser(u.id);
    leads.setState(l.id, "intake_complete");
    expect(leads.events(l.id).length).toBe(2);
    leads.delete(l.id);
    expect(leads.events(l.id).length).toBe(0);
  });
});
