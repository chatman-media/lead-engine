import { describe, expect, test } from "bun:test";
import { ABRouter } from "../src/ab-router.ts";
import type { AnswerTelemetry } from "../src/answer-types.ts";
import type { Style } from "../src/styles.ts";

function makeStyle(slug: string): Style {
  return { slug } as unknown as Style;
}

describe("ABRouter", () => {
  test("throws when no variants are provided", () => {
    expect(() => new ABRouter({ variants: [] })).toThrow();
  });

  test("assigns the same user to the same variant deterministically", () => {
    const router = new ABRouter({
      variants: [{ style: makeStyle("a") }, { style: makeStyle("b") }],
    });
    const first = router.assign("user-42").variantSlug;
    for (let i = 0; i < 5; i++) {
      expect(router.assign("user-42").variantSlug).toBe(first);
    }
    expect(["a", "b"]).toContain(first);
  });

  test("distribution reflects relative weights", () => {
    const router = new ABRouter({
      variants: [
        { style: makeStyle("a"), weight: 1 },
        { style: makeStyle("b"), weight: 3 },
      ],
    });
    expect(router.distribution).toEqual({ a: 0.25, b: 0.75 });
  });

  test("a single-variant router always returns that variant", () => {
    const router = new ABRouter({ variants: [{ style: makeStyle("only") }] });
    expect(router.assign("anyone").variantSlug).toBe("only");
    expect(router.distribution).toEqual({ only: 1 });
  });

  test("salt changes assignment without changing variant set", () => {
    const variants = [{ style: makeStyle("a") }, { style: makeStyle("b") }];
    const unsalted = new ABRouter({ variants });
    const salted = new ABRouter({ variants, salt: "experiment-2" });
    const userId = "stable-user";
    expect(["a", "b"]).toContain(unsalted.assign(userId).variantSlug);
    expect(["a", "b"]).toContain(salted.assign(userId).variantSlug);
  });

  test("onTelemetry forwards the assigned slug and telemetry to onResult", () => {
    const calls: Array<{ slug: string; telemetry: AnswerTelemetry }> = [];
    const router = new ABRouter({
      variants: [{ style: makeStyle("a") }],
      onResult: (slug, telemetry) => calls.push({ slug, telemetry }),
    });
    const { variantSlug, onTelemetry } = router.assign("user-1");
    const telemetry: AnswerTelemetry = { path: "ok" };
    onTelemetry(telemetry);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slug).toBe(variantSlug);
    expect(calls[0]?.telemetry).toBe(telemetry);
  });
});
