import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { QuestionnaireTokensRepo } from "@/db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("QuestionnaireTokensRepo", () => {
  test("issue creates a valid token; consume returns the user once", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 11 });

    const token = await tokens.issue(u.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const userId = await tokens.consume(token);
    expect(userId).toBe(u.id);

    expect(await tokens.consume(token)).toBeNull();
  });

  test("expired token cannot be consumed", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 12 });
    const token = await tokens.issue(u.id, { ttlSeconds: -10 });

    expect(await tokens.getValid(token)).toBeNull();
    expect(await tokens.consume(token)).toBeNull();
  });

  test("issuing a new token does not invalidate prior unused token", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 13 });
    const t1 = await tokens.issue(u.id);
    const t2 = await tokens.issue(u.id);
    expect(t1).not.toBe(t2);
    expect((await tokens.getValid(t1))?.user_id).toBe(u.id);
    expect((await tokens.getValid(t2))?.user_id).toBe(u.id);
  });
});
