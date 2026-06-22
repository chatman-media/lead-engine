// Unit (без PG/сети) для LinkingCommands. client/repo фейкаются.

import { describe, expect, it } from "bun:test";
import type { TelegramClient } from "@chatman-media/channel-telegram";
import type { NotificationsRepo } from "./dal/notifications.ts";
import { LinkingCommands } from "./operator-linking-commands.ts";

type Sent = { chatId: string; text: string };

function make(repoOver: Partial<Record<string, unknown>> = {}) {
  const sent: Sent[] = [];
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const client = {
    sendMessage: async (m: Sent) => {
      sent.push(m);
    },
  } as unknown as TelegramClient;
  const repo = {
    findByLinkToken: async () => undefined,
    linkChat: async (...a: unknown[]) => calls.push({ fn: "linkChat", args: a }),
    findGroupLinkToken: async () => undefined,
    createRule: async (...a: unknown[]) => calls.push({ fn: "createRule", args: a }),
    deleteGroupLinkToken: async (...a: unknown[]) =>
      calls.push({ fn: "deleteGroupLinkToken", args: a }),
    ...repoOver,
  } as unknown as NotificationsRepo;
  return { cmds: new LinkingCommands(() => client, repo), sent, calls };
}

describe("handleLinkToken", () => {
  it("невалидный токен → ошибка, без linkChat", async () => {
    const { cmds, sent, calls } = make();
    await cmds.handleLinkToken("bad", "100");
    expect(sent[0]?.text).toContain("недействительна");
    expect(calls.find((c) => c.fn === "linkChat")).toBeUndefined();
  });

  it("валидный токен → linkChat + подтверждение", async () => {
    const { cmds, sent, calls } = make({
      findByLinkToken: async () => ({ adminId: 7 }),
    });
    await cmds.handleLinkToken("ok", "100");
    expect(calls.find((c) => c.fn === "linkChat")?.args).toEqual([7, "100"]);
    expect(sent[0]?.text).toContain("привязан");
  });
});

describe("handleGroupLinkToken", () => {
  it("не группа (chatId > 0) → подсказка", async () => {
    const { cmds, sent } = make();
    await cmds.handleGroupLinkToken("t", 100, "Чат");
    expect(sent[0]?.text).toContain("только в группах");
  });

  it("группа, токен невалиден → ошибка", async () => {
    const { cmds, sent } = make();
    await cmds.handleGroupLinkToken("t", -100, "Группа");
    expect(sent[0]?.text).toContain("недействителен");
  });

  it("группа + валидный токен → createRule + delete + подтверждение (forum-ветка)", async () => {
    const { cmds, sent, calls } = make({
      findGroupLinkToken: async () => ({ tenantId: 1, eventType: "lead.created" }),
    });
    await cmds.handleGroupLinkToken("t", -100500, "Лиды", true);
    const rule = calls.find((c) => c.fn === "createRule")?.args[0] as Record<string, unknown>;
    expect(rule).toMatchObject({ tenantId: 1, targetId: "-100500", targetIsForum: true });
    expect(calls.find((c) => c.fn === "deleteGroupLinkToken")).toBeDefined();
    expect(sent[0]?.text).toContain("подключена");
    expect(sent[0]?.text).toContain("форум-группа");
  });
});

describe("handleSetupGroup", () => {
  it("не группа → подсказка", async () => {
    const { cmds, sent } = make();
    await cmds.handleSetupGroup(100, "Чат");
    expect(sent[0]?.text).toContain("только в группах");
  });

  it("группа → показывает ID группы", async () => {
    const { cmds, sent } = make();
    await cmds.handleSetupGroup(-100500, "Моя группа");
    expect(sent[0]?.text).toContain("-100500");
    expect(sent[0]?.text).toContain("Моя группа");
  });
});
