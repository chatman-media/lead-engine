import { StyleSchema } from "@chatman-media/kb";
import { describe, expect, it } from "bun:test";
import { EXCHANGE_STYLES } from "./index.ts";

describe("EXCHANGE_STYLES", () => {
  it("provides at least two ready-made styles", () => {
    expect(EXCHANGE_STYLES.length).toBeGreaterThanOrEqual(2);
  });

  it("every style is schema-valid with a unique kebab slug", () => {
    const slugs = new Set<string>();
    for (const s of EXCHANGE_STYLES) {
      expect(() => StyleSchema.parse(s)).not.toThrow();
      expect(s.slug).toMatch(/^[a-z0-9-]+$/);
      expect(slugs.has(s.slug)).toBe(false);
      slugs.add(s.slug);
      // conversational coverage: opener + qualify + close at minimum
      expect(s.stages.opener?.goal?.length ?? 0).toBeGreaterThan(0);
      expect(s.stages.qualify?.goal?.length ?? 0).toBeGreaterThan(0);
      expect(s.stages.close?.goal?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
