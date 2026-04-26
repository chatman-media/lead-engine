import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { QuestionnaireTokensRepo } from "@/db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
});
afterEach(() => db.close());

describe("QuestionnaireTokensRepo", () => {
  test("issue creates a valid token; consume returns the user once", () => {
    const users = new UsersRepo(db);
    const tokens = new QuestionnaireTokensRepo(db);
    const u = users.create({ tgUserId: 11 });

    const token = tokens.issue(u.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const userId = tokens.consume(token);
    expect(userId).toBe(u.id);

    expect(tokens.consume(token)).toBeNull();
  });

  test("expired token cannot be consumed", () => {
    const users = new UsersRepo(db);
    const tokens = new QuestionnaireTokensRepo(db);
    const u = users.create({ tgUserId: 12 });
    const token = tokens.issue(u.id, { ttlSeconds: -10 });

    expect(tokens.getValid(token)).toBeNull();
    expect(tokens.consume(token)).toBeNull();
  });

  test("issuing a new token does not invalidate prior unused token", () => {
    const users = new UsersRepo(db);
    const tokens = new QuestionnaireTokensRepo(db);
    const u = users.create({ tgUserId: 13 });
    const t1 = tokens.issue(u.id);
    const t2 = tokens.issue(u.id);
    expect(t1).not.toBe(t2);
    expect(tokens.getValid(t1)?.user_id).toBe(u.id);
    expect(tokens.getValid(t2)?.user_id).toBe(u.id);
  });
});
