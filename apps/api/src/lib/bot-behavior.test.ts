// Unit (без PG) для bot-behavior. withTenant(db) = db.transaction(cb); фейк
// transaction управляет успехом/падением. enqueueFixedReply/applyAutoHandoff
// не вызываются: транзакция либо отдаёт настройки, либо игнорит cb.

import { describe, expect, it } from "bun:test";
import type { BotSettings, Db } from "@chatman-media/conversation-engine";
import { DEFAULT_BOT_SETTINGS } from "@chatman-media/conversation-engine";
import { applyBotBehaviorGates, makeResolveBotSettings } from "./bot-behavior.ts";

function settings(over: Partial<BotSettings> = {}): BotSettings {
  return { ...DEFAULT_BOT_SETTINGS, ...over };
}

describe("makeResolveBotSettings", () => {
  it("читает tenants.bot_settings_json и парсит (lines 30-40)", async () => {
    const db = {
      transaction: async (cb: (tx: unknown) => unknown) =>
        cb({
          execute: async () => undefined,
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ json: JSON.stringify({ greetingText: "Привет!" }) }],
              }),
            }),
          }),
        }),
    } as unknown as Db;
    const resolve = makeResolveBotSettings(db);
    const out = await resolve(1);
    expect(out.greetingText).toBe("Привет!");
  });

  it("ошибка БД → DEFAULT_BOT_SETTINGS (catch, line 42)", async () => {
    const db = {
      transaction: async () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    const out = await makeResolveBotSettings(db)(1);
    expect(out).toEqual({ ...DEFAULT_BOT_SETTINGS });
  });
});

describe("applyBotBehaviorGates", () => {
  // db.transaction игнорит cb → applyAutoHandoff/shouldSendAutoMessage не бегут.
  const passiveDb = { transaction: async () => undefined } as unknown as Db;

  const baseDeps = (over: Record<string, unknown>) =>
    ({
      db: passiveDb,
      tenantId: 1,
      channelDbId: 10,
      inbound: { externalUserId: "u1", parts: [] },
      result: {
        conversationId: 5,
        contactId: 7,
        contactDisplayName: "Боб",
        userMessageText: "",
        mediaOnly: false,
      },
      nowEpoch: 1_700_000_000,
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: тест-DI
    }) as any;

  it("стоп-слово → skipReply + notify (lines 94-104)", async () => {
    const notifs: Array<Record<string, unknown>> = [];
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings({ stopWords: ["оператор"] }),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "Боб",
          userMessageText: "позовите оператора срочно",
          mediaOnly: false,
        },
        notifications: { notify: async (e: Record<string, unknown>) => void notifs.push(e) },
      }),
    );
    expect(out.skipReply).toBe(true);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.eventType).toBe("human_takeover");
  });

  it("стоп-слово без notifications → всё равно skipReply", async () => {
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings({ stopWords: ["стоп"] }),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "",
          userMessageText: "стоп",
          mediaOnly: false,
        },
      }),
    );
    expect(out.skipReply).toBe(true);
  });

  it("вне рабочих часов, send=false → skipReply без enqueue (line 142)", async () => {
    // окно 09:00–10:00 UTC; nowEpoch берём заведомо вне окна.
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings({
          hoursEnabled: true,
          hoursStartMin: 540,
          hoursEndMin: 600,
          hoursTz: "UTC",
          offhoursMessage: "Мы offline",
        }),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "Боб",
          userMessageText: "привет",
          mediaOnly: false,
        },
        // passiveDb.transaction → undefined → shouldSendAutoMessage = undefined → не шлём
      }),
    );
    expect(out.skipReply).toBe(true);
  });

  it("обычное сообщение в часы → skipReply=false", async () => {
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings(),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "Боб",
          userMessageText: "привет",
          mediaOnly: false,
          conversationCreated: false,
        },
      }),
    );
    expect(out.skipReply).toBe(false);
  });

  it("первое сообщение + greetingText → enqueue приветствия (lines 147-155)", async () => {
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings({ greetingText: "Здравствуйте!" }),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "Боб",
          userMessageText: "привет",
          mediaOnly: false,
          conversationCreated: true,
        },
      }),
    );
    expect(out.skipReply).toBe(false);
  });

  it("media-only + mediaAckText → enqueue ack (lines 160-168)", async () => {
    const out = await applyBotBehaviorGates(
      baseDeps({
        settings: settings({ mediaAckText: "Получили фото, проверяем." }),
        result: {
          conversationId: 5,
          contactId: 7,
          contactDisplayName: "Боб",
          userMessageText: "",
          mediaOnly: true,
        },
      }),
    );
    expect(out.skipReply).toBe(false);
  });
});
