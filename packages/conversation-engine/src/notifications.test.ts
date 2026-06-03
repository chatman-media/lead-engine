import { describe, expect, it, mock } from "bun:test";
import type { NotificationRule, NotificationsRepo, OperatorSettings } from "./dal/notifications.ts";
import { NotificationService, type NotificationEvent } from "./notifications.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 1,
    tenantId: 1,
    eventType: "stage_changed",
    conditionJson: "{}",
    channelType: "telegram_group",
    targetId: "group-100",
    priority: "normal",
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeOperatorSettings(overrides: Partial<OperatorSettings> = {}): OperatorSettings {
  return {
    id: 1,
    adminId: 10,
    tenantId: 1,
    telegramChatId: "chat-10",
    notifyOnAssignedOnly: false,
    linkToken: null,
    linkTokenExpiresAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRepo(
  rules: NotificationRule[] = [],
  settings: OperatorSettings[] = [],
  template: { body: string } | undefined = undefined,
): NotificationsRepo {
  return {
    findRulesByEvent: async () => rules,
    findOperatorSettingsByTenant: async () => settings,
    findTemplate: async () => template as any,
    // unused in NotificationService:
    findOperatorSettings: async () => undefined,
    findByLinkToken: async () => undefined,
    generateLinkToken: async () => "",
    linkChat: async () => {},
    upsertOperatorSettings: async () => {},
    listRules: async () => [],
    createRule: async (r: any) => ({ ...r, id: 1, createdAt: 0, updatedAt: 0 }),
    deleteRule: async () => {},
    upsertTemplate: async () => {},
    listTemplates: async () => [],
    deleteTemplate: async () => {},
  } as unknown as NotificationsRepo;
}

const BASE_EVENT: NotificationEvent = {
  tenantId: 1,
  eventType: "stage_changed",
  leadId: 42,
  data: { fromStage: "intake", toStage: "qualified" },
};

// ── matchesCondition ───────────────────────────────────────────────────────────

describe("NotificationService.matchesCondition", () => {
  const svc = new NotificationService(makeRepo(), "", "http://app");

  it("returns true for empty condition", () => {
    expect(svc.matchesCondition(makeRule({ conditionJson: "{}" }), BASE_EVENT)).toBe(true);
  });

  it("returns true when all condition fields match event.data", () => {
    const rule = makeRule({ conditionJson: JSON.stringify({ toStage: "qualified" }) });
    expect(svc.matchesCondition(rule, BASE_EVENT)).toBe(true);
  });

  it("returns false when a condition field does not match", () => {
    const rule = makeRule({ conditionJson: JSON.stringify({ toStage: "won" }) });
    expect(svc.matchesCondition(rule, BASE_EVENT)).toBe(false);
  });

  it("returns true on malformed JSON (safe fallback)", () => {
    expect(svc.matchesCondition(makeRule({ conditionJson: "NOT JSON" }), BASE_EVENT)).toBe(true);
  });
});

// ── renderTemplate ─────────────────────────────────────────────────────────────

describe("NotificationService.renderTemplate", () => {
  const svc = new NotificationService(makeRepo(), "", "http://app");

  it("replaces known placeholders", () => {
    const result = svc.renderTemplate("Стадия: {{toStage}}", BASE_EVENT);
    expect(result).toBe("Стадия: qualified");
  });

  it("replaces leadId placeholder", () => {
    const result = svc.renderTemplate("Лид #{{leadId}}", BASE_EVENT);
    expect(result).toBe("Лид #42");
  });

  it("removes unused placeholders", () => {
    const result = svc.renderTemplate("{{unknown}} ok", BASE_EVENT);
    expect(result).toBe(" ok");
  });
});

// ── formatMessage ──────────────────────────────────────────────────────────────

describe("NotificationService.formatMessage", () => {
  const svc = new NotificationService(makeRepo(), "", "http://app");

  it("includes event emoji and title", () => {
    const msg = svc.formatMessage({ tenantId: 1, eventType: "stage_changed", data: {} });
    expect(msg).toContain("🔄");
    expect(msg).toContain("Смена стадии");
  });

  it("includes both stages when fromStage and toStage present", () => {
    const msg = svc.formatMessage(BASE_EVENT);
    expect(msg).toContain("intake");
    expect(msg).toContain("qualified");
  });

  it("uses fallback emoji and title for unknown event", () => {
    const msg = svc.formatMessage({ tenantId: 1, eventType: "mystery_event", data: {} });
    expect(msg).toContain("🔔");
    expect(msg).toContain("Уведомление");
  });
});

// ── notify — routing ───────────────────────────────────────────────────────────

describe("NotificationService.notify", () => {
  it("does nothing when botToken is empty", async () => {
    const repo = makeRepo([makeRule()]);
    const svc = new NotificationService(repo, "", "http://app");
    // No error means no attempt to send
    await svc.notify(BASE_EVENT);
  });

  it("sends to rule targetId", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(makeRepo([makeRule()]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual(["group-100"]);
  });

  it("skips rule when condition does not match", async () => {
    const sent: string[] = [];
    const rule = makeRule({ conditionJson: JSON.stringify({ toStage: "won" }) });
    const svc = new NotificationService(makeRepo([rule]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual([]);
  });

  it("sends personal notification when notifyOnAssignedOnly=false", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ notifyOnAssignedOnly: false });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify(BASE_EVENT);
    expect(sent).toContain("chat-10");
  });

  it("sends personal notification when lead is assigned to this admin", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ adminId: 10, notifyOnAssignedOnly: true });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify({ ...BASE_EVENT, assignedAdminId: 10 });
    expect(sent).toContain("chat-10");
  });

  it("skips personal notification when notifyOnAssignedOnly=true and lead assigned to other admin", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ adminId: 10, notifyOnAssignedOnly: true });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify({ ...BASE_EVENT, assignedAdminId: 99 });
    expect(sent).toEqual([]);
  });

  it("sends personal notification when assignedAdminId is undefined (no filter applied)", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ adminId: 10, notifyOnAssignedOnly: true });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify({ ...BASE_EVENT, assignedAdminId: undefined });
    expect(sent).toContain("chat-10");
  });

  it("skips personal notification when telegramChatId is null", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ telegramChatId: null });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ chatId }: { chatId: string }) => { sent.push(chatId); } };
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual([]);
  });

  it("uses template body when available", async () => {
    const texts: string[] = [];
    const repo = makeRepo([makeRule()], [], { body: "Новая стадия: {{toStage}}" });
    const svc = new NotificationService(repo, "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = { sendMessage: async ({ text }: { text: string }) => { texts.push(text); } };
    await svc.notify(BASE_EVENT);
    expect(texts[0]).toBe("Новая стадия: qualified");
  });
});
