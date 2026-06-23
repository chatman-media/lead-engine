import { describe, expect, test } from "bun:test";
import { composeSystemPrompt, type SkillForPrompt } from "../prompt.ts";
import { StyleSchema } from "../types.ts";
import { marinaPrime } from "../styles/marina-prime.ts";

describe("composeSystemPrompt — core sections", () => {
  test("includes the persona name", () => {
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain("Тебя зовут Марина");
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
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain("ПРИМЕРЫ ДИАЛОГА");
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
    expect(composeSystemPrompt(marinaPrime, "qualify")).toContain("отвечай уклончиво");
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
    expect(composeSystemPrompt(marinaPrime, "qualify")).not.toContain("ЛИЧНЫЕ ФАКТЫ");
  });

  test("facts section rendered when persona facts are present", () => {
    const style = structuredClone(marinaPrime);
    style.persona.facts = { возраст: "28", город: "Москва" };
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("ЛИЧНЫЕ ФАКТЫ");
    expect(prompt).toContain("город: Москва");
  });
});

// ── AI (assistant) persona ────────────────────────────────────────────────────
describe("composeSystemPrompt — assistant persona", () => {
  const aiStyle = StyleSchema.parse({
    slug: "ai-style",
    displayName: "AI Style",
    persona: { name: "Бот", role: "assistant", company: "Acme" },
    voice: { tone: "деловой", language: "ru" },
    framework: "AIDA",
    stages: { qualify: { goal: "выяснить потребность" } },
    guardrails: {},
    model: {},
  });

  test("assistant persona: нет 'живой человек', есть 'ИИ-ассистент'", () => {
    const prompt = composeSystemPrompt(aiStyle, "qualify");
    expect(prompt).toContain("ИИ-ассистент");
    expect(prompt).not.toContain("живой человек");
  });

  test("assistant persona: нет ветки disclosure (только human)", () => {
    const prompt = composeSystemPrompt(aiStyle, "qualify");
    expect(prompt).not.toContain("отвечай уклончиво");
  });

  test("kbGroundingReminder с assistant ролью: вариант 'уточнишь у руководства'", () => {
    const style = structuredClone(aiStyle);
    style.stages = { qualify: { goal: "g", groundingRequired: true } };
    const prompt = composeSystemPrompt(style, "qualify", null);
    expect(prompt).toContain("уточнишь у руководства");
    expect(prompt).not.toContain("по-человечески");
  });
});

// ── Hooks ─────────────────────────────────────────────────────────────────────
describe("composeSystemPrompt — hooks", () => {
  test("hooks рендерятся при наличии", () => {
    const style = structuredClone(marinaPrime);
    style.hooks = [{ kind: "scarcity", text: "Мест мало" }];
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("ХУКИ");
    expect(prompt).toContain("ДЕФИЦИТ");
    expect(prompt).toContain("Мест мало");
  });

  test("без hooks — блок хуков отсутствует", () => {
    const style = structuredClone(marinaPrime);
    style.hooks = [];
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).not.toContain("ХУКИ");
  });
});

// ── Skills filtering ──────────────────────────────────────────────────────────
describe("composeSystemPrompt — skills", () => {
  const mirror: SkillForPrompt = {
    slug: "mirror",
    displayName: "Зеркало",
    promptFragment: "отражай речь собеседника",
    applicableStages: [],
  };
  const closingSkill: SkillForPrompt = {
    slug: "close",
    displayName: "Закрытие",
    promptFragment: "прямо попроси принять решение",
    applicableStages: ["close"],
  };

  test("always-on skill попадает на любом этапе", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, { skills: [mirror] });
    expect(prompt).toContain("ПРИЁМЫ");
    expect(prompt).toContain("Зеркало");
  });

  test("stage-specific skill отфильтровывается на чужом этапе", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, { skills: [closingSkill] });
    expect(prompt).not.toContain("Закрытие");
  });

  test("stage-specific skill показывается на своём этапе", () => {
    const prompt = composeSystemPrompt(marinaPrime, "close", null, { skills: [closingSkill] });
    expect(prompt).toContain("Закрытие");
  });
});

