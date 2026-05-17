import { describe, expect, test } from "bun:test";
import { alinaInfinity } from "../../../src/sales/styles/alina-infinity.ts";
import { coldDirectPas } from "../../../src/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "../../../src/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "../../../src/sales/styles/flirty-belfort.ts";
import { getStyle, getStyleOrThrow, listStyles, STYLES } from "../../../src/sales/styles/index.ts";
import { StyleSchema } from "../../../src/sales/types.ts";

describe("style registry", () => {
  test("listStyles() returns all registered styles", () => {
    expect(listStyles().length).toBe(4);
  });

  test("getStyle() returns the style by slug", () => {
    expect(getStyle("alina-infinity-v1")?.slug).toBe("alina-infinity-v1");
    expect(getStyle("flirty-belfort-v1")?.slug).toBe("flirty-belfort-v1");
    expect(getStyle("empathetic-nepq-v1")?.slug).toBe("empathetic-nepq-v1");
    expect(getStyle("cold-direct-pas-v1")?.slug).toBe("cold-direct-pas-v1");
  });

  test("getStyle() returns undefined for unknown slug", () => {
    expect(getStyle("does-not-exist")).toBeUndefined();
  });

  test("getStyleOrThrow() throws with helpful message on unknown slug", () => {
    expect(() => getStyleOrThrow("nonexistent")).toThrow(/not found/);
  });

  test("STYLES list has unique slugs (no accidental duplicates)", () => {
    const slugs = STYLES.map((s) => s.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });
});

const SAMPLES = [alinaInfinity, flirtyBelfort, empatheticNepq, coldDirectPas];

describe("sample styles — schema validity", () => {
  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s parses against StyleSchema", (_slug, style) => {
    // Parsing the already-parsed object should be a no-op identity.
    expect(() => StyleSchema.parse(style)).not.toThrow();
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s has at least one hook", (_slug, style) => {
    expect(style.hooks.length).toBeGreaterThanOrEqual(1);
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s has all 5 funnel stages defined", (_slug, style) => {
    const stages = style.stages;
    expect(stages.opener).toBeDefined();
    expect(stages.qualify).toBeDefined();
    expect(stages.pitch).toBeDefined();
    expect(stages.objection).toBeDefined();
    expect(stages.close).toBeDefined();
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s pitch stage has grounding field defined", (_slug, style) => {
    expect(typeof style.stages.pitch?.groundingRequired).toBe("boolean");
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s guardrails block minors", (_slug, style) => {
    expect(style.guardrails.noMinors).toBe(true);
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s pins a non-empty model id", (_slug, style) => {
    expect(style.model.id.length).toBeGreaterThan(0);
  });

  test.each(
    SAMPLES.map((s) => [s.slug, s] as const),
  )("%s temperature is in valid sampling range", (_slug, style) => {
    expect(style.model.temperature).toBeGreaterThanOrEqual(0);
    expect(style.model.temperature).toBeLessThanOrEqual(2);
  });
});

describe("schema rejection — bad input", () => {
  test("non-kebab-case slug is rejected", () => {
    expect(() =>
      StyleSchema.parse({
        ...flirtyBelfort,
        slug: "Bad_Slug",
      }),
    ).toThrow();
  });

  test("invalid framework is rejected", () => {
    expect(() =>
      StyleSchema.parse({
        ...flirtyBelfort,
        framework: "made_up_framework",
      }),
    ).toThrow();
  });

  test("invalid hook kind is rejected", () => {
    expect(() =>
      StyleSchema.parse({
        ...flirtyBelfort,
        hooks: [{ kind: "not_a_real_kind", text: "x" }],
      }),
    ).toThrow();
  });

  test("temperature out of range is rejected", () => {
    expect(() =>
      StyleSchema.parse({
        ...flirtyBelfort,
        model: { ...flirtyBelfort.model, temperature: 5 },
      }),
    ).toThrow();
  });
});
