import { describe, expect, test } from "bun:test";

import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import { checkVacancyFacts, parseGuardResult } from "@/rag/vacancy-guard.ts";

/** Minimal ChatClient stub — returns a canned string or throws. */
function fakeChat(reply: string | Error): ChatClient {
  return {
    complete: async (_messages: ChatMessage[]) => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe("parseGuardResult", () => {
  test('parses a clean {"ok": true}', () => {
    expect(parseGuardResult('{"ok": true}')).toEqual({ ok: true });
  });

  test('parses {"ok": false} and keeps the reason', () => {
    expect(parseGuardResult('{"ok": false, "reason": "salary mismatch"}')).toEqual({
      ok: false,
      reason: "salary mismatch",
    });
  });

  test("supplies a default reason when ok=false has no reason field", () => {
    expect(parseGuardResult('{"ok": false}')).toEqual({
      ok: false,
      reason: "vacancy data mismatch",
    });
  });

  test("strips think blocks and code fences before parsing", () => {
    expect(parseGuardResult('<think>hmm</think>```json\n{"ok": true}\n```')).toEqual({
      ok: true,
    });
  });

  test("extracts the JSON object from surrounding prose", () => {
    expect(parseGuardResult('Вот результат: {"ok": false, "reason": "город"} — всё.')).toEqual({
      ok: false,
      reason: "город",
    });
  });

  test("fails open (ok=true) on malformed JSON or no object", () => {
    expect(parseGuardResult("not json at all")).toEqual({ ok: true });
    expect(parseGuardResult('{"ok":')).toEqual({ ok: true });
  });

  test("fails open when ok is not a boolean", () => {
    expect(parseGuardResult('{"ok": "yes"}')).toEqual({ ok: true });
  });
});

describe("checkVacancyFacts", () => {
  test("skips the LLM call when the vacancies block is empty", async () => {
    let called = false;
    const chat: ChatClient = {
      complete: async () => {
        called = true;
        return '{"ok": false}';
      },
    };
    const res = await checkVacancyFacts({ answer: "Зарплата $2000", vacanciesBlock: "  ", chat });
    expect(res).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  test("skips the LLM call when the answer is empty", async () => {
    const res = await checkVacancyFacts({
      answer: "   ",
      vacanciesBlock: "Korea, $2000",
      chat: fakeChat('{"ok": false}'),
    });
    expect(res).toEqual({ ok: true });
  });

  test("returns the guard verdict from the LLM response", async () => {
    const res = await checkVacancyFacts({
      answer: "Зарплата $5000",
      vacanciesBlock: "Korea, $2000",
      chat: fakeChat('{"ok": false, "reason": "оклад не совпадает"}'),
    });
    expect(res).toEqual({ ok: false, reason: "оклад не совпадает" });
  });

  test("fails open when the LLM call throws", async () => {
    const res = await checkVacancyFacts({
      answer: "Зарплата $5000",
      vacanciesBlock: "Korea, $2000",
      chat: fakeChat(new Error("network down")),
    });
    expect(res).toEqual({ ok: true });
  });
});
