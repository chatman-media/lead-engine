import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { SessionsRepo } from "@/db/repos/sessions.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("AdminsRepo", () => {
  test("create stores email lowercased and a non-empty password hash", async () => {
    const admins = new AdminsRepo(sql);
    const a = await admins.create({
      email: "Operator@Example.com",
      password: "s3cret-pass",
    });
    expect(a.email).toBe("operator@example.com");
    expect(a.id).toBeGreaterThan(0);

    const row = await admins.byEmail("operator@example.com");
    expect(row?.id).toBe(a.id);
    expect(row?.password_hash.length).toBeGreaterThan(0);
    expect(row?.password_hash.includes("s3cret-pass")).toBe(false);
  });

  test("byEmail is case-insensitive", async () => {
    const admins = new AdminsRepo(sql);
    await admins.create({ email: "x@y.test", password: "longenough" });
    expect((await admins.byEmail("X@Y.TEST"))?.email).toBe("x@y.test");
  });

  test("verifyPassword returns admin only for correct password", async () => {
    const admins = new AdminsRepo(sql);
    await admins.create({ email: "a@b.test", password: "right-one" });
    const ok = await admins.verifyPassword("a@b.test", "right-one");
    expect(ok?.email).toBe("a@b.test");
    const nope = await admins.verifyPassword("a@b.test", "wrong");
    expect(nope).toBeNull();
    const missing = await admins.verifyPassword("nobody@x.test", "x");
    expect(missing).toBeNull();
  });

  test("creating with duplicate email throws", async () => {
    const admins = new AdminsRepo(sql);
    await admins.create({ email: "dup@x.test", password: "longenough1" });
    // Avoid expect().rejects.toThrow() on a PG UNIQUE-violation path — the
    // postgres.js pending-query lifecycle hangs on constraint cancel.
    let threw = false;
    try {
      await admins.create({ email: "DUP@x.test", password: "longenough2" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("rejects too-short password", async () => {
    const admins = new AdminsRepo(sql);
    await expect(admins.create({ email: "x@y.test", password: "short" })).rejects.toThrow(
      /password/i,
    );
  });

  test("create defaults role to superadmin", async () => {
    const admins = new AdminsRepo(sql);
    const a = await admins.create({ email: "owner@x.test", password: "longenough" });
    expect(a.role).toBe("superadmin");
  });

  test("create stores an explicit manager role", async () => {
    const admins = new AdminsRepo(sql);
    const a = await admins.create({
      email: "mgr@x.test",
      password: "longenough",
      role: "manager",
    });
    expect(a.role).toBe("manager");
    expect((await admins.byEmail("mgr@x.test"))?.role).toBe("manager");
  });

  test("updatePassword swaps the hash — old fails, new verifies", async () => {
    const admins = new AdminsRepo(sql);
    const a = await admins.create({ email: "pw@x.test", password: "old-password" });
    await admins.updatePassword(a.id, "new-password");
    expect(await admins.verifyPassword("pw@x.test", "old-password")).toBeNull();
    expect((await admins.verifyPassword("pw@x.test", "new-password"))?.id).toBe(a.id);
  });

  test("updatePassword rejects a too-short password", async () => {
    const admins = new AdminsRepo(sql);
    const a = await admins.create({ email: "pw2@x.test", password: "longenough" });
    await expect(admins.updatePassword(a.id, "short")).rejects.toThrow(/password/i);
  });
});

describe("SessionsRepo", () => {
  test("issue returns an opaque id; lookup returns the admin id", async () => {
    const admins = new AdminsRepo(sql);
    const sessions = new SessionsRepo(sql);
    const a = await admins.create({ email: "s@x.test", password: "longenough" });

    const sid = await sessions.issue(a.id);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const adminId = await sessions.adminIdFor(sid);
    expect(adminId).toBe(a.id);
  });

  test("expired sessions are not returned and are deleted on lookup", async () => {
    const admins = new AdminsRepo(sql);
    const sessions = new SessionsRepo(sql);
    const a = await admins.create({ email: "s2@x.test", password: "longenough" });
    const sid = await sessions.issue(a.id, { ttlSeconds: -10 });
    expect(await sessions.adminIdFor(sid)).toBeNull();
    const [{ n }] = await sql<[{ n: string }]>`SELECT COUNT(*) AS n FROM sessions`;
    expect(Number(n)).toBe(0);
  });

  test("revoke removes the session", async () => {
    const admins = new AdminsRepo(sql);
    const sessions = new SessionsRepo(sql);
    const a = await admins.create({ email: "s3@x.test", password: "longenough" });
    const sid = await sessions.issue(a.id);
    await sessions.revoke(sid);
    expect(await sessions.adminIdFor(sid)).toBeNull();
  });

  test("unknown session id returns null", async () => {
    const sessions = new SessionsRepo(sql);
    expect(await sessions.adminIdFor("does-not-exist")).toBeNull();
  });
});
