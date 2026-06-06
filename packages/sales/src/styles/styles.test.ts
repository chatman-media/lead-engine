import { describe, expect, it } from "bun:test";
import { StyleSchema } from "../types.ts";
import { getStyle, getStyleOrThrow, listStyles, STYLES } from "./index.ts";

describe("STYLES registry", () => {
  it("непустой, слаги уникальны, каждый валиден по StyleSchema", () => {
    expect(STYLES.length).toBeGreaterThan(0);
    const slugs = STYLES.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of STYLES) {
      const r = StyleSchema.safeParse(s);
      if (!r.success) console.error(`style ${s.slug} invalid:`, r.error.issues);
      expect(r.success).toBe(true);
    }
  });
  it("listStyles возвращает реестр", () => {
    expect(listStyles()).toBe(STYLES);
  });
  it("getStyle: найден / не найден", () => {
    expect(getStyle(STYLES[0]!.slug)?.slug).toBe(STYLES[0]!.slug);
    expect(getStyle("no-such-style")).toBeUndefined();
  });
  it("getStyleOrThrow: найден / бросает с перечислением известных", () => {
    expect(getStyleOrThrow(STYLES[0]!.slug).slug).toBe(STYLES[0]!.slug);
    expect(() => getStyleOrThrow("no-such-style")).toThrow("Style not found");
  });
});
