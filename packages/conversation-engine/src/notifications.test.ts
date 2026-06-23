import { describe, expect, it } from "bun:test";
import type { TelegramClient, TgSendMessageResult } from "@chatman-media/channel-telegram";
import type { AdminInformer } from "./admin-informer.ts";
import type {
  NotificationRule,
  NotificationsRepo,
  NotificationTemplate,
  OperatorSettings,
} from "./dal/notifications.ts";
import { type NotificationEvent, NotificationService } from "./notifications.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 1,
    tenantId: 1,
    eventType: "stage_changed",
    conditionJson: "{}",
    channelType: "telegram_group",
    targetId: "group-100",
    targetIsForum: false,
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
    informerLevel: "important",
    informerTopics: null,
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "UTC",
    informerMutedUntil: null,
    informerLastDigestAt: null,
    informerQuietFrom: null,
    informerQuietTo: null,
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
    findTemplate: async () =>
      template
        ? ({
            id: 1,
            tenantId: 1,
            slug: "stage_changed",
            body: template.body,
            updatedAt: 0,
          } satisfies NotificationTemplate)
        : undefined,
    // unused in NotificationService:
    findOperatorSettings: async () => undefined,
    findByLinkToken: async () => undefined,
    generateLinkToken: async () => "",
    linkChat: async () => {},
    upsertOperatorSettings: async () => {},
    listRules: async () => [],
    createRule: async (r: Parameters<NotificationsRepo["createRule"]>[0]) => ({
      ...r,
      id: 1,
      createdAt: 0,
      updatedAt: 0,
    }),
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

type SendMessageInput = Parameters<TelegramClient["sendMessage"]>[0];
type SendPhotoInput = Parameters<TelegramClient["sendPhoto"]>[0];
type SendVideoInput = Parameters<TelegramClient["sendVideo"]>[0];
type SendDocumentInput = Parameters<TelegramClient["sendDocument"]>[0];
type SendVideoNoteInput = Parameters<TelegramClient["sendVideoNote"]>[0];
type SendPhotoUploadInput = Parameters<TelegramClient["sendPhotoUpload"]>[0];
type SendVideoUploadInput = Parameters<TelegramClient["sendVideoUpload"]>[0];
type SendDocumentUploadInput = Parameters<TelegramClient["sendDocumentUpload"]>[0];
type SendVideoNoteUploadInput = Parameters<TelegramClient["sendVideoNoteUpload"]>[0];

type TelegramCall =
  | { method: "sendMessage"; input: SendMessageInput }
  | { method: "sendPhoto"; input: SendPhotoInput }
  | { method: "sendVideo"; input: SendVideoInput }
  | { method: "sendDocument"; input: SendDocumentInput }
  | { method: "sendVideoNote"; input: SendVideoNoteInput }
  | { method: "sendPhotoUpload"; input: SendPhotoUploadInput }
  | { method: "sendVideoUpload"; input: SendVideoUploadInput }
  | { method: "sendDocumentUpload"; input: SendDocumentUploadInput }
  | { method: "sendVideoNoteUpload"; input: SendVideoNoteUploadInput };

function telegramResult(input: SendMessageInput): TgSendMessageResult {
  return {
    message_id: 1,
    chat: {
      id: typeof input.chatId === "number" ? input.chatId : 1,
      type: "private",
    },
    date: 0,
    text: input.text,
  };
}

function fakeTelegramClient(
  onSend: (input: SendMessageInput) => void | Promise<void>,
): TelegramClient {
  return {
    sendMessage: async (input: SendMessageInput) => {
      await onSend(input);
      return telegramResult(input);
    },
  } as unknown as TelegramClient;
}

