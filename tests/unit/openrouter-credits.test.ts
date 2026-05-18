import { afterEach, describe, expect, test } from "bun:test";

import { runBalanceCheck } from "@/openrouter/balance-monitor.ts";
import {
  fetchOpenRouterCredits,
  getCachedCredits,
  type OpenRouterCredits,
  parseCreditsBody,
  setCachedCredits,
} from "@/openrouter/credits.ts";

describe("parseCreditsBody", () => {
  test("computes remaining = total_credits - total_usage", () => {
    const c = parseCreditsBody({ data: { total_credits: 25, total_usage: 18.5 } }, 1000);
    expect(c.totalCredits).toBe(25);
    expect(c.totalUsage).toBe(18.5);
    expect(c.remaining).toBe(6.5);
    expect(c.checkedAt).toBe(1000);
  });

  test("throws on an unexpected response shape", () => {
    expect(() => parseCreditsBody({ nope: true }, 0)).toThrow();
    expect(() => parseCreditsBody(null, 0)).toThrow();
  });

  test("throws when a credits field is non-numeric", () => {
    expect(() => parseCreditsBody({ data: { total_credits: "abc", total_usage: 1 } }, 0)).toThrow(
      /unexpected response shape/,
    );
  });
});

describe("credits cache", () => {
  test("getCachedCredits returns whatever setCachedCredits last stored", () => {
    const snapshot: OpenRouterCredits = {
      totalCredits: 50,
      totalUsage: 10,
      remaining: 40,
      checkedAt: 123,
    };
    setCachedCredits(snapshot);
    expect(getCachedCredits()).toEqual(snapshot);
  });
});

describe("fetchOpenRouterCredits", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("throws immediately when the API key is missing", async () => {
    await expect(
      fetchOpenRouterCredits({ apiKey: "", baseUrl: "https://openrouter.ai/api/v1" }),
    ).rejects.toThrow(/API key/);
  });

  test("strips trailing slashes from baseUrl and parses a 200 body", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ data: { total_credits: 30, total_usage: 12 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const c = await fetchOpenRouterCredits({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1///",
    });
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/credits");
    expect(c.remaining).toBe(18);
  });

  test("throws on a non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchOpenRouterCredits({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

/** Minimal stub of the bits of TelegramClient the monitor uses. */
function fakeTelegram() {
  const sent: Array<{ chatId: number; text: string }> = [];
  return {
    sent,
    sendMessage: async (m: { chatId: number; text: string }) => {
      sent.push({ chatId: m.chatId, text: m.text });
      return { message_id: 1 };
    },
  };
}

function depsWith(
  remaining: number,
  adminTgId: number | null,
  tg: ReturnType<typeof fakeTelegram>,
) {
  const credits: OpenRouterCredits = {
    totalCredits: 100,
    totalUsage: 100 - remaining,
    remaining,
    checkedAt: 0,
  };
  return {
    telegram: tg,
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/v1",
    lowBalanceUsd: 5,
    adminTgId,
    publicBaseUrl: "http://localhost:3000",
    fetchCredits: async () => credits,
  };
}

describe("runBalanceCheck", () => {
  test("DMs the operator when the balance is below the threshold", async () => {
    const tg = fakeTelegram();
    const r = await runBalanceCheck(depsWith(2, 777, tg), 0);
    expect(r.ok).toBe(true);
    expect(r.alerted).toBe(true);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(777);
    expect(tg.sent[0]!.text).toContain("$2.00");
  });

  test("stays silent when the balance is healthy", async () => {
    const tg = fakeTelegram();
    const r = await runBalanceCheck(depsWith(50, 777, tg), 0);
    expect(r.ok).toBe(true);
    expect(r.alerted).toBe(false);
    expect(tg.sent).toHaveLength(0);
  });

  test("does not re-alert within the cooldown window", async () => {
    const tg = fakeTelegram();
    const first = await runBalanceCheck(depsWith(2, 777, tg), 0);
    expect(first.alerted).toBe(true);
    // Feed the updated lastAlertAt straight back — still inside cooldown.
    const second = await runBalanceCheck(depsWith(2, 777, tg), first.lastAlertAt);
    expect(second.alerted).toBe(false);
    expect(tg.sent).toHaveLength(1);
  });

  test("does not alert when no operator Telegram id is configured", async () => {
    const tg = fakeTelegram();
    const r = await runBalanceCheck(depsWith(2, null, tg), 0);
    expect(r.ok).toBe(true);
    expect(r.alerted).toBe(false);
    expect(tg.sent).toHaveLength(0);
  });

  test("reports a failed fetch without throwing", async () => {
    const tg = fakeTelegram();
    const deps = {
      ...depsWith(2, 777, tg),
      fetchCredits: async () => {
        throw new Error("network down");
      },
    };
    const r = await runBalanceCheck(deps, 0);
    expect(r.ok).toBe(false);
    expect(r.alerted).toBe(false);
  });
});
