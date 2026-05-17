import { describe, expect, test } from "bun:test";
import { composeSystemPrompt } from "../prompt.ts";
import { marinaPrime } from "../styles/marina-prime.ts";

describe("composeSystemPrompt — core sections", () => {
  test("includes the persona name", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain(
      "Тебя зовут Марина",
    );
  });

  test("includes the framework blurb", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain("NEPQ");
  });

  test("separates sections with blank lines", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain("\n\n");
  });
});

describe("composeSystemPrompt — few-shot toggle", () => {
  test("included by default", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain(
      "ПРИМЕРЫ ДИАЛОГА",
    );
  });

  test("omitted when includeFewShot is false", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, {
      includeFewShot: false,
    });
    expect(prompt).not.toContain("ПРИМЕРЫ ДИАЛОГА");
  });
});

describe("composeSystemPrompt — KB context", () => {
  test("omitted when no context is provided", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).not.toContain(
      "KB CONTEXT (актуальные факты",
    );
  });

  test("included verbatim when context is provided", () => {
    const kb = "Корея: оклад ₩110 000 за смену.";
    const prompt = composeSystemPrompt(marinaPrime, "qualify", kb);
    expect(prompt).toContain("KB CONTEXT (актуальные факты");
    expect(prompt).toContain(kb);
  });
});

describe("composeSystemPrompt — human persona disclosure branch", () => {
  test("evasive answer when botDisclosureOnDirectQuestion is false", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain(
      "отвечай уклончиво",
    );
  });

  test("honest answer when botDisclosureOnDirectQuestion is true", () => {
    const style = structuredClone(marinaPrime);
    style.guardrails.botDisclosureOnDirectQuestion = true;
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("ЧЕСТНО ответь, что ты ИИ-ассистент");
    expect(prompt).not.toContain("отвечай уклончиво");
  });
});

describe("composeSystemPrompt — persona facts", () => {
  test("no facts section when persona has no facts", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).not.toContain(
      "ЛИЧНЫЕ ФАКТЫ",
    );
  });

  test("facts section rendered when persona facts are present", () => {
    const style = structuredClone(marinaPrime);
    style.persona.facts = { возраст: "28", город: "Москва" };
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("ЛИЧНЫЕ ФАКТЫ");
    expect(prompt).toContain("город: Москва");
  });
});