function fakeTelegramMediaClient(
  onCall: (call: TelegramCall) => void | Promise<void>,
): TelegramClient {
  const result = (chatId: number | string): TgSendMessageResult => ({
    message_id: 1,
    chat: { id: typeof chatId === "number" ? chatId : 1, type: "private" },
    date: 0,
  });
  return {
    sendMessage: async (input: SendMessageInput) => {
      await onCall({ method: "sendMessage", input });
      return { ...result(input.chatId), text: input.text };
    },
    sendPhoto: async (input: SendPhotoInput) => {
      await onCall({ method: "sendPhoto", input });
      return result(input.chatId);
    },
    sendVideo: async (input: SendVideoInput) => {
      await onCall({ method: "sendVideo", input });
      return result(input.chatId);
    },
    sendDocument: async (input: SendDocumentInput) => {
      await onCall({ method: "sendDocument", input });
      return result(input.chatId);
    },
    sendVideoNote: async (input: SendVideoNoteInput) => {
      await onCall({ method: "sendVideoNote", input });
      return result(input.chatId);
    },
    sendPhotoUpload: async (input: SendPhotoUploadInput) => {
      await onCall({ method: "sendPhotoUpload", input });
      return result(input.chatId);
    },
    sendVideoUpload: async (input: SendVideoUploadInput) => {
      await onCall({ method: "sendVideoUpload", input });
      return result(input.chatId);
    },
    sendDocumentUpload: async (input: SendDocumentUploadInput) => {
      await onCall({ method: "sendDocumentUpload", input });
      return result(input.chatId);
    },
    sendVideoNoteUpload: async (input: SendVideoNoteUploadInput) => {
      await onCall({ method: "sendVideoNoteUpload", input });
      return result(input.chatId);
    },
  } as unknown as TelegramClient;
}

// ── matchesCondition ───────────────────────────────────────────────────────────

