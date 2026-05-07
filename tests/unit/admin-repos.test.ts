import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { SessionsRepo } from "@/db/repos/sessions.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
});
afterEach(() => db.close());

describe("AdminsRepo", () => {
  test("create stores email lowercased and a non-empty password hash", async () => {
    const admins = new AdminsRepo(db);
    const a = await admins.create({
      email: "Operator@Example.com",
      password: "s3cret-pass",
    });
    expect(a.email).toBe("operator@example.com");
    expect(a.id).toBeGreaterThan(0);

    const row = admins.byEmail("operator@example.com");
    expect(row?.id).toBe(a.id);
    expect(row?.password_hash.length).toBeGreaterThan(0);
    expect(row?.password_hash.includes("s3cret-pass")).toBe(false);
  });

  test("byEmail is case-insensitive", async () => {
    const admins = new AdminsRepo(db);
    await admins.create({ email: "x@y.test", password: "longenough" });
    expect(admins.byEmail("X@Y.TEST")?.email).toBe("x@y.test");
  });

  test("verifyPassword returns admin only for correct password", async () => {
    const admins = new AdminsRepo(db);
    await admins.create({ email: "a@b.test", password: "right-one" });
    const ok = await admins.verifyPassword("a@b.test", "right-one");
    expect(ok?.email).toBe("a@b.test");
    const nope = await admins.verifyPassword("a@b.test", "wrong");
    expect(nope).toBeNull();
    const missing = await admins.verifyPassword("nobody@x.test", "x");
    expect(missing).toBeNull();
  });

  test("creating with duplicate email throws", async () => {
    const admins = new AdminsRepo(db);
    await admins.create({ email: "dup@x.test", password: "longenough1" });
    await expect(admins.create({ email: "DUP@x.test", password: "longenough2" })).rejects.toThrow();
  });

  test("rejects too-short password", async () => {
    const admins = new AdminsRepo(db);
    await expect(admins.create({ email: "x@y.test", password: "short" })).rejects.toThrow(
      /password/i,
    );
  });
});

describe("SessionsRepo", () => {
  test("issue returns an opaque id; lookup returns the admin id", async () => {
    const admins = new AdminsRepo(db);
    const sessions = new SessionsRepo(db);
    const a = await admins.create({ email: "s@x.test", password: "longenough" });

    const sid = sessions.issue(a.id);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const adminId = sessions.adminIdFor(sid);
    expect(adminId).toBe(a.id);
  });

  test("expired sessions are not returned and are deleted on lookup", async () => {
    const admins = new AdminsRepo(db);
    const sessions = new SessionsRepo(db);
    const a = await admins.create({ email: "s2@x.test", password: "longenough" });
    const sid = sessions.issue(a.id, { ttlSeconds: -10 });
    expect(sessions.adminIdFor(sid)).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(0);
  });

  test("revoke removes the session", async () => {
    const admins = new AdminsRepo(db);
    const sessions = new SessionsRepo(db);
    const a = await admins.create({ email: "s3@x.test", password: "longenough" });
    const sid = sessions.issue(a.id);
    sessions.revoke(sid);
    expect(sessions.adminIdFor(sid)).toBeNull();
  });

  test("unknown session id returns null", () => {
    const sessions = new SessionsRepo(db);
    expect(sessions.adminIdFor("does-not-exist")).toBeNull();
  });
});
