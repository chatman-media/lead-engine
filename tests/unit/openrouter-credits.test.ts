import { describe, expect, test } from "bun:test";

import { runBalanceCheck } from "@/openrouter/balance-monitor.ts";
import { type OpenRouterCredits, parseCreditsBody } from "@/openrouter/credits.ts";

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