describe("NotificationService.matchesCondition", () => {
  const svc = new NotificationService(makeRepo(), "", "http://app");

  it("returns true for empty condition", () => {
    expect(svc.matchesCondition(makeRule({ conditionJson: "{}" }), BASE_EVENT)).toBe(true);
  });

  it("returns true when all condition fields match event.data", () => {
    const rule = makeRule({
      conditionJson: JSON.stringify({ toStage: "qualified" }),
    });
    expect(svc.matchesCondition(rule, BASE_EVENT)).toBe(true);
  });

  it("returns false when a condition field does not match", () => {
    const rule = makeRule({
      conditionJson: JSON.stringify({ toStage: "won" }),
    });
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
    const msg = svc.formatMessage({
      tenantId: 1,
      eventType: "stage_changed",
      data: {},
    });
    expect(msg).toContain("🔄");
    expect(msg).toContain("Смена стадии");
  });

  it("includes both stages when fromStage and toStage present", () => {
    const msg = svc.formatMessage(BASE_EVENT);
    expect(msg).toContain("intake");
    expect(msg).toContain("qualified");
  });

  it("uses fallback emoji and title for unknown event", () => {
    const msg = svc.formatMessage({
      tenantId: 1,
      eventType: "mystery_event",
      data: {},
    });
    expect(msg).toContain("🔔");
    expect(msg).toContain("Уведомление");
  });

  it("renders media summary without dumping raw refs json / internal fields", () => {
    const msg = svc.formatMessage({
      tenantId: 1,
      eventType: "verification_requested",
      conversationId: 55,
      data: {
        displayName: "KYC Client",
        mediaSummary: "1. video_note (7s)",
        mediaRefsJson: '[{"kind":"video_note","externalRef":"vn1"}]',
        mediaCount: 1,
        reason: "kyc_review",
        action: "Проверить видео.",
      },
    });
    expect(msg).toContain("Материалы");
    expect(msg).toContain("video_note");
    expect(msg).toContain("Проверить видео.");
    // Служебные поля наружу не показываем (file_id, refs json, счётчик, reason).
    expect(msg).not.toContain("mediaRefsJson");
    expect(msg).not.toContain("externalRef");
    expect(msg).not.toContain("mediaCount");
    expect(msg).not.toContain("kyc_review");
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
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual(["group-100"]);
  });

  it("skips rule when condition does not match", async () => {
    const sent: string[] = [];
    const rule = makeRule({
      conditionJson: JSON.stringify({ toStage: "won" }),
    });
    const svc = new NotificationService(makeRepo([rule]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual([]);
  });

  it("sends personal notification when notifyOnAssignedOnly=false", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ notifyOnAssignedOnly: false });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify(BASE_EVENT);
    expect(sent).toContain("chat-10");
  });

  it("sends personal notification when lead is assigned to this admin", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({
      adminId: 10,
      notifyOnAssignedOnly: true,
    });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify({ ...BASE_EVENT, assignedAdminId: 10 });
    expect(sent).toContain("chat-10");
  });

  it("skips personal notification when notifyOnAssignedOnly=true and lead assigned to other admin", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({
      adminId: 10,
      notifyOnAssignedOnly: true,
    });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify({ ...BASE_EVENT, assignedAdminId: 99 });
    expect(sent).toEqual([]);
  });

  it("sends personal notification when assignedAdminId is undefined (no filter applied)", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({
      adminId: 10,
      notifyOnAssignedOnly: true,
    });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify({ ...BASE_EVENT, assignedAdminId: undefined });
    expect(sent).toContain("chat-10");
  });

  it("skips personal notification when telegramChatId is null", async () => {
    const sent: string[] = [];
    const settings = makeOperatorSettings({ telegramChatId: null });
    const svc = new NotificationService(makeRepo([], [settings]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify(BASE_EVENT);
    expect(sent).toEqual([]);
  });

  it("uses template body when available", async () => {
    const texts: string[] = [];
    const repo = makeRepo([makeRule()], [], {
      body: "Новая стадия: {{toStage}}",
    });
    const svc = new NotificationService(repo, "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ text }) => texts.push(text));
    await svc.notify(BASE_EVENT);
    expect(texts[0]).toBe("Новая стадия: qualified");
  });

  it("operator handoff notification includes reactive operator buttons", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 109,
      contactId: 7,
      data: {
        displayName: "Сергей",
        reason: "kyc_review",
        title: "Проверить KYC клиента",
        action: "Проверить документы и видео.",
      },
    });

    const markup = sent[0]?.replyMarkup;
    expect(markup?.inline_keyboard?.[0]?.[0]).toEqual({
      text: "👁 Открыть чат",
      url: "https://app.example/conversations/109",
    });
    expect(JSON.stringify(markup)).toContain("op:v1:takeover:1:109");
    expect(JSON.stringify(markup)).toContain("op:v1:return_ai:1:109");
    expect(JSON.stringify(markup)).toContain("opx:kycok:109");
    expect(JSON.stringify(markup)).toContain("opx:kycmore:109");
    expect(JSON.stringify(markup)).toContain("opx:kycno:109");
  });

  it("operator handoff sends media previews before the decision card", async () => {
    const calls: TelegramCall[] = [];
    const downloaded: string[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
      undefined,
      async (ref) => {
        downloaded.push(ref.externalRef);
        return new Response(`bytes:${ref.externalRef}`, {
          headers: {
            "content-type": ref.kind === "photo" ? "image/jpeg" : "video/mp4",
          },
        });
      },
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramMediaClient((call) => calls.push(call));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 109,
      contactId: 7,
      data: {
        displayName: "Сергей",
        reason: "kyc_review",
        title: "Проверить KYC клиента",
        action: "Проверить документы и видео.",
        mediaRefsJson: JSON.stringify([
          {
            kind: "photo",
            channelId: "7",
            externalRef: "photo-file",
            caption: "passport",
          },
          { kind: "video", channelId: "7", externalRef: "video-file" },
          { kind: "video_note", channelId: "7", externalRef: "circle-file" },
        ]),
      },
    });

    expect(downloaded).toEqual(["photo-file", "video-file", "circle-file"]);
    expect(calls.map((call) => call.method)).toEqual([
      "sendPhotoUpload",
      "sendVideoUpload",
      "sendVideoNoteUpload",
      "sendMessage",
    ]);
    expect(calls[0]?.input.chatId).toBe("operator-chat");
    expect(calls[0]?.method === "sendPhotoUpload" && calls[0].input.caption).toContain(
      "Клиент: Сергей",
    );
    const cardCall = calls[3];
    expect(cardCall?.method).toBe("sendMessage");
    if (cardCall?.method !== "sendMessage") throw new Error("expected sendMessage");
    expect(cardCall.input.replyMarkup).toBeDefined();
    expect(JSON.stringify(cardCall.input.replyMarkup)).toContain("opx:kycok:109");
  });

  it("operator handoff still sends the decision card when media preview fails", async () => {
    const calls: TelegramCall[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
      undefined,
      async () => new Response("photo", { headers: { "content-type": "image/jpeg" } }),
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramMediaClient((call) => {
      calls.push(call);
      if (call.method === "sendPhotoUpload") throw new Error("telegram media down");
    });

    const originalError = console.error;
    console.error = () => {};
    try {
      await svc.notify({
        tenantId: 1,
        eventType: "operator_handoff_required",
        conversationId: 109,
        contactId: 7,
        data: {
          displayName: "Сергей",
          reason: "kyc_review",
          title: "Проверить KYC клиента",
          action: "Проверить документы и видео.",
          mediaRefsJson: JSON.stringify([
            { kind: "photo", channelId: "7", externalRef: "photo-file" },
          ]),
        },
      });
    } finally {
      console.error = originalError;
    }

    expect(calls.map((call) => call.method)).toEqual(["sendPhotoUpload", "sendMessage"]);
    expect(calls[1]?.method === "sendMessage" && calls[1].input.replyMarkup).toBeDefined();
  });

  it("payment handoff notification includes payment quick actions", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 110,
      contactId: 8,
      data: {
        displayName: "Анна",
        reason: "payment_review",
        title: "Проверить оплату",
        action: "Проверить чек.",
        orderId: 77,
      },
    });

    const markup = JSON.stringify(sent[0]?.replyMarkup);
    expect(markup).toContain("opx:payok:110:77");
    expect(markup).toContain("opx:paywait:110:77");
    expect(markup).toContain("opx:paybad:110:77");
  });

  it("office payout handoff notification includes office confirmation quick actions", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 111,
      contactId: 9,
      data: {
        displayName: "Игорь",
        reason: "office_payout",
        title: "Подтвердить выдачу в офисе",
        action: "Подтвердить офис и время.",
        orderId: 78,
      },
    });

    const markup = JSON.stringify(sent[0]?.replyMarkup);
    expect(markup).toContain("opx:office:111:78");
    expect(markup).toContain("opx:payout:111:78");
  });

  it("generic operator_request: early stage (quote_calculated) → only reply", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 112,
      contactId: 10,
      data: {
        displayName: "Пётр",
        reason: "operator_request",
        title: "Разобрать обмен вручную",
        action: "Продолжить вручную или вернуть AI.",
        orderId: 79,
        stageSlug: "quote_calculated",
      },
    });

    const markup = JSON.stringify(sent[0]?.replyMarkup);
    expect(markup).toContain("opx:reply:112:79");
    expect(markup).not.toContain("opx:payok:112:79");
    expect(markup).not.toContain("opx:payout:112:79");
    expect(markup).toContain("return_ai");
  });

  it("generic operator_request: payment stage → payment + reply buttons", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 112,
      contactId: 10,
      data: {
        displayName: "Пётр",
        reason: "operator_request",
        title: "Разобрать обмен вручную",
        action: "Продолжить вручную или вернуть AI.",
        orderId: 79,
        stageSlug: "payment_proof_waiting",
      },
    });

    const markup = JSON.stringify(sent[0]?.replyMarkup);
    expect(markup).toContain("opx:payok:112:79");
    expect(markup).toContain("opx:reply:112:79");
    expect(markup).not.toContain("opx:payout:112:79");
    expect(markup).toContain("return_ai");
  });

  it("generic operator_request: payout stage → payout + reply buttons", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "operator-chat" })]),
      "fake-token",
      "https://app.example",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));

    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 112,
      contactId: 10,
      data: {
        displayName: "Пётр",
        reason: "operator_request",
        title: "Разобрать обмен вручную",
        action: "Продолжить вручную или вернуть AI.",
        orderId: 79,
        stageSlug: "payment_verified",
      },
    });

    const markup = JSON.stringify(sent[0]?.replyMarkup);
    expect(markup).toContain("opx:payout:112:79");
    expect(markup).toContain("opx:reply:112:79");
    expect(markup).not.toContain("opx:payok:112:79");
    expect(markup).toContain("return_ai");
  });

  it("sendTestMessage: без токена → ok:false 'Бот не настроен'", async () => {
    const svc = new NotificationService(makeRepo(), "", "http://app");
    expect(await svc.sendTestMessage("chat-1")).toEqual({
      ok: false,
      error: "Бот не настроен (нет токена)",
    });
  });

  it("sendTestMessage: успешная отправка тестового сообщения", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(makeRepo(), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));
    expect(await svc.sendTestMessage("chat-1")).toEqual({ ok: true });
    expect(sent[0]?.chatId).toBe("chat-1");
    expect(sent[0]?.text).toContain("Тестовое уведомление");
  });

  it("sendTestMessage: ошибка клиента → ok:false + message", async () => {
    const svc = new NotificationService(makeRepo(), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(() => {
      throw new Error("tg down");
    });
    expect(await svc.sendTestMessage("chat-1")).toEqual({
      ok: false,
      error: "tg down",
    });
  });

  it("sendDirectMessage: без токена → ok:false 'Бот не настроен'", async () => {
    const svc = new NotificationService(makeRepo(), "", "http://app");
    expect(await svc.sendDirectMessage("chat-2", "<b>x</b>")).toEqual({
      ok: false,
      error: "Бот не настроен (нет токена)",
    });
  });

  it("sendDirectMessage: успех — текст уходит как есть (HTML)", async () => {
    const sent: SendMessageInput[] = [];
    const svc = new NotificationService(makeRepo(), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));
    expect(await svc.sendDirectMessage("chat-2", "<b>прямое</b>")).toEqual({
      ok: true,
    });
    expect(sent[0]?.chatId).toBe("chat-2");
    expect(sent[0]?.text).toBe("<b>прямое</b>");
  });

  it("sendDirectMessage: не-Error throw → стрингифицированная ошибка", async () => {
    const svc = new NotificationService(makeRepo(), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(() => {
      // eslint-style string throw — ветка String(err)
      throw "boom";
    });
    expect(await svc.sendDirectMessage("chat-2", "x")).toEqual({
      ok: false,
      error: "boom",
    });
  });

  it("with informer: skips owner in per-operator loop, still notifies other operators + calls informer", async () => {
    const sent: string[] = [];
    let emitted = 0;
    const owner = makeOperatorSettings({
      adminId: 10,
      telegramChatId: "owner-chat",
      notifyOnAssignedOnly: false,
    });
    const other = makeOperatorSettings({
      adminId: 11,
      telegramChatId: "other-chat",
      notifyOnAssignedOnly: false,
    });
    const informer = {
      resolveOwnerAdminId: async () => 10,
      emitNotificationEvent: async () => {
        emitted++;
      },
    } as unknown as AdminInformer;
    const svc = new NotificationService(
      makeRepo([], [owner, other]),
      "fake-token",
      "http://app",
      informer,
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient(({ chatId }) => sent.push(String(chatId)));
    await svc.notify(BASE_EVENT);
    expect(emitted).toBe(1); // владелец обслужен информером
    expect(sent).toContain("other-chat"); // не-владельцу шлём как раньше
    expect(sent).not.toContain("owner-chat"); // владельца пропустили (без дублей)
  });
  // media preview: sendReferencedMedia (no downloader) and catch/defaultContentType
  it("sendReferencedMedia: no downloader → sendPhoto/Video/VideoNote/Document fileId paths", async () => {
    const calls: TelegramCall[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "chat-r" })]),
      "tok",
      "http://a",
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramMediaClient((c) => calls.push(c));
    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 1,
      contactId: 1,
      data: {
        displayName: "X",
        reason: "kyc_review",
        title: "T",
        action: "A",
        mediaRefsJson: JSON.stringify([
          { kind: "photo", channelId: "7", externalRef: "p1" },
          { kind: "video", channelId: "7", externalRef: "v1" },
          { kind: "video_note", channelId: "7", externalRef: "vn1" },
          { kind: "document", channelId: "7", externalRef: "d1" },
        ]),
      },
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("sendPhoto");
    expect(methods).toContain("sendVideo");
    expect(methods).toContain("sendVideoNote");
    expect(methods).toContain("sendDocument");
  });

  it("downloadPreviewMedia: 500 response → catch fires, falls through to sendReferencedMedia", async () => {
    const calls: TelegramCall[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "chat-r" })]),
      "tok",
      "http://a",
      undefined,
      async () => new Response("err", { status: 500 }),
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramMediaClient((c) => calls.push(c));
    const orig = console.error;
    console.error = () => {};
    try {
      await svc.notify({
        tenantId: 1,
        eventType: "operator_handoff_required",
        conversationId: 1,
        contactId: 1,
        data: {
          displayName: "X",
          reason: "kyc_review",
          title: "T",
          action: "A",
          mediaRefsJson: JSON.stringify([{ kind: "photo", channelId: "7", externalRef: "p1" }]),
        },
      });
    } finally {
      console.error = orig;
    }
    // Download failed → upload=null → sendReferencedMedia called
    expect(calls.some((c) => c.method === "sendPhoto")).toBe(true);
  });

  it("downloadPreviewMedia: response без content-type → defaultContentType fallback", async () => {
    const calls: TelegramCall[] = [];
    const svc = new NotificationService(
      makeRepo([], [makeOperatorSettings({ telegramChatId: "chat-r" })]),
      "tok",
      "http://a",
      undefined,
      async () => new Response("bytes"),
    );
    // @ts-expect-error patch private client
    svc.client = fakeTelegramMediaClient((c) => calls.push(c));
    await svc.notify({
      tenantId: 1,
      eventType: "operator_handoff_required",
      conversationId: 1,
      contactId: 1,
      data: {
        displayName: "X",
        reason: "kyc_review",
        title: "T",
        action: "A",
        mediaRefsJson: JSON.stringify([
          { kind: "photo", channelId: "7", externalRef: "p1" },
          { kind: "video", channelId: "7", externalRef: "v1" },
          { kind: "video_note", channelId: "7", externalRef: "vn1" },
          { kind: "document", channelId: "7", externalRef: "d1" },
        ]),
      },
    });
    // All uploaded via defaultContentType (photo→jpeg, video→mp4, note→mp4, doc→octet-stream)
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("sendPhotoUpload");
    expect(methods).toContain("sendVideoUpload");
    expect(methods).toContain("sendVideoNoteUpload");
    expect(methods).toContain("sendDocumentUpload");
  });
});

