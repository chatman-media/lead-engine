import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { SkillsRepo, seedSkillCatalogue } from "@/db/repos/skills.ts";
import { StylesRepo } from "@/db/repos/styles.ts";
import { composeSystemPrompt } from "@/sales/prompt.ts";
import { SKILL_BY_SLUG, SKILL_CATALOGUE, SkillSchema } from "@/sales/skills/catalogue.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let skills: SkillsRepo;
let styles: StylesRepo;

beforeEach(() => {
  skills = new SkillsRepo(sql);
  styles = new StylesRepo(sql);
});

describe("skill catalogue (source of truth)", () => {
  test("every entry passes SkillSchema", () => {
    for (const s of SKILL_CATALOGUE) {
      expect(() => SkillSchema.parse(s)).not.toThrow();
    }
  });

  test("slugs are unique across the catalogue", () => {
    expect(SKILL_BY_SLUG.size).toBe(SKILL_CATALOGUE.length);
  });

  test("contains 20+ research-backed skills covering all families", () => {
    expect(SKILL_CATALOGUE.length).toBeGreaterThanOrEqual(20);
    const families = new Set(SKILL_CATALOGUE.map((s) => s.family));
    for (const fam of ["cialdini", "voss", "nlp", "sales", "custom"]) {
      expect(families.has(fam as never)).toBe(true);
    }
  });
});

describe("seedSkillCatalogue", () => {
  test("first call inserts all entries; second is idempotent", async () => {
    const r1 = await seedSkillCatalogue(skills);
    expect(r1.inserted).toBe(SKILL_CATALOGUE.length);
    expect(r1.updated).toBe(0);
    expect((await skills.list()).length).toBe(SKILL_CATALOGUE.length);

    const r2 = await seedSkillCatalogue(skills);
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(SKILL_CATALOGUE.length);
    expect((await skills.list()).length).toBe(SKILL_CATALOGUE.length);
  });

  test("upsert refreshes display_name + prompt fragment but preserves is_enabled", async () => {
    const initial = SKILL_CATALOGUE[0]!;
    await skills.upsert(initial);
    const row = (await skills.bySlug(initial.slug))!;
    await skills.setEnabled(row.id, false);
    expect((await skills.bySlug(initial.slug))!.is_enabled).toBe(false);

    // Re-upsert with mutated copy (simulates an edit in catalogue.ts).
    await skills.upsert({ ...initial, displayName: "Renamed thing" });
    const after = (await skills.bySlug(initial.slug))!;
    expect(after.display_name).toBe("Renamed thing");
    // Operator's disable choice survives the seeder pass.
    expect(after.is_enabled).toBe(false);
  });
});

describe("style ↔ skill membership", () => {
  test("setSkillsForStyle attaches subset; skillsForStyle returns them", async () => {
    await seedSkillCatalogue(skills);
    await styles.upsertBuiltin(flirtyBelfort);
    const style = (await styles.bySlug(flirtyBelfort.slug))!;
    expect(style.id).toBeGreaterThan(0);

    const slugs = ["social-proof-stat", "scarcity-deadline", "tactical-empathy"];
    const r = await skills.setSkillsForStyle(style.id, slugs);
    expect(r.attached).toBe(3);

    const back = (await skills.skillsForStyle(style.id)).map((s) => s.slug).sort();
    expect(back).toEqual(slugs.sort());
  });

  test("setSkillsForStyle replaces (not appends)", async () => {
    await seedSkillCatalogue(skills);
    await styles.upsertBuiltin(flirtyBelfort);
    const style = (await styles.bySlug(flirtyBelfort.slug))!;

    await skills.setSkillsForStyle(style.id, ["social-proof-stat", "scarcity-deadline"]);
    await skills.setSkillsForStyle(style.id, ["tactical-empathy"]);
    const back = (await skills.skillsForStyle(style.id)).map((s) => s.slug);
    expect(back).toEqual(["tactical-empathy"]);
  });

  test("unknown slugs in setSkillsForStyle are silently dropped (repo stays forgiving)", async () => {
    await seedSkillCatalogue(skills);
    await styles.upsertBuiltin(flirtyBelfort);
    const style = (await styles.bySlug(flirtyBelfort.slug))!;
    const r = await skills.setSkillsForStyle(style.id, ["social-proof-stat", "does-not-exist"]);
    expect(r.attached).toBe(1);
    expect((await skills.skillsForStyle(style.id)).map((s) => s.slug)).toEqual([
      "social-proof-stat",
    ]);
  });

  test("attachmentCounts reflects the join", async () => {
    await seedSkillCatalogue(skills);
    await styles.upsertBuiltin(flirtyBelfort);
    const style = (await styles.bySlug(flirtyBelfort.slug))!;
    await skills.setSkillsForStyle(style.id, ["social-proof-stat", "tactical-empathy"]);

    const counts = await skills.attachmentCounts();
    expect(counts.get("social-proof-stat")).toBe(1);
    expect(counts.get("tactical-empathy")).toBe(1);
    expect(counts.get("scarcity-deadline")).toBe(0);
  });
});

