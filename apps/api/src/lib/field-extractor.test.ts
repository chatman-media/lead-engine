/**
 * Unit tests for makeFieldExtractor — early-exit paths that don't require DB.
 * DB-dependent paths (field writing, auto-advance) are covered by the
 * admin-leads integration test via the PUT /api/admin/leads/:id/field-values endpoint.
 */

import { describe, expect, it } from "bun:test";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { makeFieldExtractor } from "./field-extractor.ts";

function makeRef(overrides: {
  resolveChatImpl?: (tenantId: number) => ChatClient | null;
  shouldThrow?: boolean;
}): LoadedRef {
  return {
    router: {
      resolveChat(tenantId: number) {
        if (overrides.shouldThrow) throw new Error("no chat config");
        return overrides.resolveChatImpl?.(tenantId) ?? null;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
}

function makeDb() {
  // Minimal stub — withTenant should never be reached in these tests.
  return {
    transaction: () => { throw new Error("DB should not be reached"); },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
}

describe("makeFieldExtractor — early exits", () => {
  it("resolves silently when resolveChat throws (no chat LLM configured)", async () => {
    const extractor = makeFieldExtractor(makeRef({ shouldThrow: true }));
    await expect(
      extractor.extract({ tenantId: 1, contactId: 1, text: "hello", db: makeDb() }),
    ).resolves.toBeUndefined();
  });

  it("resolves silently when resolveChat returns null", async () => {
    const extractor = makeFieldExtractor(makeRef({ resolveChatImpl: () => null }));
    await expect(
      extractor.extract({ tenantId: 1, contactId: 1, text: "hello", db: makeDb() }),
    ).resolves.toBeUndefined();
  });

  it("resolves silently when text is empty (caller responsibility, but robust)", async () => {
    // resolveChat throws to stop before DB — we just confirm no crash on empty text
    const extractor = makeFieldExtractor(makeRef({ shouldThrow: true }));
    await expect(
      extractor.extract({ tenantId: 1, contactId: 1, text: "", db: makeDb() }),
    ).resolves.toBeUndefined();
  });
});