// ── notify — форум-топики (#651) ─────────────────────────────────────────────

import {
  conversations as conversationsTable,
  operatorSettings as operatorSettingsTable,
} from "@chatman-media/storage";

type ForumDbState = {
  operatorThreadId: number | null;
  assignedAdminId: number | null;
  hasOperator: boolean;
};

/**
 * Минимальная фейковая db для ensureOperatorTopic / pickLeastBusyOperator.
 * Драйвит withTenant(transaction) + select(conversations/operatorSettings) +
 * update(conversations).returning.
 */
function makeForumDb(initial: Partial<ForumDbState> = {}) {
  const state: ForumDbState = {
    operatorThreadId: initial.operatorThreadId ?? null,
    assignedAdminId: initial.assignedAdminId ?? null,
    hasOperator: initial.hasOperator ?? true,
  };
  const updates: Array<Record<string, unknown>> = [];

  const tx = {
    execute: async () => {},
    select: (_fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === conversationsTable) {
          return {
            where: () => ({
              // ensureOperatorTopic: select operator_thread_id/assignee
              limit: async () => [
                {
                  operatorThreadId: state.operatorThreadId,
                  assignedAdminId: state.assignedAdminId,
                },
              ],
              // pickLeastBusyOperator: load groupBy по assignee
              groupBy: async () =>
                state.assignedAdminId != null ? [{ adminId: state.assignedAdminId, open: 1 }] : [],
            }),
          };
        }
        if (table === operatorSettingsTable) {
          return {
            innerJoin: () => ({
              where: async () =>
                state.hasOperator ? [{ adminId: 10, name: null, email: "op@demo.io" }] : [],
            }),
          };
        }
        return { where: () => ({ limit: async () => [] }) };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        if (table === conversationsTable) updates.push(values);
        return {
          where: () => ({
            returning: async () => {
              // Пишем тред только если ещё пуст (isNull-гард).
              if (table === conversationsTable && state.operatorThreadId == null) {
                state.operatorThreadId = (values.operatorThreadId as number) ?? null;
                if (typeof values.assignedAdminId === "number") {
                  state.assignedAdminId = values.assignedAdminId;
                }
                return [{ operatorThreadId: state.operatorThreadId }];
              }
              return [];
            },
          }),
        };
      },
    }),
  };
  const db = {
    transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db, state, updates };
}

