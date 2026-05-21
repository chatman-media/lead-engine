import { describe, expect, it } from "bun:test";
import { VerticalRegistry } from "./registry.ts";
import type { VerticalTemplate } from "./types.ts";

const tpl = (slug: string, version: number): VerticalTemplate => ({
  slug,
  displayName: slug,
  version,
  funnelStages: [{ slug: "intake", kind: "intake", displayName: "Intake" }],
});

describe("VerticalRegistry", () => {
  it("регистрирует и резолвит template по slug", () => {
    const r = new VerticalRegistry();
    r.register(tpl("foo", 1));
    expect(r.load("foo").displayName).toBe("foo");
  });

  it("load бросает explicit error если slug не найден, со списком available", () => {
    const r = new VerticalRegistry();
    r.register(tpl("foo", 1));
    r.register(tpl("bar", 1));
    expect(() => r.load("zzz")).toThrow(/foo.*bar|bar.*foo/);
  });

  it("tryLoad возвращает undefined вместо throw", () => {
    const r = new VerticalRegistry();
    expect(r.tryLoad("zzz")).toBeUndefined();
  });

  it("отказывается регистрировать ту же или младшую версию (защита от race-import'а)", () => {
    const r = new VerticalRegistry();
    r.register(tpl("foo", 2));
    expect(() => r.register(tpl("foo", 2))).toThrow(/already registered/);
    expect(() => r.register(tpl("foo", 1))).toThrow(/already registered/);
  });

  it("позволяет зарегистрировать новую версию поверх старой", () => {
    const r = new VerticalRegistry();
    r.register(tpl("foo", 1));
    r.register(tpl("foo", 2));
    expect(r.load("foo").version).toBe(2);
  });

  it("list() сортирован", () => {
    const r = new VerticalRegistry();
    r.register(tpl("zeta", 1));
    r.register(tpl("alpha", 1));
    r.register(tpl("mu", 1));
    expect(r.list()).toEqual(["alpha", "mu", "zeta"]);
  });
});
