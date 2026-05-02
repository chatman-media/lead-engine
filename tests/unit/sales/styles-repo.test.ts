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

describe("StylesRepo — editAsNewVersion (versioning)", () => {
  test("creates a new version, deactivates the old one", () => {
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(v1.is_active).toBe(1);
    expect(v1.version).toBe(1);

    const newConfig = { ...flirtyBelfort, displayName: "Алина — edited" };
    const v2 = repo.editAsNewVersion(v1.id, newConfig);

    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe(2);
    expect(v2.parent_id).toBe(v1.id);
    expect(v2.is_active).toBe(1);
    expect(v2.display_name).toBe("Алина — edited");

    const v1Reloaded = repo.byId(v1.id)!;
    expect(v1Reloaded.is_active).toBe(0);
  });

  test("bySlug after edit returns the new active version", () => {
    const v1 = repo.insert({
      slug: empatheticNepq.slug,
      displayName: empatheticNepq.displayName,
      config: empatheticNepq,
    });
    repo.editAsNewVersion(v1.id, { ...empatheticNepq, displayName: "Маша v2" });

    const active = repo.bySlug(empatheticNepq.slug)!;
    expect(active.version).toBe(2);
    expect(active.display_name).toBe("Маша v2");
  });

  test("byId still returns the old version (so live conversations keep working)", () => {
    const v1 = repo.insert({
      slug: coldDirectPas.slug,
      displayName: coldDirectPas.displayName,
      config: coldDirectPas,
    });
    repo.editAsNewVersion(v1.id, { ...coldDirectPas, displayName: "edited" });

    // A conversation pinned to v1.id pre-edit should still be able to read it.
    const old = repo.byId(v1.id)!;
    expect(old.id).toBe(v1.id);
    expect(old.is_active).toBe(0);
    expect(old.display_name).toBe(coldDirectPas.displayName); // original
    // And parsing it should still produce a valid Style.
    expect(() => repo.parseRow(old)).not.toThrow();
  });

  test("refuses to edit an already-inactive (historical) row", () => {
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });

    expect(() =>
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "from-history" }),
    ).toThrow(/not active/);
  });

  test("refuses to change slug across the version chain", () => {
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(() =>
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, slug: "different-slug" }),
    ).toThrow(/slug mismatch/);
  });

  test("404-style throw on unknown id", () => {
    expect(() => repo.editAsNewVersion(9999, flirtyBelfort)).toThrow(/not found/);
  });

  test("multiple edits chain by parent_id", () => {
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const v2 = repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });
    const v3 = repo.editAsNewVersion(v2.id, { ...flirtyBelfort, displayName: "v3" });

    expect(v2.parent_id).toBe(v1.id);
    expect(v3.parent_id).toBe(v2.id);
    expect(v3.version).toBe(3);

    // Only v3 is active.
    expect(repo.bySlug(flirtyBelfort.slug)?.id).toBe(v3.id);
    expect(repo.byId(v1.id)?.is_active).toBe(0);
    expect(repo.byId(v2.id)?.is_active).toBe(0);
  });

  test("transactional — failure during INSERT does not leave the old row deactivated", () => {
    // Force a UNIQUE(slug, version) collision: insert a row at version 2
    // pre-emptively, then try to edit v1 → would also become v2 → conflict.
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    // Manually inject a v2 with same slug at version 2.
    db.run(
      `INSERT INTO styles (slug, display_name, config_json, is_active, version, parent_id)
       VALUES (?, ?, ?, 0, 2, ?)`,
      [flirtyBelfort.slug, "shadow v2", JSON.stringify(flirtyBelfort), v1.id],
    );

    expect(() =>
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "should-fail" }),
    ).toThrow();

    // Rollback should leave v1 still active.
    expect(repo.byId(v1.id)?.is_active).toBe(1);
  });
});

describe("StylesRepo — versionHistory", () => {
  test("returns all versions of a slug oldest-first", () => {
    const v1 = repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const v2 = repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });
    const v3 = repo.editAsNewVersion(v2.id, { ...flirtyBelfort, displayName: "v3" });

    const history = repo.versionHistory(flirtyBelfort.slug);
    expect(history.map((r) => r.id)).toEqual([v1.id, v2.id, v3.id]);
    expect(history.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(history.map((r) => r.is_active)).toEqual([0, 0, 1]);
  });

  test("empty array for unknown slug", () => {
    expect(repo.versionHistory("does-not-exist")).toEqual([]);
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
