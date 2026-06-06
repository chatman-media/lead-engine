// Guards the few-shot examples embedded in the AI-builder SYSTEM_PROMPT:
// every funnel we teach the model must itself be a VALID funnel — i.e. pass
// normalizeStages → validateFunnel (backbone + multi-request branch contract).
// If an example drifts into an invalid shape, we'd be teaching the LLM to emit
// broken funnels; this test fails loudly instead.

import { describe, expect, it } from "bun:test";
import {
  normalizeStages,
  type StageDraft,
  SYSTEM_PROMPT,
  validateFunnel,
} from "./admin-workflow.ts";

/** Extract each JSON object that starts at `{"reply":` and is a ready funnel. */
function extractFunnelExamples(prompt: string): Array<{ stages: StageDraft[] }> {
  const out: Array<{ stages: StageDraft[] }> = [];
  let idx = 0;
  while (true) {
    const start = prompt.indexOf('{"reply":', idx);
    if (start === -1) break;
    // brace-match from start to the matching close brace
    let depth = 0;
    let end = -1;
    for (let i = start; i < prompt.length; i++) {
      const ch = prompt[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    idx = end + 1;
    const block = prompt.slice(start, end + 1);
    if (!block.includes('"readyToGenerate":true')) continue;
    const parsed = JSON.parse(block) as { stages?: StageDraft[] };
    if (Array.isArray(parsed.stages)) out.push({ stages: parsed.stages });
  }
  return out;
}

describe("AI-builder few-shot examples in SYSTEM_PROMPT", () => {
  const examples = extractFunnelExamples(SYSTEM_PROMPT);

  it("contains at least a linear and a branching example", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  it("every embedded example is a valid funnel", () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      const stages = normalizeStages(ex.stages);
      const { errors } = validateFunnel(stages);
      expect(errors, `example errors: ${errors.join("; ")}`).toEqual([]);
    }
  });
});
