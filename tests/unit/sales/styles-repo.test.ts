import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { seedBuiltinStyles, StylesRepo } from "@/db/repos/styles.ts";
import { openDb } from "@/db/sqlite.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";

let db: ReturnType<typeof openDb>;
let repo: StylesRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:", embeddingDim: 1536 });
  repo = new StylesRepo(db);
});
afterEach(() => db.close());

describe("StylesRepo — insert/read", () => {
  test("insert creates a row and bySlug returns it", () => {
    const row = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.is_active).toBe(1);
    expect(row.version).toBe(1);

    const found = repo.bySlug(flirtyBelfort.slug);
    expect(found?.id).toBe(row.id);
  });

  test("byId returns the row", () => {
    const row = repo.insert({
      slug: empatheticNepq.slug,
      displayName: empatheticNepq.displayName,
      config: empatheticNepq,
    });
    expect(repo.byId(row.id)?.slug).toBe(empatheticNepq.slug);
  });

  test("byId returns null for unknown id", () => {
    expect(repo.byId(999)).toBeNull();
  });

  test("bySlug returns null for unknown slug", () => {
    expect(repo.bySlug("does-not-exist")).toBeNull();
  });

  test("duplicate slug throws (UNIQUE constraint)", () => {
    repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(() =>
      repo.insert({
        slug: flirtyBelfort.slug,
        displayName: "duplicate",
        config: flirtyBelfort,
      }),
    ).toThrow();
  });
});

describe("StylesRepo — parseRow", () => {
  test("round-trips a Style through JSON ↔ Zod", () => {
    const inserted = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const parsed = repo.parseRow(inserted);
    expect(parsed.slug).toBe(flirtyBelfort.slug);
    expect(parsed.persona.name).toBe(flirtyBelfort.persona.name);
    expect(parsed.framework).toBe(flirtyBelfort.framework);
    expect(parsed.hooks).toEqual(flirtyBelfort.hooks);
  });

  test("throws helpful error on invalid JSON", () => {
    db.run(
      `INSERT INTO styles (slug, display_name, config_json) VALUES (?, ?, ?)`,
      ["broken", "Broken", "{not valid json"],
    );
    const row = repo.bySlug("broken")!;
    expect(() => repo.parseRow(row)).toThrow(/not valid JSON/);
  });

  test("throws on schema mismatch (e.g. invalid framework)", () => {
    db.run(
      `INSERT INTO styles (slug, display_name, config_json) VALUES (?, ?, ?)`,
      ["bad-framework", "Bad", JSON.stringify({ ...flirtyBelfort, framework: "MADEUP" })],
    );
    const row = repo.bySlug("bad-framework")!;
    expect(() => repo.parseRow(row)).toThrow(/StyleSchema/);
  });
});

describe("StylesRepo — listActive + deactivate", () => {
  test("listActive omits soft-deleted rows", () => {
    const a = repo.insert({ slug: "a-style", displayName: "A", config: flirtyBelfort });
    repo.insert({ slug: "b-style", displayName: "B", config: empatheticNepq });
    expect(repo.listActive().length).toBe(2);

    expect(repo.deactivate(a.id)).toBe(true);
    const active = repo.listActive();
    expect(active.length).toBe(1);
    expect(active.map((r) => r.slug)).not.toContain("a-style");
  });

  test("bySlug skips inactive rows", () => {
    const row = repo.insert({
      slug: "deactivated",
      displayName: "X",
      config: flirtyBelfort,
    });
    repo.deactivate(row.id);
    expect(repo.bySlug("deactivated")).toBeNull();
  });

  test("byId still returns inactive rows (so live conversations can read them)", () => {
    const row = repo.insert({
      slug: "deactivated2",
      displayName: "X",
      config: flirtyBelfort,
    });
    repo.deactivate(row.id);
    expect(repo.byId(row.id)?.is_active).toBe(0);
  });
});

describe("seedBuiltinStyles", () => {
  test("first call inserts all builtins, subsequent call is a no-op", () => {
    const first = seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq, coldDirectPas]);
    expect(first.inserted.length).toBe(3);
    expect(first.skipped.length).toBe(0);

    const second = seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq, coldDirectPas]);
    expect(second.inserted.length).toBe(0);
    expect(second.skipped.length).toBe(3);
  });

  test("admin edits in DB are preserved across re-seeds (no overwrite)", () => {
    repo.insert({
      slug: flirtyBelfort.slug,
      displayName: "ADMIN-EDITED NAME",
      config: { ...flirtyBelfort, displayName: "ADMIN-EDITED NAME" },
    });
    seedBuiltinStyles(repo, [flirtyBelfort]);
    expect(repo.bySlug(flirtyBelfort.slug)?.display_name).toBe("ADMIN-EDITED NAME");
  });

  test("only inserts builtins missing from DB", () => {
    repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const result = seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq]);
    expect(result.inserted).toEqual([empatheticNepq.slug]);
    expect(result.skipped).toEqual([flirtyBelfort.slug]);
  });
});