describe("composeSystemPrompt with skills", () => {
  test("injects skill prompt fragments under ПРИЁМЫ heading", () => {
    const prompt = composeSystemPrompt(flirtyBelfort, "objection", null, {
      skills: [
        {
          slug: "social-proof-stat",
          displayName: "Social proof — statistic",
          promptFragment: "Use stats to back claims.",
          applicableStages: ["pitch", "objection"],
        },
        {
          slug: "tactical-empathy",
          displayName: "Tactical empathy — label emotion",
          promptFragment: "Name the prospect's emotion before responding.",
          applicableStages: ["objection"],
        },
      ],
    });
    expect(prompt).toContain("ПРИЁМЫ");
    expect(prompt).toContain("Social proof — statistic");
    expect(prompt).toContain("Use stats to back claims.");
    expect(prompt).toContain("Tactical empathy");
  });

  test("filters skills by current stage", () => {
    const prompt = composeSystemPrompt(flirtyBelfort, "opener", null, {
      skills: [
        {
          slug: "social-proof-stat",
          displayName: "Social proof",
          promptFragment: "X",
          applicableStages: ["pitch"], // not opener
        },
        {
          slug: "liking",
          displayName: "Liking",
          promptFragment: "Compliment the prospect.",
          applicableStages: ["opener"],
        },
      ],
    });
    expect(prompt).toContain("Liking");
    expect(prompt).not.toContain("Social proof");
  });

  test("skills with empty applicableStages are always shown", () => {
    const prompt = composeSystemPrompt(flirtyBelfort, "qualify", null, {
      skills: [
        {
          slug: "always-on",
          displayName: "Universal skill",
          promptFragment: "Apply on any stage.",
          applicableStages: [],
        },
      ],
    });
    expect(prompt).toContain("Universal skill");
  });

  test("no skills section when none provided or none match the stage", () => {
    const prompt = composeSystemPrompt(flirtyBelfort, "qualify", null, {});
    expect(prompt).not.toContain("ПРИЁМЫ");
  });
});

describe("parseSlugList (skill grader output parser)", () => {
  test("parses plain JSON array", async () => {
    const { parseSlugList } = await import("@/rag/grade-skills.ts");
    expect(parseSlugList('["a", "b"]', ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  test("strips ```json fences", async () => {
    const { parseSlugList } = await import("@/rag/grade-skills.ts");
    expect(parseSlugList('```json\n["x"]\n```', ["x", "y"])).toEqual(["x"]);
  });

  test("filters out unknown slugs", async () => {
    const { parseSlugList } = await import("@/rag/grade-skills.ts");
    expect(parseSlugList('["a", "ghost"]', ["a", "b"])).toEqual(["a"]);
  });

  test("falls back to comma-split on non-JSON", async () => {
    const { parseSlugList } = await import("@/rag/grade-skills.ts");
    expect(parseSlugList("a, b, c", ["a", "b"])).toEqual(["a", "b"]);
  });

  test("returns empty array on empty / unparseable input", async () => {
    const { parseSlugList } = await import("@/rag/grade-skills.ts");
    expect(parseSlugList("", ["a"])).toEqual([]);
    expect(parseSlugList("nope", ["a"])).toEqual([]);
  });
});
