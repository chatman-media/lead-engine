import { describe, expect, test } from "bun:test";
import {
  extractVisaDocs,
  internalPassportToVisaFields,
  interpretInterviewAnswer,
  parseInterpretResult,
  parseVisaDocsJson,
  passportToVisaFields,
  toIsoDate,
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

  test("parses the extended anketa fields (birth province, nationality questions, mobile)", () => {
    const out = parseVisaDocsJson(
      `{"birth_province":"Moscow Oblast","other_nationalities":"no",` +
        `"other_permanent_residence":"no","held_other_nationalities":"no",` +
        `"mobile_phone":"+79990001122"}`,
    );
    expect(out.birth_province).toBe("Moscow Oblast");
    expect(out.other_nationalities).toBe("no");
    expect(out.other_permanent_residence).toBe("no");
    expect(out.held_other_nationalities).toBe("no");
    expect(out.mobile_phone).toBe("+79990001122");
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

describe("parseInterpretResult", () => {
  test("plain value lands in the current field", () => {
    const r = parseInterpretResult(
      `{"patch":{"family_name":"Kireeva"},"answered_current":true,"off_topic":false}`,
      "family_name",
      "Kireeva",
    );
    expect(r).toEqual({
      patch: { family_name: "Kireeva" },
      answeredCurrent: true,
      offTopic: false,
      llmFailed: false,
    });
  });

  test("cross-field correction: splits name + surname, fixes earlier field", () => {
    const r = parseInterpretResult(
      `{"patch":{"given_name":"Alexandra","family_name":"Kireeva"},` +
        `"answered_current":true,"off_topic":false}`,
      "given_name",
      "перепутала Alexandra имя, Kireeva фамилия",
    );
    expect(r.patch).toEqual({ given_name: "Alexandra", family_name: "Kireeva" });
    expect(r.answeredCurrent).toBe(true);
    expect(r.offTopic).toBe(false);
    expect(r.llmFailed).toBe(false);
  });

  test("correction-only message does not answer the current field", () => {
    const r = parseInterpretResult(
      `{"patch":{"family_name":"Kireeva"},"answered_current":false,"off_topic":false}`,
      "given_name",
      "у меня фамилия неправильная, надо Kireeva",
    );
    expect(r.patch).toEqual({ family_name: "Kireeva" });
    expect(r.answeredCurrent).toBe(false);
    expect(r.llmFailed).toBe(false);
  });

  test("off-topic question yields an empty patch", () => {
    const r = parseInterpretResult(
      `{"patch":{},"answered_current":false,"off_topic":true}`,
      "date_of_birth",
      "а сколько это займёт времени?",
    );
    expect(r.offTopic).toBe(true);
    expect(r.patch).toEqual({});
    expect(r.llmFailed).toBe(false);
  });

  test("strips a hallucinated field absent from the message", () => {
    const r = parseInterpretResult(
      `{"patch":{"given_name":"Alexandra","passport_number":"123456789"},` +
        `"answered_current":true,"off_topic":false}`,
      "given_name",
      "Alexandra",
    );
    expect(r.patch).toEqual({ given_name: "Alexandra" });
    expect((r.patch as Record<string, unknown>).passport_number).toBeUndefined();
  });

  test("allows the current field to be normalised (date) even if not a substring", () => {
    const r = parseInterpretResult(
      `{"patch":{"date_of_birth":"1998-04-12"},"answered_current":true,"off_topic":false}`,
      "date_of_birth",
      "12 апреля 1998",
    );
    expect(r.patch.date_of_birth).toBe("1998-04-12");
    expect(r.answeredCurrent).toBe(true);
  });

  test("garbage marks llmFailed so the caller falls back", () => {
    expect(parseInterpretResult("nope", "family_name", "x").llmFailed).toBe(true);
    expect(parseInterpretResult("", "family_name", "x").llmFailed).toBe(true);
    expect(parseInterpretResult("{ broken", "family_name", "x").llmFailed).toBe(true);
  });

  test("answered_current with no value for the current field is inconsistent → llmFailed", () => {
    const r = parseInterpretResult(
      `{"patch":{},"answered_current":true,"off_topic":false}`,
      "family_name",
      "Kireeva",
    );
    expect(r.llmFailed).toBe(true);
  });

  test("nothing usable (empty patch, not answered, not off-topic) → llmFailed", () => {
    const r = parseInterpretResult(
      `{"patch":{},"answered_current":false,"off_topic":false}`,
      "family_name",
      "Kireeva",
    );
    expect(r.llmFailed).toBe(true);
  });
});

describe("interpretInterviewAnswer", () => {
  test("returns the parsed interpretation from the LLM", async () => {
    const chat = fakeChat(
      `{"patch":{"given_name":"Alexandra","family_name":"Kireeva"},` +
        `"answered_current":true,"off_topic":false}`,
    );
    const r = await interpretInterviewAnswer({
      currentField: "given_name",
      question: "Given name",
      userMessage: "перепутала Alexandra имя, Kireeva фамилия",
      existingDocs: { family_name: "Alexandra" },
      chat,
    });
    expect(chat.calls).toBe(1);
    expect(r.patch).toEqual({ given_name: "Alexandra", family_name: "Kireeva" });
    expect(r.answeredCurrent).toBe(true);
    expect(r.llmFailed).toBe(false);
  });

  test('treats "нет" as a valid answer for the current field', async () => {
    const chat = fakeChat(
      `{"patch":{"other_nationalities":"no"},"answered_current":true,"off_topic":false}`,
    );
    const r = await interpretInterviewAnswer({
      currentField: "other_nationalities",
      question: "Other nationalities",
      userMessage: "нет",
      existingDocs: {},
      chat,
    });
    expect(r.patch.other_nationalities).toBe("no");
    expect(r.answeredCurrent).toBe(true);
  });

  test("returns llmFailed on LLM error", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    const r = await interpretInterviewAnswer({
      currentField: "family_name",
      question: "Family name",
      userMessage: "Kireeva",
      existingDocs: {},
      chat: failing,
    });
    expect(r.llmFailed).toBe(true);
    expect(r.patch).toEqual({});
    expect(r.answeredCurrent).toBe(false);
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

describe("toIsoDate", () => {
  test("converts dd.mm.yyyy to yyyy-MM-dd", () => {
    expect(toIsoDate("12.04.1998")).toBe("1998-04-12");
    expect(toIsoDate("  18.04.2029 ")).toBe("2029-04-18");
  });

  test("leaves unrecognised formats unchanged", () => {
    expect(toIsoDate("1998-04-12")).toBe("1998-04-12");
    expect(toIsoDate("April 18, 2029")).toBe("April 18, 2029");
    expect(toIsoDate("")).toBe("");
  });
});

describe("passportToVisaFields", () => {
  test("maps all passport identity fields, converting dates", () => {
    const out = passportToVisaFields({
      family_name: "IVANOVA",
      given_name: "SOFIA",
      passport_number: "71 1234567",
      passport_expiry: "18.04.2029",
      date_of_birth: "12.04.1998",
      nationality: "Russia",
      place_of_birth: "MOSCOW",
    });
    expect(out).toEqual({
      family_name: "IVANOVA",
      given_name: "SOFIA",
      passport_number: "71 1234567",
      passport_expiration_date: "2029-04-18",
      date_of_birth: "1998-04-12",
      current_nationality: "Russia",
      passport_issuing_country: "Russia",
      city_of_birth: "MOSCOW",
    });
  });

  test("omits absent fields", () => {
    expect(passportToVisaFields({ given_name: "SOFIA" })).toEqual({ given_name: "SOFIA" });
    expect(passportToVisaFields({})).toEqual({});
  });
});

describe("internalPassportToVisaFields", () => {
  test("maps the internal-passport fields, converting the date", () => {
    const out = internalPassportToVisaFields({
      national_id_number: "12 34 567890",
      date_of_birth: "12.04.1998",
      place_of_birth: "г. МОСКВА",
    });
    expect(out).toEqual({
      national_id_number: "12 34 567890",
      date_of_birth: "1998-04-12",
      city_of_birth: "г. МОСКВА",
    });
  });

  test("omits absent fields", () => {
    expect(internalPassportToVisaFields({ national_id_number: "12 34 567890" })).toEqual({
      national_id_number: "12 34 567890",
    });
    expect(internalPassportToVisaFields({})).toEqual({});
  });
});
