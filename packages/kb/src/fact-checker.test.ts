import type { ChatClient } from "@chatman-media/llm-router";
import { afterEach, describe, expect, it } from "bun:test";
import { checkFacts, parseFactCheckResult } from "./fact-checker.ts";

const chat = (text: string): ChatClient => ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({ complete: async () => { throw new Error("down"); } }) as unknown as ChatClient;

const savedEnv = process.env.RAG_FACT_CHECKER_FAIL_OPEN;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.RAG_FACT_CHECKER_FAIL_OPEN;
  else process.env.RAG_FACT_CHECKER_FAIL_OPEN = savedEnv;
});

describe("parseFactCheckResult", () => {
  it("чистый JSON", () => {
    expect(parseFactCheckResult('{"grounded":false,"vacancyOk":true,"reason":"x"}')).toEqual({
      grounded: false,
      vacancyOk: true,
      reason: "x",
    });
  });
  it("code-fence + think убираются", () => {
    expect(parseFactCheckResult('<think>..</think>```json\n{"grounded":true,"vacancyOk":false}\n```')).toMatchObject({
      grounded: true,
      vacancyOk: false,
    });
  });
  it("нет {} → OK (fail-open парсинга)", () => {
    expect(parseFactCheckResult("no json")).toEqual({ grounded: true, vacancyOk: true });
  });
  it("битый JSON → OK", () => {
    expect(parseFactCheckResult("{broken")).toEqual({ grounded: true, vacancyOk: true });
  });
  it("non-bool поля → дефолт true", () => {
    expect(parseFactCheckResult('{"grounded":"yes"}')).toEqual({ grounded: true, vacancyOk: true });
  });
});

describe("checkFacts", () => {
  const base = { question: "q", answer: "Зарплата 1500$", context: "контекст 1500$" };
  it("пустой ответ → OK без вызова LLM", async () => {
    expect(await checkFacts({ ...base, answer: "  ", chat: chatThrows() })).toEqual({ grounded: true, vacancyOk: true });
  });
  it("нет контекста и вакансий → OK", async () => {
    expect(await checkFacts({ ...base, context: "", chat: chatThrows() })).toEqual({ grounded: true, vacancyOk: true });
  });
  it("есть контекст → парсит вердикт LLM", async () => {
    const r = await checkFacts({ ...base, chat: chat('{"grounded":false,"vacancyOk":true,"reason":"выдумал"}') });
    expect(r.grounded).toBe(false);
  });
  it("vacancies-ветка промпта", async () => {
    const r = await checkFacts({ ...base, vacanciesBlock: "Вакансия: 2000$", chat: chat('{"grounded":true,"vacancyOk":false,"reason":"не совпало"}') });
    expect(r.vacancyOk).toBe(false);
  });
  it("LLM упал → fail-closed по умолчанию", async () => {
    delete process.env.RAG_FACT_CHECKER_FAIL_OPEN;
    const r = await checkFacts({ ...base, chat: chatThrows() });
    expect(r.grounded).toBe(false);
    expect(r.reason).toContain("checker_error");
  });
  it("LLM упал + FAIL_OPEN=1 → пропускаем", async () => {
    process.env.RAG_FACT_CHECKER_FAIL_OPEN = "1";
    expect(await checkFacts({ ...base, chat: chatThrows() })).toEqual({ grounded: true, vacancyOk: true });
  });
});
