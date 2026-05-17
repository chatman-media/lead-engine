import { z } from "zod";

/**
 * Injects a JSON output instruction into the system prompt when native
 * structured output is not available (Ollama, OpenRouter, etc.).
 */
export function injectJsonInstruction(
  systemPrompt: string,
  jsonSchema: Record<string, unknown>,
): string {
  const schemaStr = JSON.stringify(jsonSchema, null, 2);
  return `${systemPrompt}\n\nRespond with a single valid JSON object matching this schema. Do not include markdown, code fences, or any text outside the JSON.\nSchema:\n${schemaStr}`;
}

/**
 * Parses and validates an LLM response against a Zod schema.
 * Strips markdown code fences if present before parsing.
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 */
export function parseStructuredOutput<T extends z.ZodTypeAny>(
  raw: string,
  schema: T,
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { success: false, error: `JSON parse failed: ${cleaned.slice(0, 200)}` };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true, data: result.data as z.infer<T> };
}

/** Converts a Zod schema to a JSON Schema object for OpenAI's response_format. */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
