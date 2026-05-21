import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  injectJsonInstruction,
  parseStructuredOutput,
  zodToJsonSchema,
} from "../src/structured-output.ts";

const schema = z.object({ name: z.string(), age: z.number() });

describe("parseStructuredOutput", () => {
  test("parses and validates a plain JSON object", () => {
    const result = parseStructuredOutput('{"name":"Ann","age":3}', schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Ann", age: 3 });
    }
  });

  test("strips markdown code fences before parsing", () => {
    const result = parseStructuredOutput('```json\n{"name":"Ann","age":3}\n```', schema);
    expect(result.success).toBe(true);
  });

  test("fails on invalid JSON", () => {
    const result = parseStructuredOutput("not json at all", schema);
    expect(result.success).toBe(false);
  });

  test("fails when the JSON does not match the schema", () => {
    const result = parseStructuredOutput('{"name":"Ann"}', schema);
    expect(result.success).toBe(false);
  });
});

describe("injectJsonInstruction", () => {
  test("appends the schema instruction to the system prompt", () => {
    const out = injectJsonInstruction("system prompt", { type: "object" });
    expect(out).toContain("system prompt");
    expect(out).toContain("Schema:");
    expect(out).toContain('"type": "object"');
  });
});

describe("zodToJsonSchema", () => {
  test("converts a Zod schema to a JSON Schema object", () => {
    const json = zodToJsonSchema(schema);
    expect(json.type).toBe("object");
  });
});
