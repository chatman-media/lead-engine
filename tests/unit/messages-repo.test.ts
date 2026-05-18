// Coverage for the media / context helpers on MessagesRepo.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let convId: number;
let messages: MessagesRepo;

beforeEach(async () => {
  const user = await new UsersRepo(sql).create({ tgUserId: Math.floor(Math.random() * 1e9) });
  convId = (await new ConversationsRepo(sql).ensureForUser(user.id)).id;
  messages = new MessagesRepo(sql);
});

const photoMeta = (fileId: string, cls?: string) => ({
  media: { type: "photo", file_id: fileId, ...(cls ? { photo_class: cls } : {}) },
});

describe("addUserMessageIfNew", () => {
  test("inserts a new inbound message and reports isNew=true", async () => {
    const res = await messages.addUserMessageIfNew({
      conversationId: convId,
      text: "hi",
      tgMessageId: 11,
    });
    expect(res.isNew).toBe(true);
    expect(res.message.text).toBe("hi");
  });

  test("is idempotent on a repeated tg_message_id", async () => {
    await messages.addUserMessageIfNew({ conversationId: convId, text: "hi", tgMessageId: 22 });
    const again = await messages.addUserMessageIfNew({
      conversationId: convId,
      text: "hi again",
      tgMessageId: 22,
    });
    expect(again.isNew).toBe(false);
    expect(again.message.text).toBe("hi"); // original row, not the retry
  });
});

describe("recentForContext", () => {
  test("returns the last N messages oldest-first", async () => {
    for (let i = 0; i < 5; i++) {
      await messages.add({ conversationId: convId, role: "user", text: `m${i}` });
    }
    const recent = await messages.recentForContext(convId, 3);
    expect(recent.map((m) => m.text)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("setMeta", () => {
  test("updates meta_json and returns true", async () => {
    const m = await messages.add({ conversationId: convId, role: "user", text: "x" });
    expect(await messages.setMeta(m.id, { tag: "v" })).toBe(true);
    expect(JSON.parse((await messages.byId(m.id))!.meta_json!)).toEqual({ tag: "v" });
  });

  test("clears meta_json when passed null", async () => {
    const m = await messages.add({
      conversationId: convId,
      role: "user",
      text: "x",
      meta: { a: 1 },
    });
    await messages.setMeta(m.id, null);
    expect((await messages.byId(m.id))!.meta_json).toBeNull();
  });

  test("returns false for an unknown id", async () => {
    expect(await messages.setMeta(999999, { a: 1 })).toBe(false);
  });
});

describe("countMediaForConversation", () => {
  test("counts photos and videos from meta_json, ignoring plain text", async () => {
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("p1"),
    });
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("p2"),
    });
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[video]",
      meta: { media: { type: "video", file_id: "v1" } },
    });
    await messages.add({ conversationId: convId, role: "user", text: "just text" });
    expect(await messages.countMediaForConversation(convId)).toEqual({ photos: 2, videos: 1 });
  });
});

describe("unclassifiedPhotos / setPhotoClass / countPhotosByClass", () => {
  test("lists only photos without a photo_class, then reflects classification", async () => {
    const a = await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("file-a"),
    });
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("file-b", "passport"),
    });

    const pending = await messages.unclassifiedPhotos(convId);
    expect(pending.map((p) => p.file_id)).toEqual(["file-a"]);

    expect(await messages.setPhotoClass(a.id, "full_body")).toBe(true);
    expect(await messages.unclassifiedPhotos(convId)).toHaveLength(0);

    const counts = await messages.countPhotosByClass(convId);
    expect(counts.passport).toBe(1);
    expect(counts.full_body).toBe(1);
    expect(counts.portrait).toBe(0);
  });

  test("setPhotoClass returns false when the message has no meta_json", async () => {
    const plain = await messages.add({ conversationId: convId, role: "user", text: "x" });
    expect(await messages.setPhotoClass(plain.id, "other")).toBe(false);
  });
});

