import { describe, expect, test } from "bun:test";

import { type FetchLike, TelegramApiError, TelegramClient } from "@/telegram/client.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetch(responder: (call: RecordedCall) => unknown): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headersRecord: Record<string, string> = {};
    if (init?.headers) {
      const entries = new Headers(init.headers);
      entries.forEach((v, k) => {
        headersRecord[k] = v;
      });
    }
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      body: bodyText ? JSON.parse(bodyText) : null,
      headers: headersRecord,
    };
    calls.push(call);
    const result = responder(call);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("TelegramClient", () => {
  test("sendMessage POSTs the right URL and body, returns parsed result", async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      expect(call.url).toBe("https://api.telegram.org/botABC/sendMessage");
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/json");
      const body = call.body as { chat_id: number; text: string };
      expect(body.chat_id).toBe(42);
      expect(body.text).toBe("hi");
      return {
        ok: true,
        result: {
          message_id: 7,
          chat: { id: 42, type: "private" },
          date: 1,
          text: "hi",
        },
      };
    });
    const client = new TelegramClient({ token: "ABC", fetch: fetchImpl });
    const res = await client.sendMessage({ chatId: 42, text: "hi" });
    expect(res.message_id).toBe(7);
    expect(calls).toHaveLength(1);
  });

  test("setWebhook includes secret_token and allowed_updates", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, result: true }));
    const client = new TelegramClient({ token: "T", fetch: fetchImpl });
    await client.setWebhook({
      url: "https://x.test/telegram/sec",
      secretToken: "sec",
      allowedUpdates: ["message"],
    });
    expect(calls[0]!.url).toBe("https://api.telegram.org/botT/setWebhook");
    expect(calls[0]!.body).toEqual({
      url: "https://x.test/telegram/sec",
      secret_token: "sec",
      allowed_updates: ["message"],
    });
  });

  test("non-ok response throws TelegramApiError with description", async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      error_code: 401,
      description: "Unauthorized",
    }));
    const client = new TelegramClient({ token: "BAD", fetch: fetchImpl });
    await expect(client.sendMessage({ chatId: 1, text: "x" })).rejects.toBeInstanceOf(
      TelegramApiError,
    );
  });

  test("constructor rejects empty token", () => {
    expect(() => new TelegramClient({ token: "" })).toThrow(/token is required/);
  });
});
