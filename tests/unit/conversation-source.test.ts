// Conversations are split by `source` so test traffic via the BotAPI bot
// never collides with the real funnel via the userbot. A candidate writing
// to both channels (same tg_user_id → same users row) gets two independent
// conversation rows. `byUserId` prefers the userbot (real funnel) row.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("ConversationsRepo — source split", () => {
  test("ensureForUser yields one row per (user, source)", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 5001, tgUsername: "dual" });

    const bot = await convs.ensureForUser(u.id, "bot");
    const userbot = await convs.ensureForUser(u.id, "userbot");

    // Two distinct conversations for the same candidate.
    expect(bot.id).not.toBe(userbot.id);
    expect(bot.source).toBe("bot");
    expect(userbot.source).toBe("userbot");

    // Idempotent: re-ensure returns the same row, doesn't create a third.
    const botAgain = await convs.ensureForUser(u.id, "bot");
    expect(botAgain.id).toBe(bot.id);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM conversations WHERE user_id = ${u.id}
    `;
    expect(n).toBe(2);
  });

  test("ensureForUser defaults to the bot channel when source omitted", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 5002, tgUsername: "x" });

    // No source arg → bot (back-compat with pre-split callers).
    const c = await convs.ensureForUser(u.id);
    expect(c.source).toBe("bot");
  });

  test("byUserId prefers the userbot (real funnel) row over bot", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 5003, tgUsername: "x" });

    // Only a bot conversation exists → byUserId resolves it.
    const bot = await convs.ensureForUser(u.id, "bot");
    expect((await convs.byUserId(u.id))?.id).toBe(bot.id);

    // Add the userbot conversation → byUserId now prefers the real funnel.
    const userbot = await convs.ensureForUser(u.id, "userbot");
    expect((await convs.byUserId(u.id))?.id).toBe(userbot.id);
  });

  test("byUserId returns null when the user has no conversation", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 5004, tgUsername: "x" });
    expect(await convs.byUserId(u.id)).toBeNull();
  });

  test("stage / mode on one channel don't leak to the other", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 5005, tgUsername: "x" });
    const bot = await convs.ensureForUser(u.id, "bot");
    const userbot = await convs.ensureForUser(u.id, "userbot");

    // Advance the bot (test) conversation to a late stage + human mode.
    await convs.setCurrentStage(bot.id, "close");
    await convs.setMode(bot.id, "human", null);

    // The userbot (real) conversation is untouched — fresh stage, ai mode.
    const realConv = (await convs.byId(userbot.id))!;
    expect(realConv.id).toBe(userbot.id);
    expect(realConv.current_stage).toBeNull();
    expect(realConv.mode).toBe("ai");
  });

  test("list({ source }) filters by channel; unfiltered returns both", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u1 = await users.create({ tgUserId: 5006, tgUsername: "a" });
    const u2 = await users.create({ tgUserId: 5007, tgUsername: "b" });
    await convs.ensureForUser(u1.id, "bot");
    await convs.ensureForUser(u1.id, "userbot");
    await convs.ensureForUser(u2.id, "userbot");

    const all = await convs.list();
    expect(all.length).toBe(3);

    const onlyUserbot = await convs.list({ source: "userbot" });
    expect(onlyUserbot.length).toBe(2);
    expect(onlyUserbot.every((c) => c.source === "userbot")).toBe(true);

    const onlyBot = await convs.list({ source: "bot" });
    expect(onlyBot.length).toBe(1);
    expect(onlyBot[0]?.source).toBe("bot");
  });
});