const FORUM_HANDOFF: NotificationEvent = {
  tenantId: 1,
  eventType: "operator_handoff_required",
  conversationId: 32,
  contactId: 7,
  data: {
    displayName: "Иван",
    amount: "500 USDT",
    reason: "operator_request",
    title: "Разобрать вручную",
    action: "Проверить заявку.",
  },
};

describe("NotificationService forum topics (#651)", () => {
  function forumService(
    dbObj: unknown,
    onSend: (input: SendMessageInput) => void,
    createForumTopic?: (input: {
      chatId: number | string;
      name: string;
    }) => Promise<{ message_thread_id: number; name: string }>,
  ) {
    const rule = makeRule({
      eventType: "operator_handoff_required",
      targetId: "group-forum",
      targetIsForum: true,
    });
    const svc = new NotificationService(
      makeRepo([rule]),
      "fake-token",
      "http://app",
      undefined,
      undefined,
      dbObj as never,
    );
    const client = {
      sendMessage: async (input: SendMessageInput) => {
        onSend(input);
        return telegramResult(input);
      },
      createForumTopic:
        createForumTopic ??
        (async ({ name }: { name: string }) => ({
          message_thread_id: 777,
          name,
        })),
    } as unknown as TelegramClient;
    // @ts-expect-error patch private client
    svc.client = client;
    return svc;
  }

  it("forum group → creates topic and sends card with messageThreadId", async () => {
    const sent: SendMessageInput[] = [];
    const topicNames: string[] = [];
    const { db, state } = makeForumDb({ operatorThreadId: null });
    const svc = forumService(
      db,
      (input) => sent.push(input),
      async ({ name }) => {
        topicNames.push(name);
        return { message_thread_id: 777, name };
      },
    );
    await svc.notify(FORUM_HANDOFF);

    // Топик создан и его id записан на диалог.
    expect(state.operatorThreadId).toBe(777);
    // Карточка ушла В ТРЕД.
    expect(sent[0]?.chatId).toBe("group-forum");
    expect(sent[0]?.messageThreadId).toBe(777);
    // Имя топика — контекст диалога + «занято: @operator» (пул).
    expect(topicNames[0]).toContain("Иван");
    expect(topicNames[0]).toContain("500 USDT");
    expect(topicNames[0]).toContain("#32");
    expect(topicNames[0]).toContain("занято: @op");
    // Оператор назначен (least-busy).
    expect(state.assignedAdminId).toBe(10);
  });

  it("forum group → reuses existing topic, does NOT re-create", async () => {
    const sent: SendMessageInput[] = [];
    let created = 0;
    const { db } = makeForumDb({ operatorThreadId: 555 });
    const svc = forumService(
      db,
      (input) => sent.push(input),
      async ({ name }) => {
        created++;
        return { message_thread_id: 999, name };
      },
    );
    await svc.notify(FORUM_HANDOFF);

    expect(created).toBe(0); // тред уже есть — не пересоздаём
    expect(sent[0]?.messageThreadId).toBe(555);
  });

  it("non-forum group → unchanged: no topic, no thread id", async () => {
    const sent: SendMessageInput[] = [];
    let created = 0;
    const { db } = makeForumDb({ operatorThreadId: null });
    const rule = makeRule({
      eventType: "operator_handoff_required",
      targetId: "group-plain",
      targetIsForum: false,
    });
    const svc = new NotificationService(
      makeRepo([rule]),
      "fake-token",
      "http://app",
      undefined,
      undefined,
      db as never,
    );
    const client = {
      sendMessage: async (input: SendMessageInput) => {
        sent.push(input);
        return telegramResult(input);
      },
      createForumTopic: async ({ name }: { name: string }) => {
        created++;
        return { message_thread_id: 1, name };
      },
    } as unknown as TelegramClient;
    // @ts-expect-error patch private client
    svc.client = client;
    await svc.notify(FORUM_HANDOFF);

    expect(created).toBe(0);
    expect(sent[0]?.chatId).toBe("group-plain");
    expect(sent[0]?.messageThreadId).toBeUndefined();
  });

  it("no db → forum flag ignored (byte-for-byte unchanged)", async () => {
    const sent: SendMessageInput[] = [];
    const rule = makeRule({
      eventType: "operator_handoff_required",
      targetId: "group-forum",
      targetIsForum: true,
    });
    const svc = new NotificationService(makeRepo([rule]), "fake-token", "http://app");
    // @ts-expect-error patch private client
    svc.client = fakeTelegramClient((input) => sent.push(input));
    await svc.notify(FORUM_HANDOFF);

    expect(sent[0]?.chatId).toBe("group-forum");
    expect(sent[0]?.messageThreadId).toBeUndefined();
  });

  it("createForumTopic failure → falls back to general chat (no thread id)", async () => {
    const sent: SendMessageInput[] = [];
    const { db, state } = makeForumDb({ operatorThreadId: null });
    const svc = forumService(
      db,
      (input) => sent.push(input),
      async () => {
        throw new Error("not a forum / bot lacks rights");
      },
    );
    const originalError = console.error;
    console.error = () => {};
    try {
      await svc.notify(FORUM_HANDOFF);
    } finally {
      console.error = originalError;
    }

    // Карточка всё равно ушла — в общий чат, без треда.
    expect(state.operatorThreadId).toBeNull();
    expect(sent[0]?.chatId).toBe("group-forum");
    expect(sent[0]?.messageThreadId).toBeUndefined();
  });
});
