// Unit (без PG/сети) для InformerCommands. client/repo фейкаются; проверяем
// текст/клавиатуры команд и ветку "не привязан".

import { describe, expect, it } from "bun:test";
import type { TelegramClient } from "@chatman-media/channel-telegram";
import type { NotificationsRepo } from "./dal/notifications.ts";
import { InformerCommands } from "./operator-informer-commands.ts";

type Sent = { chatId: string; text: string; replyMarkup?: unknown };

function fakeClient() {
  const sent: Sent[] = [];
  const client = {
    sendMessage: async (m: Sent) => {
      sent.push(m);
    },
  } as unknown as TelegramClient;
  return { client, sent };
}

const settings = (over: Record<string, unknown> = {}) =>
  ({
    adminId: 7,
    tenantId: 1,
    informerLevel: "important",
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "Asia/Bangkok",
    informerMutedUntil: null,
    informerTopics: null,
    ...over,
  }) as unknown as Awaited<ReturnType<NotificationsRepo["findOperatorSettingsByChatId"]>>;

function fakeRepo(opts: {
  settings?: ReturnType<typeof settings> | undefined;
  recent?: Array<Record<string, unknown>>;
}) {
  const prefs: Array<Record<string, unknown>> = [];
  const repo = {
    findOperatorSettingsByChatId: async () => opts.settings,
    updateInformerPrefs: async (_adminId: number, patch: Record<string, unknown>) => {
      prefs.push(patch);
    },
    listRecentNotifications: async () => opts.recent ?? [],
  } as unknown as NotificationsRepo;
  return { repo, prefs };
}

function make(opts: Parameters<typeof fakeRepo>[0]) {
  const { client, sent } = fakeClient();
  const { repo, prefs } = fakeRepo(opts);
  return { cmds: new InformerCommands(() => client, repo), sent, prefs };
}

describe("InformerCommands — не привязан", () => {
  it("любая команда без settings → подсказка про привязку", async () => {
    const { cmds, sent } = make({ settings: undefined });
    await cmds.cmdStatus("100");
    expect(sent[0]?.text).toContain("привяжите аккаунт");
  });
});

describe("cmdStatus", () => {
  it("рендерит уровень/дайджест/темы", async () => {
    const { cmds, sent } = make({ settings: settings() });
    await cmds.cmdStatus("100");
    expect(sent[0]?.text).toContain("Информер");
    expect(sent[0]?.text).toContain("Лиды");
  });
});

describe("cmdLevel/cmdTopics/cmdDigest", () => {
  it("шлют соответствующие клавиатуры", async () => {
    const { cmds, sent } = make({ settings: settings() });
    await cmds.cmdLevel("100");
    await cmds.cmdTopics("100");
    await cmds.cmdDigest("100");
    expect(sent[0]?.replyMarkup).toBeDefined();
    expect(sent[1]?.replyMarkup).toBeDefined();
    expect(sent[2]?.replyMarkup).toBeDefined();
  });
});

describe("cmdMute", () => {
  it("невалидный формат → подсказка, без записи", async () => {
    const { cmds, sent, prefs } = make({ settings: settings() });
    await cmds.cmdMute("100", "/mute xyz");
    expect(sent[0]?.text).toContain("Формат");
    expect(prefs).toHaveLength(0);
  });
  it("/mute 30m → пишет informerMutedUntil + подтверждение", async () => {
    const { cmds, sent, prefs } = make({ settings: settings() });
    await cmds.cmdMute("100", "/mute 30m");
    expect((prefs[0] as { informerMutedUntil: number }).informerMutedUntil).toBeGreaterThan(0);
    expect(sent[0]?.text).toContain("Заглушено");
  });
  it("/mute off → снятие мута (until=null)", async () => {
    const { cmds, sent, prefs } = make({ settings: settings() });
    await cmds.cmdMute("100", "/mute off");
    expect((prefs[0] as { informerMutedUntil: number | null }).informerMutedUntil).toBeNull();
    expect(sent[0]?.text).toContain("Мут снят");
  });
});

describe("cmdLast", () => {
  it("пусто → 'Пока пусто'", async () => {
    const { cmds, sent } = make({ settings: settings(), recent: [] });
    await cmds.cmdLast("100", "/last");
    expect(sent[0]?.text).toContain("Пока пусто");
  });
  it("есть события → лента с заголовками", async () => {
    const { cmds, sent } = make({
      settings: settings(),
      recent: [{ severity: "critical", title: "Лид №5", body: "детали", createdAt: 1_700_000_000 }],
    });
    await cmds.cmdLast("100", "/last 5");
    expect(sent[0]?.text).toContain("Последние 1");
    expect(sent[0]?.text).toContain("Лид №5");
  });
});
