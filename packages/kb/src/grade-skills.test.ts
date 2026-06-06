import type { ChatClient } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { gradeSkills, parseSlugList } from "./grade-skills.ts";

const chat = (text: string): ChatClient => ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({ complete: async () => { throw new Error("x"); } }) as unknown as ChatClient;
const ALLOWED = ["mirroring", "scarcity-spots-left", "tactical-empathy"] as const;

describe("parseSlugList", () => {
  it("пусто → []", () => {
    expect(parseSlugList("", ALLOWED)).toEqual([]);
  });
  it("JSON-массив, фильтр по allowed", () => {
    expect(parseSlugList('["mirroring","unknown-skill","tactical-empathy"]', ALLOWED)).toEqual(["mirroring", "tactical-empathy"]);
  });
  it("code-fenced JSON", () => {
    expect(parseSlugList('```json\n["scarcity-spots-left"]\n```', ALLOWED)).toEqual(["scarcity-spots-left"]);
  });
  it("comma/newline текст → fallback-парсинг", () => {
    expect(parseSlugList("mirroring, tactical-empathy", ALLOWED)).toEqual(["mirroring", "tactical-empathy"]);
  });
  it("всё неразрешённое → []", () => {
    expect(parseSlugList('["foo","bar"]', ALLOWED)).toEqual([]);
  });
});

describe("gradeSkills", () => {
  const base = { question: "q", reply: "r", availableSlugs: ALLOWED };
  it("пустой availableSlugs → [] без LLM", async () => {
    expect(await gradeSkills({ ...base, availableSlugs: [], chat: chatThrows() })).toEqual([]);
  });
  it("парсит и фильтрует ответ LLM", async () => {
    expect(await gradeSkills({ ...base, chat: chat('["mirroring","x"]') })).toEqual(["mirroring"]);
  });
  it("LLM упал → [] (failure-soft)", async () => {
    expect(await gradeSkills({ ...base, chat: chatThrows() })).toEqual([]);
  });
});
