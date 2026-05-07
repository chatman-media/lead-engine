import { describe, expect, test } from "bun:test";
import {
  extractVisaDocs,
  parseVisaDocsJson,
  type VisaFields,
  visaDocsCompleteness,
} from "@/leads/visa-docs.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";

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

describe("parseVisaDocsJson", () => {
  test("parses bare JSON object", () => {
    const out = parseVisaDocsJson(
      `{"family_name":"Ivanova","given_name":"Anna","date_of_birth":"2000-01-15"}`,
    );
    expect(out.family_name).toBe("Ivanova");
    expect(out.given_name).toBe("Anna");
    expect(out.date_of_birth).toBe("2000-01-15");
  });

  test("strips think tags + code fences", () => {
    const raw = '<think>...</think>\n```json\n{"phone":"+79991234567"}\n```';
    expect(parseVisaDocsJson(raw)).toEqual({ phone: "+79991234567" });
  });

  test("returns empty object on garbage", () => {
    expect(parseVisaDocsJson("nope")).toEqual({});
    expect(parseVisaDocsJson("")).toEqual({});
    expect(parseVisaDocsJson("{ broken")).toEqual({});
  });

  test("ignores unknown keys", () => {
    const out = parseVisaDocsJson(`{"family_name":"Ivanova","unknown_field":"hack"}`);
    expect(out.family_name).toBe("Ivanova");
    expect((out as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  test("ignores non-string values and oversized strings", () => {
    const huge = "x".repeat(2000);
    const out = parseVisaDocsJson(
      `{"family_name":"Ivanova","phone":12345,"work_experience":"${huge}"}`,
    );
    expect(out.family_name).toBe("Ivanova");
    expect(out.phone).toBeUndefined();
    expect(out.work_experience).toBeUndefined();
  });
});

describe("extractVisaDocs", () => {
  test("merges existing + extracted, new wins", async () => {
    const chat = fakeChat(`{"phone":"+79991234567","email":"a@b.c"}`);
    const merged = await extractVisaDocs({
      messages: [{ role: "user", content: "telephone +79991234567 email a@b.c" }],
      chat,
      existingDocs: { family_name: "Ivanova", phone: "old" },
    });
    expect(merged.family_name).toBe("Ivanova"); // preserved
    expect(merged.phone).toBe("+79991234567"); // overwritten
    expect(merged.email).toBe("a@b.c"); // added
  });

  test("returns existing unchanged on LLM error", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    const merged = await extractVisaDocs({
      messages: [{ role: "user", content: "x" }],
      chat: failing,
      existingDocs: { family_name: "Ivanova" },
    });
    expect(merged.family_name).toBe("Ivanova");
  });

  test("skips LLM call when there are no user messages", async () => {
    const chat = fakeChat('{"phone":"x"}');
    const merged = await extractVisaDocs({
      messages: [{ role: "assistant", content: "hi" }],
      chat,
      existingDocs: { family_name: "Ivanova" },
    });
    expect(chat.calls).toBe(0);
    expect(merged.family_name).toBe("Ivanova");
    expect(merged.phone).toBeUndefined();
  });
});

describe("visaDocsCompleteness", () => {
  test("returns 0 / total / full-missing on undefined", () => {
    const r = visaDocsCompleteness(undefined);
    expect(r.filled).toBe(0);
    expect(r.total).toBeGreaterThan(0);
    expect(r.missing.length).toBe(r.total);
  });

  test("counts filled required fields and lists missing", () => {
    const docs: VisaFields = {
      family_name: "Ivanova",
      given_name: "Anna",
      date_of_birth: "2000-01-01",
      phone: "+79991234567",
    };
    const r = visaDocsCompleteness(docs);
    expect(r.filled).toBe(4);
    expect(r.missing).not.toContain("family_name");
    expect(r.missing).not.toContain("given_name");
    expect(r.missing).toContain("national_id_number");
    expect(r.missing).toContain("passport_number");
  });

  test("empty-string values count as not-filled", () => {
    const docs: VisaFields = { family_name: "   ", given_name: "Anna" };
    const r = visaDocsCompleteness(docs);
    expect(r.filled).toBe(1);
    expect(r.missing).toContain("family_name");
  });
});
