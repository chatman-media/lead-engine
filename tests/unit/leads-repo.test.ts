// Coverage for the event / note / media-ack / application-id helpers
// on LeadsRepo.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let leads: LeadsRepo;
let leadId: number;

beforeEach(async () => {
  leads = new LeadsRepo(sql);
  const user = await new UsersRepo(sql).create({ tgUserId: Math.floor(Math.random() * 1e9) });
  leadId = (await leads.ensureForUser(user.id)).id;
});

describe("ensureForUser", () => {
  test("is idempotent — second call returns the same lead", async () => {
    const lead = await leads.byId(leadId);
    const again = await leads.ensureForUser(lead!.user_id);
    expect(again.id).toBe(leadId);
  });
});

describe("appendEvent / events", () => {
  test("records transitions oldest-first", async () => {
    await leads.appendEvent(leadId, {
      fromState: "intake_pending",
      toState: "intake_complete",
      byAdminId: null,
      notes: "auto",
    });
    await leads.appendEvent(leadId, {
      fromState: "intake_complete",
      toState: "approved",
      byAdminId: null,
      notes: null,
    });
    // ensureForUser already logged a creation event (→ intake_pending).
    const events = await leads.events(leadId);
    expect(events.map((e) => e.to_state)).toEqual([
      "intake_pending",
      "intake_complete",
      "approved",
    ]);
  });
});

describe("notes", () => {
  test("add / list (newest-first) / delete", async () => {
    const a = await leads.addNote({ leadId, body: "  first  " });
    await leads.addNote({ leadId, body: "second" });
    expect(a.body).toBe("first"); // trimmed
    const list = await leads.notes(leadId);
    expect(list.map((n) => n.body)).toEqual(["second", "first"]);
    expect(await leads.deleteNote(a.id)).toBe(true);
    expect(await leads.notes(leadId)).toHaveLength(1);
    expect(await leads.deleteNote(a.id)).toBe(false); // already gone
  });

  test("addNote rejects an empty body", async () => {
    expect(leads.addNote({ leadId, body: "   " })).rejects.toThrow();
  });

  test("upsertAutoFactsNote replaces the previous auto note", async () => {
    await leads.upsertAutoFactsNote(leadId, "facts v1");
    await leads.upsertAutoFactsNote(leadId, "facts v2");
    const list = await leads.notes(leadId);
    const auto = list.filter((n) => n.body.startsWith("facts"));
    expect(auto).toHaveLength(1);
    expect(auto[0]!.body).toBe("facts v2");
  });
});

describe("claimMediaAck", () => {
  test("returns true once per key, then false (one-shot dedup)", async () => {
    expect(await leads.claimMediaAck(leadId, "passport")).toBe(true);
    expect(await leads.claimMediaAck(leadId, "passport")).toBe(false);
    // a different key is independent
    expect(await leads.claimMediaAck(leadId, "full_body_nudged")).toBe(true);
  });
});

describe("ops card message", () => {
  test("setOpsCardMessage makes the lead findable via byOpsMessage", async () => {
    await leads.setOpsCardMessage(leadId, -100123, 555);
    const found = await leads.byOpsMessage(-100123, 555);
    expect(found?.id).toBe(leadId);
    expect(await leads.byOpsMessage(-100123, 999)).toBeNull();
  });
});

describe("allocateApplicationId", () => {
  test("allocates a VS-YYYY-NNNN id and is idempotent", async () => {
    const id1 = await leads.allocateApplicationId(leadId);
    expect(id1).toMatch(/^VS-\d{4}-\d{4}$/);
    const id2 = await leads.allocateApplicationId(leadId);
    expect(id2).toBe(id1); // already allocated → same id
  });
});

describe("countByState", () => {
  test("returns a count map covering every lead state", async () => {
    const counts = await leads.countByState();
    expect(counts.intake_pending).toBe(1);
    expect(counts.approved).toBe(0);
    expect(typeof counts.closed).toBe("number");
  });
});
