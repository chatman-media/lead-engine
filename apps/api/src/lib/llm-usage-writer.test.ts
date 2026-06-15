// Unit tests для LlmUsageWriter — batching / flush / stop поведение.
// Не дёргает реальный DB; мокаем `insert().values()` через fake `db`.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { LlmUsageWriter } from "./llm-usage-writer.ts";

interface FakeInsert {
  callCount: number;
  lastValues: unknown[];
  insertCalls: unknown[][];
}

function makeFakeDb(): { db: unknown; tracker: FakeInsert } {
  const tracker: FakeInsert = { callCount: 0, lastValues: [], insertCalls: [] };
  const fakeTx = {
    execute: async () => undefined, // для SET LOCAL app.tenant_id
    insert: () => ({
      values: (rows: unknown[]) => {
        tracker.callCount++;
        tracker.lastValues = rows;
        tracker.insertCalls.push(rows);
        return Promise.resolve();
      },
    }),
  };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
    execute: async () => undefined,
  };
  return { db, tracker };
}

describe("LlmUsageWriter", () => {
  let writer: LlmUsageWriter;
  let tracker: FakeInsert;

  beforeEach(() => {
    const fake = makeFakeDb();
    tracker = fake.tracker;
    writer = new LlmUsageWriter({
      // biome-ignore lint/suspicious/noExplicitAny: fake db structurally similar
      db: fake.db as any,
      flushIntervalMs: 0, // disable timer для deterministic tests
      maxBufferSize: 3,
    });
  });

  afterEach(async () => {
    await writer.stop();
  });

  it("record adds to buffer (size grows)", () => {
    writer.record(1, {
      purpose: "chat",
      provider: "openai",
      latencyMs: 100,
      success: true,
    });
    expect(writer.bufferSize()).toBe(1);
    writer.record(1, {
      purpose: "embed",
      provider: "openai",
      latencyMs: 50,
      success: true,
    });
    expect(writer.bufferSize()).toBe(2);
  });

  it("flush() empties buffer and writes per-tenant batch", async () => {
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    writer.record(1, { purpose: "embed", provider: "openai", latencyMs: 50, success: true });
    writer.record(2, { purpose: "chat", provider: "anthropic", latencyMs: 200, success: false, errorKind: "Timeout" });

    await writer.flush();

    expect(writer.bufferSize()).toBe(0);
    expect(tracker.callCount).toBe(2); // одна batch INSERT per tenant
    // tenant 1 has 2 events
    const tenant1Call = tracker.insertCalls.find((rows) => (rows as Array<{ tenantId: number }>)[0]?.tenantId === 1);
    expect(tenant1Call).toHaveLength(2);
    // tenant 2 has 1 event
    const tenant2Call = tracker.insertCalls.find((rows) => (rows as Array<{ tenantId: number }>)[0]?.tenantId === 2);
    expect(tenant2Call).toHaveLength(1);
  });

  it("overflow trigger immediate flush via Promise.resolve", async () => {
    // maxBufferSize = 3
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 110, success: true });
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 120, success: true });
    // overflow на 3-м.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.callCount).toBe(1);
  });

  it("error event captures errorKind", async () => {
    writer.record(5, {
      purpose: "chat",
      provider: "openai",
      latencyMs: 500,
      success: false,
      errorKind: "ChatTruncatedError",
    });
    await writer.flush();
    const rows = tracker.insertCalls[0] as Array<{ errorKind: string | null; success: boolean }>;
    expect(rows[0]?.errorKind).toBe("ChatTruncatedError");
    expect(rows[0]?.success).toBe(false);
  });

  it("persists prompt/completion tokens when provided", async () => {
    writer.record(7, {
      purpose: "chat",
      provider: "openai",
      latencyMs: 300,
      success: true,
      promptTokens: 1234,
      completionTokens: 56,
    });
    await writer.flush();
    const rows = tracker.insertCalls[0] as Array<{
      promptTokens: number | null;
      completionTokens: number | null;
    }>;
    expect(rows[0]?.promptTokens).toBe(1234);
    expect(rows[0]?.completionTokens).toBe(56);
  });

  it("token columns default to null when usage absent", async () => {
    writer.record(8, { purpose: "embed", provider: "openai", latencyMs: 40, success: true });
    await writer.flush();
    const rows = tracker.insertCalls[0] as Array<{
      promptTokens: number | null;
      completionTokens: number | null;
    }>;
    expect(rows[0]?.promptTokens).toBeNull();
    expect(rows[0]?.completionTokens).toBeNull();
  });

  it("after stop(), record() is no-op", async () => {
    await writer.stop();
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    expect(writer.bufferSize()).toBe(0);
  });

  it("model field passes through", async () => {
    writer.record(1, {
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      latencyMs: 100,
      success: true,
    });
    await writer.flush();
    const rows = tracker.insertCalls[0] as Array<{ model: string | null }>;
    expect(rows[0]?.model).toBe("gpt-4o-mini");
  });

  it("missing model → null in row", async () => {
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    await writer.flush();
    const rows = tracker.insertCalls[0] as Array<{ model: string | null }>;
    expect(rows[0]?.model).toBeNull();
  });

  it("flush idempotent — second call без events не writes", async () => {
    writer.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    await writer.flush();
    expect(tracker.callCount).toBe(1);
    await writer.flush();
    expect(tracker.callCount).toBe(1); // no second insert
  });

  it("DB failure → onError called, events dropped, writer keeps working", async () => {
    const errorHook = mock<(err: unknown, dropped: number) => void>(() => {});
    // Simulate DB failure: replace insert chain to throw.
    const failingDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => undefined,
          insert: () => ({
            values: () => Promise.reject(new Error("connection lost")),
          }),
        }),
      execute: async () => undefined,
    };
    const failingWriter = new LlmUsageWriter({
      // biome-ignore lint/suspicious/noExplicitAny: fake db
      db: failingDb as any,
      flushIntervalMs: 0,
      onError: errorHook,
    });
    failingWriter.record(1, { purpose: "chat", provider: "openai", latencyMs: 100, success: true });
    await failingWriter.flush();
    expect(errorHook).toHaveBeenCalled();
    expect(failingWriter.bufferSize()).toBe(0); // event dropped
    await failingWriter.stop();
  });
});
