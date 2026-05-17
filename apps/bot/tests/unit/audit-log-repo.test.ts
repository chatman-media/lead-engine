import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { AuditLogRepo } from "@/db/repos/audit-log.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("AuditLogRepo.write", () => {
  test("persists a row with all fields populated", async () => {
    const repo = new AuditLogRepo(sql);
    const row = await repo.write({
      action: "kb.wipe",
      adminId: null,
      targetKind: "kb",
      targetId: 42,
      details: { deleted: 3 },
    });
    expect(row.action).toBe("kb.wipe");
    expect(row.target_kind).toBe("kb");
    // targetId is coerced to TEXT.
    expect(row.target_id).toBe("42");
    expect(JSON.parse(row.details_json!)).toEqual({ deleted: 3 });
    expect(row.id).toBeGreaterThan(0);
  });

  test("leaves target/details null when omitted", async () => {
    const repo = new AuditLogRepo(sql);
    const row = await repo.write({ action: "global.action", adminId: null });
    expect(row.target_kind).toBeNull();
    expect(row.target_id).toBeNull();
    expect(row.details_json).toBeNull();
  });

  test("accepts an explicit null targetId", async () => {
    const repo = new AuditLogRepo(sql);
    const row = await repo.write({ action: "x", adminId: null, targetId: null });
    expect(row.target_id).toBeNull();
  });
});

describe("AuditLogRepo.list", () => {
  // admin_id carries a FK to admins.id, so seed real admin rows first.
  async function seed() {
    const admins = new AdminsRepo(sql);
    const a1 = (await admins.create({ email: "a1@x.test", password: "longenough" })).id;
    const a2 = (await admins.create({ email: "a2@x.test", password: "longenough" })).id;
    const repo = new AuditLogRepo(sql);
    await repo.write({ action: "kb.wipe", adminId: a1 });
    await repo.write({ action: "kb.wipe", adminId: a2 });
    await repo.write({ action: "lead.delete", adminId: a1 });
    return { repo, a1, a2 };
  }

  test("returns every row when no filter is given", async () => {
    const { repo } = await seed();
    expect(await repo.list()).toHaveLength(3);
  });

  test("filters by action", async () => {
    const { repo } = await seed();
    const rows = await repo.list({ action: "kb.wipe" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "kb.wipe")).toBe(true);
  });

  test("filters by adminId", async () => {
    const { repo, a1 } = await seed();
    const rows = await repo.list({ adminId: a1 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.admin_id === a1)).toBe(true);
  });

  test("filters by action and adminId together", async () => {
    const { repo, a1 } = await seed();
    const rows = await repo.list({ action: "kb.wipe", adminId: a1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("kb.wipe");
    expect(rows[0]!.admin_id).toBe(a1);
  });

  test("clamps the limit into the 1..1000 range", async () => {
    const { repo } = await seed();
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
    // An absurd limit is clamped, not rejected.
    expect((await repo.list({ limit: 99999 })).length).toBe(3);
  });
});
