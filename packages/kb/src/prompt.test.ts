// Unit tests for kb composeSystemPrompt — the prompt builder used by the reply
// pipeline (answer.ts). Focus: Phase 2 C-2 `stageOverride` precedence (the
// lead's funnel-stage goal/guidance wins over the Style's per-sales-stage cfg).

import { describe, expect, it } from "bun:test";
import { composeSystemPrompt, renderKbContextBlock } from "./prompt.ts";
import type { Style } from "./styles.ts";

const baseStyle: Style = {
  slug: "t",
  displayName: "T",
  persona: { name: "Алекс", role: "human" },
  voice: { tone: "friendly", language: "ru", forbid: [] },
  framework: "SPIN",
  hooks: [],
  stages: { qualify: { goal: "STYLE_GOAL", groundingRequired: false } },
  fewShot: [],
  guardrails: { noMinors: true, botDisclosureOnDirectQuestion: true, forbiddenTopics: [] },
  model: { id: "x", temperature: 0.5, maxTokens: 100 },
};

describe("composeSystemPrompt — persona / voice / framework blocks", () => {
  it("human persona: менеджер агентства + честное раскрытие бота (botDisclosure=true)", () => {
    const p = composeSystemPrompt(
      { ...baseStyle, persona: { name: "Аня", role: "human", company: "Acme" } },
      "qualify",
    );
    expect(p).toContain("менеджер агентства Acme");
    expect(p).toContain("ЧЕСТНО ответь, что ты ИИ-ассистент");
    expect(p).toContain("ФРЕЙМВОРК");
  });

  it("human persona, botDisclosure=false → уклончивый ответ про бота", () => {
    const s: Style = {
      ...baseStyle,
      guardrails: { ...baseStyle.guardrails, botDisclosureOnDirectQuestion: false },
    };
    const p = composeSystemPrompt(s, "qualify");
    expect(p).toContain("отвечай уклончиво");
  });

  it("assistant persona: ИИ-ассистент", () => {
    const p = composeSystemPrompt(
      { ...baseStyle, persona: { name: "Бот", role: "assistant", company: "Acme" } },
      "qualify",
    );
    expect(p).toContain("ИИ-ассистент агентства Acme");
  });

  it("persona.facts → блок личных фактов", () => {
    const p = composeSystemPrompt(
      { ...baseStyle, persona: { name: "Аня", role: "human", facts: { age: "25", empty: " " } } },
      "qualify",
    );
    expect(p).toContain("ЛИЧНЫЕ ФАКТЫ");
    expect(p).toContain("age: 25");
    expect(p).not.toContain("empty");
  });

  it("voice.forbid → блок ЗАПРЕЩЕНО; язык en", () => {
    const p = composeSystemPrompt(
      { ...baseStyle, voice: { tone: "bold", language: "en", forbid: ["мат", "сленг"] } },
      "qualify",
    );
    expect(p).toContain("Язык: английский");
    expect(p).toContain("ЗАПРЕЩЕНО: мат; сленг");
  });
});

describe("composeSystemPrompt — hooks / director hooks / skills", () => {
  it("hooks → блок ХУКИ с лейблами", () => {
    const p = composeSystemPrompt(
      { ...baseStyle, hooks: [{ kind: "scarcity", text: "осталось 3 места" }] },
      "qualify",
    );
    expect(p).toContain("ДЕФИЦИТ: осталось 3 места");
  });

  it("directorHooks → блок ХУКИ УБЕЖДЕНИЯ + triggerHint", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, {
      directorHooks: [{ name: "FOMO", body: "дави на срочность", triggerHint: "колеблется" }],
    });
    expect(p).toContain("ХУКИ УБЕЖДЕНИЯ");
    expect(p).toContain("FOMO");
    expect(p).toContain("Когда: колеблется");
  });

  it("skills фильтруются по стадии", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, {
      skills: [
        { slug: "mirror", displayName: "Зеркало", promptFragment: "отражай", applicableStages: ["qualify"] },
        { slug: "close", displayName: "Закрытие", promptFragment: "закрывай", applicableStages: ["close"] },
        { slug: "always", displayName: "Всегда", promptFragment: "везде", applicableStages: [] },
      ],
    });
    expect(p).toContain("ПРИЁМЫ");
    expect(p).toContain("Зеркало");
    expect(p).toContain("Всегда");
    expect(p).not.toContain("Закрытие");
  });
});

