import { describe, expect, test } from "bun:test";
import { parseSlugList } from "../src/grade-skills.ts";

const allowed = ["social-proof-stat", "mirroring", "scarcity-spots-left"];

describe("parseSlugList", () => {
  test("parses a bare JSON array", () => {
    expect(parseSlugList('["mirroring","social-proof-stat"]', allowed)).toEqual([
      "mirroring",
      "social-proof-stat",
    ]);
  });

  test("parses a code-fenced JSON array", () => {
    expect(parseSlugList('```json\n["mirroring"]\n```', allowed)).toEqual(["mirroring"]);
  });

  test("parses a comma/newline-separated plain-text list", () => {
    expect(parseSlugList("mirroring, scarcity-spots-left", allowed)).toEqual([
      "mirroring",
      "scarcity-spots-left",
    ]);
    expect(parseSlugList("mirroring\nscarcity-spots-left", allowed)).toEqual([
      "mirroring",
      "scarcity-spots-left",
    ]);
  });

  test("filters out slugs not in the allowed list", () => {
    expect(parseSlugList('["mirroring","not-a-real-skill"]', allowed)).toEqual(["mirroring"]);
  });

  test("returns an empty array for empty input", () => {
    expect(parseSlugList("", allowed)).toEqual([]);
  });

  test("returns an empty array for an empty JSON array", () => {
    expect(parseSlugList("[]", allowed)).toEqual([]);
  });

  test("drops non-string elements from the JSON array", () => {
    expect(parseSlugList('["mirroring", 42, null]', allowed)).toEqual(["mirroring"]);
  });

  test("returns an empty array when nothing matches the allowed list", () => {
    expect(parseSlugList("some random commentary", allowed)).toEqual([]);
  });
});