describe("passport extraction repo methods", () => {
  test("needs-extraction list, setPassportFields, fields-for-conversation", async () => {
    // Passport photo awaiting extraction.
    const p = await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: {
        media: {
          type: "photo",
          file_id: "pass-1",
          mime_type: "image/png",
          photo_class: "passport",
        },
      },
    });
    // A non-passport photo — never picked up.
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("full-1", "full_body"),
    });

    let pending = await messages.passportPhotosNeedingExtraction(convId);
    expect(pending.map((x) => x.file_id)).toEqual(["pass-1"]);
    expect(pending[0]!.mime_type).toBe("image/png");

    expect(
      await messages.setPassportFields(p.id, { family_name: "IVANOVA", given_name: "SOFIA" }),
    ).toBe(true);

    // Once extracted, it drops out of the needs-extraction list.
    pending = await messages.passportPhotosNeedingExtraction(convId);
    expect(pending).toHaveLength(0);

    expect(await messages.passportFieldsForConversation(convId)).toEqual({
      family_name: "IVANOVA",
      given_name: "SOFIA",
    });
  });

  test("empty extraction marks the photo done but yields no conversation fields", async () => {
    const p = await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "pass-2", photo_class: "passport" } },
    });
    await messages.setPassportFields(p.id, {});

    // Not retried — empty object is a valid "attempted" marker.
    expect(await messages.passportPhotosNeedingExtraction(convId)).toHaveLength(0);
    // But an empty extraction contributes nothing to the conversation.
    expect(await messages.passportFieldsForConversation(convId)).toBeNull();
  });

  test("passportFieldsForConversation returns null when no passport photo", async () => {
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("file-x", "portrait"),
    });
    expect(await messages.passportFieldsForConversation(convId)).toBeNull();
  });
});

describe("internal passport extraction repo methods", () => {
  test("needs-extraction list, setInternalPassportFields, fields-for-conversation", async () => {
    const p = await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: {
        media: {
          type: "photo",
          file_id: "int-1",
          mime_type: "image/png",
          photo_class: "internal_passport",
        },
      },
    });
    // A загранпаспорт photo — must NOT be picked up by the internal list.
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: photoMeta("pass-1", "passport"),
    });

    let pending = await messages.internalPassportPhotosNeedingExtraction(convId);
    expect(pending.map((x) => x.file_id)).toEqual(["int-1"]);

    expect(
      await messages.setInternalPassportFields(p.id, {
        national_id_number: "12 34 567890",
        date_of_birth: "12.04.1998",
      }),
    ).toBe(true);

    pending = await messages.internalPassportPhotosNeedingExtraction(convId);
    expect(pending).toHaveLength(0);

    expect(await messages.internalPassportFieldsForConversation(convId)).toEqual({
      national_id_number: "12 34 567890",
      date_of_birth: "12.04.1998",
    });
  });

  test("empty extraction marks the photo done but yields no conversation fields", async () => {
    const p = await messages.add({
      conversationId: convId,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "int-2", photo_class: "internal_passport" } },
    });
    await messages.setInternalPassportFields(p.id, {});
    expect(await messages.internalPassportPhotosNeedingExtraction(convId)).toHaveLength(0);
    expect(await messages.internalPassportFieldsForConversation(convId)).toBeNull();
  });
});

describe("mediaForConversation", () => {
  test("returns every media message oldest-first with class + caption", async () => {
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "my passport",
      meta: photoMeta("file-a", "passport"),
    });
    await messages.add({
      conversationId: convId,
      role: "user",
      text: "[video]",
      meta: { media: { type: "video", file_id: "v1" } },
    });
    const media = await messages.mediaForConversation(convId);
    expect(media).toHaveLength(2);
    expect(media[0]!.type).toBe("photo");
    expect(media[0]!.photo_class).toBe("passport");
    expect(media[0]!.caption).toBe("my passport");
    expect(media[1]!.type).toBe("video");
  });
});