describe("composeSystemPrompt — support mode / grounding / few-shot", () => {
  it("supportPhase=docs → блок поддержки, sales-блоки выкинуты", () => {
    const s: Style = { ...baseStyle, hooks: [{ kind: "scarcity", text: "x" }] };
    const p = composeSystemPrompt(s, "qualify", null, { supportPhase: "docs" });
    expect(p).toContain("РЕЖИМ ПОДДЕРЖКИ");
    expect(p).toContain("около 10 дней");
    expect(p).not.toContain("ФРЕЙМВОРК");
    expect(p).not.toContain("ДЕФИЦИТ");
  });

  it("supportPhase=submitted → текст про консульство", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, { supportPhase: "submitted" });
    expect(p).toContain("подана в консульство");
  });

  it("groundingRequired + нет KB контекста → напоминание о grounding (human)", () => {
    const s: Style = {
      ...baseStyle,
      persona: { name: "Аня", role: "human" },
      stages: { qualify: { goal: "G", groundingRequired: true } },
    };
    const p = composeSystemPrompt(s, "qualify");
    expect(p).toContain("GROUNDING");
    expect(p).toContain("Никогда не выдумывай");
  });

  it("groundingRequired + есть KB контекст → KB CONTEXT присутствует", () => {
    const s: Style = {
      ...baseStyle,
      stages: { qualify: { goal: "G", groundingRequired: true } },
    };
    const p = composeSystemPrompt(s, "qualify", "факт: зарплата 1500");
    expect(p).toContain("KB CONTEXT");
  });

  it("inlineKbContext=false → KB CONTEXT НЕ инлайнится, grounding-логика цела", () => {
    const s: Style = {
      ...baseStyle,
      stages: { qualify: { goal: "G", groundingRequired: true } },
    };
    const p = composeSystemPrompt(s, "qualify", "факт: зарплата 1500", { inlineKbContext: false });
    // KB-блок не в системном промпте (выносится отдельным сообщением в answer.ts)
    expect(p).not.toContain("KB CONTEXT (актуальные");
    // но GROUNDING-инструкция остаётся (стадия требует grounding)
    expect(p).toContain("GROUNDING");
    // и НЕТ ложного «нет KB»-напоминания — контекст есть, просто вынесен
    expect(p).not.toContain("Никогда не выдумывай цифры");
  });

  it("renderKbContextBlock форматирует блок KB CONTEXT", () => {
    const b = renderKbContextBlock("зарплата 1500");
    expect(b).toContain("KB CONTEXT (актуальные факты агентства)");
    expect(b).toContain("зарплата 1500");
  });

  it("few-shot включается по умолчанию и выключается флагом", () => {
    const s: Style = {
      ...baseStyle,
      fewShot: [{ user: "сколько?", assistant: "уточню", stage: "qualify" }],
    };
    expect(composeSystemPrompt(s, "qualify")).toContain("ПРИМЕРЫ ДИАЛОГА");
    expect(composeSystemPrompt(s, "qualify", null, { includeFewShot: false })).not.toContain(
      "ПРИМЕРЫ ДИАЛОГА",
    );
  });

  it("guardrails: noMinors + forbiddenTopics → жёсткие правила", () => {
    const s: Style = {
      ...baseStyle,
      guardrails: {
        noMinors: true,
        botDisclosureOnDirectQuestion: true,
        forbiddenTopics: ["политика"],
      },
    };
    const p = composeSystemPrompt(s, "qualify");
    expect(p).toContain("ЖЁСТКИЕ ПРАВИЛА");
    expect(p).toContain("<18 лет");
    expect(p).toContain("Запрещённые темы: политика");
  });

  it("стадия без конфига и без override → generic-блок", () => {
    const p = composeSystemPrompt(baseStyle, "pitch");
    expect(p).toContain("Специфических правил для этапа нет");
  });
});

describe("composeSystemPrompt — stageOverride (Phase 2 C-2)", () => {
  it("без override → goal берётся из Style", () => {
    const p = composeSystemPrompt(baseStyle, "qualify");
    expect(p).toContain("STYLE_GOAL");
  });

  it("stageOverride имеет приоритет над Style для goal и guidance", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, {
      stageOverride: { goal: "OVERRIDE_GOAL", guidance: "OVERRIDE_GUIDE" },
    });
    expect(p).toContain("OVERRIDE_GOAL");
    expect(p).toContain("OVERRIDE_GUIDE");
    expect(p).not.toContain("STYLE_GOAL");
  });

  it("stageOverride работает для стадии без конфига в Style", () => {
    // "close" нет в baseStyle.stages → раньше был бы generic-блок; теперь override.
    const p = composeSystemPrompt(baseStyle, "close", null, {
      stageOverride: { goal: "CLOSE_GOAL" },
    });
    expect(p).toContain("CLOSE_GOAL");
  });
});

