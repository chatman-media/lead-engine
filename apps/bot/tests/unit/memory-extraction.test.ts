import { describe, expect, test } from "bun:test";

import type { MessageRole, MessageRow } from "@/db/repos/messages.ts";
import {
  MAX_EXTRACTION_SLICE,
  renderAutoFactsNote,
  selectFreshMessages,
  sliceForExtraction,
} from "@/telegram/memory-extraction.ts";

const mkMsg = (id: number, role: MessageRole, text = `m${id}`): MessageRow => ({
  id,
  conversation_id: 1,
  role,
  text,
  tg_message_id: null,
  meta_json: null,
  created_at: 0,
  stage: null,
});

describe("selectFreshMessages", () => {
  test("keeps only user/assistant turns newer than the cursor", () => {
    const all = [
      mkMsg(1, "user"),
      mkMsg(2, "assistant"),
      mkMsg(3, "system"),
      mkMsg(4, "human"),
      mkMsg(5, "user"),
    ];
    expect(selectFreshMessages(all, 2).map((m) => m.id)).toEqual([5]);
  });

  test("a zero cursor keeps every user/assistant message", () => {
    const all = [mkMsg(1, "user"), mkMsg(2, "system"), mkMsg(3, "assistant")];
    expect(selectFreshMessages(all, 0).map((m) => m.id)).toEqual([1, 3]);
  });

  test("returns [] when nothing is newer than the cursor", () => {
    expect(selectFreshMessages([mkMsg(1, "user")], 5)).toEqual([]);
  });
});

describe("sliceForExtraction", () => {
  test("returns null for an empty fresh list", () => {
    expect(sliceForExtraction([])).toBeNull();
  });

  test("maps roles to ChatMessage shape and reports the last id", () => {
    const res = sliceForExtraction([mkMsg(7, "user", "hi"), mkMsg(8, "assistant", "yo")]);
    expect(res).not.toBeNull();
    expect(res!.slice).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(res!.lastId).toBe(8);
  });

  test("trims to the most recent `max` turns but keeps lastId at the raw tail", () => {
    const fresh = Array.from({ length: 20 }, (_, i) => mkMsg(i + 1, "user"));
    const res = sliceForExtraction(fresh)!;
    expect(res.slice).toHaveLength(MAX_EXTRACTION_SLICE);
    // first kept message is the (20 - 16 + 1) = 5th
    expect(res.slice[0]!.content).toBe("m5");
    // cursor still advances to the newest raw id, so trimmed-off ids 1..4
    // are not reconsidered next turn
    expect(res.lastId).toBe(20);
  });

  test("respects a custom max", () => {
    const fresh = [mkMsg(1, "user"), mkMsg(2, "user"), mkMsg(3, "user")];
    const res = sliceForExtraction(fresh, 2)!;
    expect(res.slice.map((m) => m.content)).toEqual(["m2", "m3"]);
    expect(res.lastId).toBe(3);
  });
});

describe("renderAutoFactsNote", () => {
  test("renders a bullet list under the heading", () => {
    expect(renderAutoFactsNote({ city: "Алматы", age: "27" })).toBe(
      "Факты из разговора:\n• city: Алматы\n• age: 27",
    );
  });

  test("drops blank-valued facts", () => {
    expect(renderAutoFactsNote({ city: "Алматы", note: "   ", empty: "" })).toBe(
      "Факты из разговора:\n• city: Алматы",
    );
  });

  test("returns null when there is nothing non-empty", () => {
    expect(renderAutoFactsNote({})).toBeNull();
    expect(renderAutoFactsNote({ a: "", b: "  " })).toBeNull();
  });
});
