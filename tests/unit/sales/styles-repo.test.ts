import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let repo: StylesRepo;

beforeEach(() => {
  repo = new StylesRepo(sql);
});

describe("StylesRepo — insert/read", () => {
  test("insert creates a row and bySlug returns it", async () => {
    const row = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.is_active).toBe(true);
    expect(row.version).toBe(1);

    const found = await repo.bySlug(flirtyBelfort.slug);
    expect(found?.id).toBe(row.id);
  });

  test("byId returns the row", async () => {
    const row = await repo.insert({
      slug: empatheticNepq.slug,
      displayName: empatheticNepq.displayName,
      config: empatheticNepq,
    });
    expect((await repo.byId(row.id))?.slug).toBe(empatheticNepq.slug);
  });

  test("byId returns null for unknown id", async () => {
    expect(await repo.byId(999)).toBeNull();
  });

  test("bySlug returns null for unknown slug", async () => {
    expect(await repo.bySlug("does-not-exist")).toBeNull();
  });

  test("duplicate slug throws (UNIQUE constraint)", async () => {
    await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    await expect(
      repo.insert({
        slug: flirtyBelfort.slug,
        displayName: "duplicate",
        config: flirtyBelfort,
      }),
    ).rejects.toThrow();
  });
});

describe("StylesRepo — parseRow", () => {
  test("round-trips a Style through JSON ↔ Zod", async () => {
    const inserted = await repo.insert({
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

  test("throws helpful error on invalid JSON", async () => {
    await sql`INSERT INTO styles (slug, display_name, config_json) VALUES ('broken', 'Broken', '{not valid json')`;
    const row = (await repo.bySlug("broken"))!;
    expect(() => repo.parseRow(row)).toThrow(/not valid JSON/);
  });

  test("throws on schema mismatch (e.g. invalid framework)", async () => {
    await sql`INSERT INTO styles (slug, display_name, config_json) VALUES ('bad-framework', 'Bad', ${JSON.stringify({ ...flirtyBelfort, framework: "MADEUP" })})`;
    const row = (await repo.bySlug("bad-framework"))!;
    expect(() => repo.parseRow(row)).toThrow(/StyleSchema/);
  });
});

describe("StylesRepo — listActive + deactivate", () => {
  test("listActive omits soft-deleted rows", async () => {
    const a = await repo.insert({ slug: "a-style", displayName: "A", config: flirtyBelfort });
    await repo.insert({ slug: "b-style", displayName: "B", config: empatheticNepq });
    expect((await repo.listActive()).length).toBe(2);

    expect(await repo.deactivate(a.id)).toBe(true);
    const active = await repo.listActive();
    expect(active.length).toBe(1);
    expect(active.map((r) => r.slug)).not.toContain("a-style");
  });

  test("bySlug skips inactive rows", async () => {
    const row = await repo.insert({
      slug: "deactivated",
      displayName: "X",
      config: flirtyBelfort,
    });
    await repo.deactivate(row.id);
    expect(await repo.bySlug("deactivated")).toBeNull();
  });

  test("byId still returns inactive rows (so live conversations can read them)", async () => {
    const row = await repo.insert({
      slug: "deactivated2",
      displayName: "X",
      config: flirtyBelfort,
    });
    await repo.deactivate(row.id);
    expect((await repo.byId(row.id))?.is_active).toBe(false);
  });
});

describe("StylesRepo — editAsNewVersion (versioning)", () => {
  test("creates a new version, deactivates the old one", async () => {
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    expect(v1.is_active).toBe(true);
    expect(v1.version).toBe(1);

    const newConfig = { ...flirtyBelfort, displayName: "Алина — edited" };
    const v2 = await repo.editAsNewVersion(v1.id, newConfig);

    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe(2);
    expect(v2.parent_id).toBe(v1.id);
    expect(v2.is_active).toBe(true);
    expect(v2.display_name).toBe("Алина — edited");

    const v1Reloaded = (await repo.byId(v1.id))!;
    expect(v1Reloaded.is_active).toBe(false);
  });

  test("bySlug after edit returns the new active version", async () => {
    const v1 = await repo.insert({
      slug: empatheticNepq.slug,
      displayName: empatheticNepq.displayName,
      config: empatheticNepq,
    });
    await repo.editAsNewVersion(v1.id, { ...empatheticNepq, displayName: "Маша v2" });

    const active = (await repo.bySlug(empatheticNepq.slug))!;
    expect(active.version).toBe(2);
    expect(active.display_name).toBe("Маша v2");
  });

  test("byId still returns the old version (so live conversations keep working)", async () => {
    const v1 = await repo.insert({
      slug: coldDirectPas.slug,
      displayName: coldDirectPas.displayName,
      config: coldDirectPas,
    });
    await repo.editAsNewVersion(v1.id, { ...coldDirectPas, displayName: "edited" });

    // A conversation pinned to v1.id pre-edit should still be able to read it.
    const old = (await repo.byId(v1.id))!;
    expect(old.id).toBe(v1.id);
    expect(old.is_active).toBe(false);
    expect(old.display_name).toBe(coldDirectPas.displayName); // original
    // And parsing it should still produce a valid Style.
    expect(() => repo.parseRow(old)).not.toThrow();
  });

  test("refuses to edit an already-inactive (historical) row", async () => {
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    await repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });

    await expect(
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "from-history" }),
    ).rejects.toThrow(/not active/);
  });

  test("refuses to change slug across the version chain", async () => {
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    await expect(
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, slug: "different-slug" }),
    ).rejects.toThrow(/slug mismatch/);
  });

  test("404-style throw on unknown id", async () => {
    await expect(repo.editAsNewVersion(9999, flirtyBelfort)).rejects.toThrow(/not found/);
  });

  test("multiple edits chain by parent_id", async () => {
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const v2 = await repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });
    const v3 = await repo.editAsNewVersion(v2.id, { ...flirtyBelfort, displayName: "v3" });

    expect(v2.parent_id).toBe(v1.id);
    expect(v3.parent_id).toBe(v2.id);
    expect(v3.version).toBe(3);

    // Only v3 is active.
    expect((await repo.bySlug(flirtyBelfort.slug))?.id).toBe(v3.id);
    expect((await repo.byId(v1.id))?.is_active).toBe(false);
    expect((await repo.byId(v2.id))?.is_active).toBe(false);
  });

  test("transactional — failure during INSERT does not leave the old row deactivated", async () => {
    // Force a UNIQUE(slug, version) collision: insert a row at version 2
    // pre-emptively, then try to edit v1 → would also become v2 → conflict.
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    // Manually inject a v2 with same slug at version 2.
    await sql`
      INSERT INTO styles (slug, display_name, config_json, is_active, version, parent_id)
      VALUES (${flirtyBelfort.slug}, 'shadow v2', ${JSON.stringify(flirtyBelfort)}, FALSE, 2, ${v1.id})
    `;

    await expect(
      repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "should-fail" }),
    ).rejects.toThrow();

    // Rollback should leave v1 still active.
    expect((await repo.byId(v1.id))?.is_active).toBe(true);
  });
});

