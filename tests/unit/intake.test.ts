import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { extractIntake, parseIntakeJson } from "@/leads/intake.ts";
import { isIntakeComplete } from "@/leads/templates.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function fakeChat(reply: string): ChatClient & { calls: number } {
  const wrapper = {
    calls: 0,
    async complete(_messages: ChatMessage[]) {
      wrapper.calls++;
      return reply;
    },
  };
  return wrapper as ChatClient & { calls: number };
}

describe("parseIntakeJson", () => {
  test("parses bare JSON object with all four fields", () => {
    const out = parseIntakeJson(
      '{"height":"165","weight":"52","city":"Москва","departure_readiness":"в любое время"}',
    );
    expect(out).toEqual({
      height: "165",
      weight: "52",
      city: "Москва",
      departure_readiness: "в любое время",
    });
  });

  test("strips think tags and code fences", () => {
    const raw = '<think>...</think>\n```json\n{"city":"Сочи"}\n```';
    expect(parseIntakeJson(raw)).toEqual({ city: "Сочи" });
  });

  test("returns empty object on garbage", () => {
    expect(parseIntakeJson("nope")).toEqual({});
    expect(parseIntakeJson("")).toEqual({});
    expect(parseIntakeJson("{ broken")).toEqual({});
  });

  test("ignores non-string values and oversized strings", () => {
    const out = parseIntakeJson(`{"height":165,"city":"${"x".repeat(200)}","weight":"52"}`);
    expect(out.height).toBeUndefined();
    expect(out.city).toBeUndefined();
    expect(out.weight).toBe("52");
  });
});

describe("countMediaForConversation", () => {
  test("counts photos and videos by media.type, ignores other rows", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const msgs = new MessagesRepo(sql);
    const u = await users.create({ tgUserId: 1 });
    const c = await convs.ensureForUser(u.id);

    await msgs.add({ conversationId: c.id, role: "user", text: "hello" });
    await msgs.add({
      conversationId: c.id,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "a" } },
    });
    await msgs.add({
      conversationId: c.id,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "b" } },
    });
    await msgs.add({
      conversationId: c.id,
      role: "user",
      text: "[video]",
      meta: { media: { type: "video", file_id: "c" } },
    });
    await msgs.add({
      conversationId: c.id,
      role: "user",
      text: "[document]",
      meta: { media: { type: "document", file_id: "d" } },
    });

    const counts = await msgs.countMediaForConversation(c.id);
    expect(counts.photos).toBe(2);
    expect(counts.videos).toBe(1);
  });

  test("scoped per conversation (does not leak across)", async () => {
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const msgs = new MessagesRepo(sql);
    const ua = await users.create({ tgUserId: 10 });
    const ub = await users.create({ tgUserId: 11 });
    const ca = await convs.ensureForUser(ua.id);
    const cb = await convs.ensureForUser(ub.id);
    await msgs.add({
      conversationId: ca.id,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "x" } },
    });
    expect((await msgs.countMediaForConversation(ca.id)).photos).toBe(1);
    expect((await msgs.countMediaForConversation(cb.id)).photos).toBe(0);
  });
});

describe("extractIntake + isIntakeComplete", () => {
  test("merges existing facts with extractor output and media counts", async () => {
    const chat = fakeChat('{"height":"165","weight":"52"}');
    const intake = await extractIntake({
      messages: [{ role: "user", content: "165 рост, 52 вес" }],
      mediaCounts: { photos: 8, videos: 3 },
      chat,
      existingIntake: { city: "Москва" },
    });
    // Text fields from LLM
    expect(intake.height).toBe("165");
    expect(intake.weight).toBe("52");
    // Existing field preserved
    expect(intake.city).toBe("Москва");
    // Media counts overwrite existing (authoritative SQL)
    expect(intake.photos_count).toBe(8);
    expect(intake.videos_count).toBe(3);
    // Threshold-driven flags
    expect(intake.passport_photo_received).toBe(true);
    expect(intake.dance_video_received).toBe(true);
  });

  test("does not flip threshold flags below the cutoff", async () => {
    const chat = fakeChat("{}");
    const intake = await extractIntake({
      messages: [{ role: "user", content: "hello" }],
      mediaCounts: { photos: 5, videos: 1 },
      chat,
    });
    expect(intake.photos_count).toBe(5);
    expect(intake.videos_count).toBe(1);
    expect(intake.passport_photo_received).toBeUndefined();
    expect(intake.dance_video_received).toBeUndefined();
  });

  test("skips LLM call when there are no user messages", async () => {
    const chat = fakeChat('{"city":"x"}');
    const intake = await extractIntake({
      messages: [{ role: "assistant", content: "hi" }],
      mediaCounts: { photos: 0, videos: 0 },
      chat,
    });
    expect(chat.calls).toBe(0);
    expect(intake.city).toBeUndefined();
  });

  test("isIntakeComplete only fires when all 7 items present + thresholds met", () => {
    expect(isIntakeComplete(undefined)).toBe(false);
    expect(
      isIntakeComplete({
        height: "165",
        weight: "52",
        city: "Москва",
        departure_readiness: "в любое время",
        photos_count: 7,
        videos_count: 3,
        passport_photo_received: true,
        dance_video_received: true,
      }),
    ).toBe(true);
    // One field missing
    expect(
      isIntakeComplete({
        height: "165",
        weight: "52",
        city: "Москва",
        departure_readiness: "в любое время",
        photos_count: 7,
        videos_count: 3,
        passport_photo_received: false,
        dance_video_received: true,
      }),
    ).toBe(false);
    // Photos below threshold
    expect(
      isIntakeComplete({
        height: "165",
        weight: "52",
        city: "Москва",
        departure_readiness: "в любое время",
        photos_count: 5,
        videos_count: 3,
        passport_photo_received: true,
        dance_video_received: true,
      }),
    ).toBe(false);
  });
});
