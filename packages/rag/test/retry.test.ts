import { describe, expect, test } from "bun:test";
import { ChatApiError, type ChatClient } from "../src/chat.ts";
import { EmbeddingApiError, type EmbeddingClient } from "../src/embed.ts";
import { withRetryChatClient, withRetryEmbeddingClient } from "../src/retry.ts";

const FAST = { initialDelayMs: 1, maxDelayMs: 5 };

class FlakyChatClient implements ChatClient {
  calls = 0;
  constructor(
    private readonly failures: number,
    private readonly statusCode = 503,
  ) {}

  async complete(): Promise<string> {
    this.calls++;
    if (this.calls <= this.failures) {
      throw new ChatApiError(this.statusCode, "transient failure");
    }
    return "completed";
  }
}

class FlakyEmbeddingClient implements EmbeddingClient {
  calls = 0;
  readonly dim = 4;
  constructor(private readonly failures: number) {}

  async embed(): Promise<number[][]> {
    this.calls++;
    if (this.calls <= this.failures) {
      throw new EmbeddingApiError(429, "rate limited");
    }
    return [[0, 0, 0, 0]];
  }
}

describe("withRetryChatClient", () => {
  test("returns the result on the first successful attempt", async () => {
    const client = new FlakyChatClient(0);
    const wrapped = withRetryChatClient(client, FAST);
    expect(await wrapped.complete([])).toBe("completed");
    expect(client.calls).toBe(1);
  });

  test("retries on transient errors then succeeds", async () => {
    const client = new FlakyChatClient(2, 503);
    const wrapped = withRetryChatClient(client, { ...FAST, maxAttempts: 3 });
    expect(await wrapped.complete([])).toBe("completed");
    expect(client.calls).toBe(3);
  });

  test("does not retry non-retryable errors", async () => {
    const client = new FlakyChatClient(1, 400);
    const wrapped = withRetryChatClient(client, FAST);
    await expect(wrapped.complete([])).rejects.toThrow(ChatApiError);
    expect(client.calls).toBe(1);
  });

  test("throws the last error after exhausting attempts", async () => {
    const client = new FlakyChatClient(10, 503);
    const wrapped = withRetryChatClient(client, { ...FAST, maxAttempts: 3 });
    await expect(wrapped.complete([])).rejects.toThrow(ChatApiError);
    expect(client.calls).toBe(3);
  });
});

describe("withRetryEmbeddingClient", () => {
  test("preserves the embedding dimension", () => {
    const wrapped = withRetryEmbeddingClient(new FlakyEmbeddingClient(0), FAST);
    expect(wrapped.dim).toBe(4);
  });

  test("retries transient errors then succeeds", async () => {
    const client = new FlakyEmbeddingClient(1);
    const wrapped = withRetryEmbeddingClient(client, { ...FAST, maxAttempts: 3 });
    expect(await wrapped.embed(["x"])).toEqual([[0, 0, 0, 0]]);
    expect(client.calls).toBe(2);
  });
});