// ── Support mode ──────────────────────────────────────────────────────────────
describe("composeSystemPrompt — supportPhase", () => {
  test("docs: содержит РЕЖИМ ПОДДЕРЖКИ + собираем документы", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, { supportPhase: "docs" });
    expect(prompt).toContain("РЕЖИМ ПОДДЕРЖКИ");
    expect(prompt).toContain("собираем её документы");
    // sales-блоки убраны
    expect(prompt).not.toContain("ФРЕЙМВОРК");
    expect(prompt).not.toContain("ПРИМЕРЫ ДИАЛОГА");
  });

  test("submitted: содержит 'Заявка уже подана'", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, { supportPhase: "submitted" });
    expect(prompt).toContain("подана");
  });
});

// ── Stage без конфига ─────────────────────────────────────────────────────────
describe("composeSystemPrompt — stage not in config", () => {
  // Стиль без описания для "pitch" — stageCfg будет undefined → fallback
  const minimalStyle = StyleSchema.parse({
    slug: "minimal",
    displayName: "Minimal",
    persona: { name: "Бот", role: "assistant" },
    voice: { tone: "нейтральный", language: "ru" },
    framework: "SPIN",
    stages: { qualify: { goal: "понять запрос" } },
    guardrails: {},
    model: {},
  });

  test("этап без stageCfg → fallback с именем этапа", () => {
    const prompt = composeSystemPrompt(minimalStyle, "pitch");
    expect(prompt).toContain("ТЕКУЩИЙ ЭТАП: pitch");
    expect(prompt).toContain("Специфических правил для этапа нет");
  });
});

// ── Guardrails ────────────────────────────────────────────────────────────────
describe("composeSystemPrompt — guardrails", () => {
  test("noMinors: добавляет правило о несовершеннолетних", () => {
    const style = structuredClone(marinaPrime);
    style.guardrails.noMinors = true;
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("<18 лет");
  });

  test("forbiddenTopics: рендерятся в ЖЁСТКИХ ПРАВИЛАХ", () => {
    const style = structuredClone(marinaPrime);
    style.guardrails.forbiddenTopics = ["политика", "религия"];
    const prompt = composeSystemPrompt(style, "qualify");
    expect(prompt).toContain("Запрещённые темы: политика, религия");
  });
});

// ── Grounding reminder ────────────────────────────────────────────────────────
describe("composeSystemPrompt — groundingRequired reminder", () => {
  test("groundingRequired=true без KB → добавляет reminder для human", () => {
    const style = structuredClone(marinaPrime);
    style.stages = { qualify: { goal: "g", groundingRequired: true } };
    const prompt = composeSystemPrompt(style, "qualify", null);
    expect(prompt).toContain("по-человечески");
  });

  test("groundingRequired=true С KB → reminder не нужен", () => {
    const style = structuredClone(marinaPrime);
    style.stages = { qualify: { goal: "g", groundingRequired: true } };
    const prompt = composeSystemPrompt(style, "qualify", "KB context here");
    expect(prompt).not.toContain("Никогда не выдумывай");
  });
});

// ── userFacts + conversationSummary ──────────────────────────────────────────
describe("composeSystemPrompt — userFacts + conversationSummary", () => {
  test("userFacts рендерятся в блоке ЗНАЕМ О КАНДИДАТЕ", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, {
      userFacts: { city: "Бангкок" },
    });
    expect(prompt).toContain("ЗНАЕМ О КАНДИДАТЕ");
    expect(prompt).toContain("city: Бангкок");
  });

  test("conversationSummary добавляет блок ИЗ РАННЕЙ ПЕРЕПИСКИ", () => {
    const prompt = composeSystemPrompt(marinaPrime, "qualify", null, {
      conversationSummary: "обсудили зарплату",
    });
    expect(prompt).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(prompt).toContain("обсудили зарплату");
  });
});
