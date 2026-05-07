import { describe, expect, test } from "bun:test";
import { composeSystemPrompt } from "../../../src/sales/prompt.ts";
import { empatheticNepq } from "../../../src/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "../../../src/sales/styles/flirty-belfort.ts";
import { type Style, StyleSchema } from "../../../src/sales/types.ts";

describe("composeSystemPrompt — sections always present", () => {
  test("includes persona name", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain(flirtyBelfort.persona.name);
  });

  test("includes voice tone", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain(flirtyBelfort.voice.tone);
  });

  test("includes framework blurb", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("Belfort"); // straight_line blurb mentions Belfort
  });

  test("includes hooks block when style has hooks", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("ХУКИ");
    // First hook of flirtyBelfort is social_proof
    expect(out).toContain("СОЦ. ДОКАЗАТЕЛЬСТВО");
  });

  test("includes current stage uppercase", () => {
    const out = composeSystemPrompt(flirtyBelfort, "pitch");
    expect(out).toContain("ТЕКУЩИЙ ЭТАП: PITCH");
  });

  test("includes guardrails block", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("ЖЁСТКИЕ ПРАВИЛА");
  });
});

describe("composeSystemPrompt — persona role behavior", () => {
  test("'human' role tells model never to admit being AI", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("Ты живой человек");
    expect(out).toContain("НИКОГДА не говори, что ты ИИ");
  });

  test("'human' role with botDisclosureOnDirectQuestion=false → evasive answer", () => {
    // flirtyBelfort.guardrails.botDisclosureOnDirectQuestion === false
    expect(flirtyBelfort.guardrails.botDisclosureOnDirectQuestion).toBe(false);
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("отвечай уклончиво");
  });

  test("'human' role with botDisclosureOnDirectQuestion=true → honest answer", () => {
    // empatheticNepq has the flag = true
    expect(empatheticNepq.guardrails.botDisclosureOnDirectQuestion).toBe(true);
    const out = composeSystemPrompt(empatheticNepq, "opener");
    expect(out).toContain("ЧЕСТНО ответь");
  });

  test("'assistant' role openly identifies as AI", () => {
    // Build a synthetic style with role=assistant
    const synthStyle: Style = StyleSchema.parse({
      ...flirtyBelfort,
      slug: "synth-assistant",
      persona: { name: "Бот", role: "assistant", company: "ALINA Models" },
    });
    const out = composeSystemPrompt(synthStyle, "opener");
    expect(out).toContain("ИИ-ассистент");
    expect(out).not.toContain("НИКОГДА не говори, что ты ИИ");
  });
});

describe("composeSystemPrompt — few-shot conditional", () => {
  test("includes few-shot by default (turn 1)", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("ПРИМЕРЫ ДИАЛОГА");
  });

  test("excludes few-shot when includeFewShot=false (follow-up turns)", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener", null, {
      includeFewShot: false,
    });
    expect(out).not.toContain("ПРИМЕРЫ ДИАЛОГА");
  });

  test("dropping few-shot meaningfully shrinks the prompt", () => {
    const withFs = composeSystemPrompt(flirtyBelfort, "opener", null, { includeFewShot: true });
    const noFs = composeSystemPrompt(flirtyBelfort, "opener", null, { includeFewShot: false });
    // Few-shot is several hundred chars; expect at least 200 char savings.
    expect(withFs.length - noFs.length).toBeGreaterThan(200);
  });
});

describe("composeSystemPrompt — KB context block", () => {
  test("includes KB CONTEXT block when context provided", () => {
    const out = composeSystemPrompt(flirtyBelfort, "pitch", "[#1] Test\nДубай $5000.");
    expect(out).toContain("KB CONTEXT");
    expect(out).toContain("[#1] Test");
    expect(out).toContain("Дубай $5000.");
  });

  test("omits KB CONTEXT block when no context", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener", null);
    expect(out).not.toContain("KB CONTEXT");
  });

  test("excludes references to non-existent kb_lookup tool (regression)", () => {
    // The Claude+MCP version had a 'kb_lookup' tool; the Ollama+RAG version doesn't.
    // The prompt must not tell the model to call a tool that doesn't exist.
    const out1 = composeSystemPrompt(flirtyBelfort, "pitch", null);
    const out2 = composeSystemPrompt(flirtyBelfort, "pitch", "[#1] T\ndata");
    const out3 = composeSystemPrompt(flirtyBelfort, "objection", null);
    expect(out1).not.toContain("kb_lookup");
    expect(out2).not.toContain("kb_lookup");
    expect(out3).not.toContain("kb_lookup");
  });
});

describe("composeSystemPrompt — grounding reminder", () => {
  test("appears when stage requires grounding AND no KB context", () => {
    const out = composeSystemPrompt(flirtyBelfort, "pitch", null);
    expect(out).toContain("Никогда не выдумывай цифры");
  });

  test("absent when KB context is provided (model has facts to use)", () => {
    const out = composeSystemPrompt(flirtyBelfort, "pitch", "[#1] T\ndata");
    expect(out).not.toContain("Никогда не выдумывай цифры");
  });

  test("absent on stages that don't require grounding", () => {
    // opener doesn't require grounding
    const out = composeSystemPrompt(flirtyBelfort, "opener", null);
    expect(out).not.toContain("Никогда не выдумывай цифры");
  });
});

describe("composeSystemPrompt — guardrails", () => {
  test("includes minor protection rule when noMinors=true", () => {
    expect(flirtyBelfort.guardrails.noMinors).toBe(true);
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("<18 лет");
  });

  test("includes forbidden topics list", () => {
    const out = composeSystemPrompt(flirtyBelfort, "opener");
    expect(out).toContain("Запрещённые темы");
    for (const topic of flirtyBelfort.guardrails.forbiddenTopics) {
      expect(out).toContain(topic);
    }
  });
});
