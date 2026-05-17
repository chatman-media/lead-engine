/**
 * Tolerant JSON-object extraction for LLM output.
 *
 * Models rarely return a clean JSON object: they wrap it in markdown code
 * fences, prepend `<think>...</think>` reasoning, or surround it with prose.
 * `extractJsonObject` strips all of that and returns the first parseable
 * object — or `null` when nothing usable is found.
 *
 * Callers keep their own domain-specific normalization and last-resort
 * regex fallback; this only handles the generic strip-and-parse step that
 * was previously duplicated across coach / judge / pairwise / classifier.
 */

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

/**
 * Strip think-tags and code fences, then return the first JSON object found
 * — either the whole payload or the outermost `{...}` block embedded in it.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  const direct = tryParseObject(stripped);
  if (direct) return direct;

  // Fall back to the outermost { ... } block — handles leading prefixes
  // ("Ответ:", "Result:") and trailing commentary around the object.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseObject(stripped.slice(start, end + 1));
  }
  return null;
}