describe("StylesRepo — versionHistory", () => {
  test("returns all versions of a slug oldest-first", async () => {
    const v1 = await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const v2 = await repo.editAsNewVersion(v1.id, { ...flirtyBelfort, displayName: "v2" });
    const v3 = await repo.editAsNewVersion(v2.id, { ...flirtyBelfort, displayName: "v3" });

    const history = await repo.versionHistory(flirtyBelfort.slug);
    expect(history.map((r) => r.id)).toEqual([v1.id, v2.id, v3.id]);
    expect(history.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(history.map((r) => r.is_active)).toEqual([false, false, true]);
  });

  test("empty array for unknown slug", async () => {
    expect(await repo.versionHistory("does-not-exist")).toEqual([]);
  });
});

describe("seedBuiltinStyles", () => {
  test("first call inserts all builtins, subsequent call is a no-op", async () => {
    const first = await seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq, coldDirectPas]);
    expect(first.inserted.length).toBe(3);
    expect(first.skipped.length).toBe(0);

    const second = await seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq, coldDirectPas]);
    expect(second.inserted.length).toBe(0);
    expect(second.skipped.length).toBe(3);
  });

  test("admin edits in DB are preserved across re-seeds (no overwrite)", async () => {
    await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: "ADMIN-EDITED NAME",
      config: { ...flirtyBelfort, displayName: "ADMIN-EDITED NAME" },
    });
    await seedBuiltinStyles(repo, [flirtyBelfort]);
    expect((await repo.bySlug(flirtyBelfort.slug))?.display_name).toBe("ADMIN-EDITED NAME");
  });

  test("only inserts builtins missing from DB", async () => {
    await repo.insert({
      slug: flirtyBelfort.slug,
      displayName: flirtyBelfort.displayName,
      config: flirtyBelfort,
    });
    const result = await seedBuiltinStyles(repo, [flirtyBelfort, empatheticNepq]);
    expect(result.inserted).toEqual([empatheticNepq.slug]);
    expect(result.skipped).toEqual([flirtyBelfort.slug]);
  });
});