describe("composeSystemPrompt — requestContext (R4 multi-request)", () => {
  it("requestContext → блок «ЗАПРОС ГОСТЯ» в промпте", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, {
      requestContext: "гость сейчас ведёт запрос «Трансфер».",
    });
    expect(p).toContain("ЗАПРОС ГОСТЯ:");
    expect(p).toContain("«Трансфер»");
  });

  it("без requestContext → блока нет", () => {
    const p = composeSystemPrompt(baseStyle, "qualify");
    expect(p).not.toContain("ЗАПРОС ГОСТЯ:");
  });
});

describe("composeSystemPrompt — awaitingOperator (R5)", () => {
  it("awaitingOperator → блок «ОЖИДАНИЕ ОПЕРАТОРА»", () => {
    const p = composeSystemPrompt(baseStyle, "close", null, { awaitingOperator: true });
    expect(p).toContain("ОЖИДАНИЕ ОПЕРАТОРА");
  });

  it("без флага → блока нет", () => {
    const p = composeSystemPrompt(baseStyle, "close");
    expect(p).not.toContain("ОЖИДАНИЕ ОПЕРАТОРА");
  });
});

describe("composeSystemPrompt — few-shot фильтр по стадии", () => {
  it("берёт примеры текущей стадии + неразмеченные, чужие отбрасывает", () => {
    const s: Style = {
      ...baseStyle,
      fewShot: [
        { user: "q1", assistant: "a-qualify", stage: "qualify" },
        { user: "q2", assistant: "a-pitch", stage: "pitch" },
        { user: "q3", assistant: "a-general" }, // без stage → общий
      ],
    };
    const p = composeSystemPrompt(s, "qualify");
    expect(p).toContain("a-qualify");
    expect(p).toContain("a-general");
    expect(p).not.toContain("a-pitch");
  });

  it("неразмеченные примеры не зависят от стадии (без регресса для старых стилей)", () => {
    const s: Style = { ...baseStyle, fewShot: [{ user: "q", assistant: "a-gen" }] };
    expect(composeSystemPrompt(s, "qualify")).toContain("a-gen");
    expect(composeSystemPrompt(s, "close")).toContain("a-gen");
  });

  it("fallback: если под стадию ничего не подошло — показываем все примеры", () => {
    const s: Style = {
      ...baseStyle,
      fewShot: [
        { user: "q1", assistant: "a-pitch", stage: "pitch" },
        { user: "q2", assistant: "a-close", stage: "close" },
      ],
    };
    const p = composeSystemPrompt(s, "qualify"); // нет qualify- и нет общих примеров
    expect(p).toContain("a-pitch");
    expect(p).toContain("a-close");
  });
});

describe("composeSystemPrompt — порядок под prompt-cache (стабильное раньше волатильного)", () => {
  // Стиль со всеми блоками сразу: few-shot + guardrails(noMinors) + KB + userFacts + summary.
  const richStyle: Style = {
    ...baseStyle,
    fewShot: [{ user: "сколько?", assistant: "уточню", stage: "qualify" }],
  };
  const p = composeSystemPrompt(richStyle, "qualify", "факт: зарплата 1500", {
    userFacts: { city: "Москва" },
    conversationSummary: "обсудили вакансию",
  });
  const idx = (s: string) => p.indexOf(s);
  const STABLE = ["ЖЁСТКИЕ ПРАВИЛА", "ПРИМЕРЫ ДИАЛОГА"];
  // KB header — «KB CONTEXT (актуальные…», чтобы не путать с упоминаниями «KB»/«CONTEXT» в других блоках.
  const VOLATILE = ["ИЗ РАННЕЙ ПЕРЕПИСКИ", "ЗНАЕМ О КАНДИДАТЕ", "KB CONTEXT (актуальные"];

  it("все блоки присутствуют", () => {
    for (const m of [...STABLE, ...VOLATILE]) expect(idx(m)).toBeGreaterThanOrEqual(0);
  });

  it("каждый стабильный блок стоит ПЕРЕД каждым волатильным", () => {
    for (const stable of STABLE) {
      for (const volatile of VOLATILE) {
        expect(idx(stable)).toBeLessThan(idx(volatile));
      }
    }
  });

  it("KB CONTEXT — последний (самый волатильный, меняется каждый ход)", () => {
    expect(idx("KB CONTEXT (актуальные")).toBeGreaterThan(idx("ЗНАЕМ О КАНДИДАТЕ"));
    expect(idx("KB CONTEXT (актуальные")).toBeGreaterThan(idx("ИЗ РАННЕЙ ПЕРЕПИСКИ"));
  });
});
