import {
  TelegramClient,
  type TgCallbackQuery,
  type TgReplyMarkup,
  type TgUpdate,
} from "@chatman-media/channel-telegram";
import type { NotificationsRepo, OperatorSettings } from "./dal/notifications.ts";
import {
  type OperatorActionPayload,
  parseOperatorActionCallbackData,
} from "./operator-bot-actions.ts";

// ── Информер: справочники для команд ────────────────────────────────────────

const LEVELS = ["silent", "critical", "important", "all"] as const;
const LEVEL_LABEL: Record<string, string> = {
  silent: "🔕 Тихо",
  critical: "🔴 Только критичное",
  important: "🟡 Важное",
  all: "📢 Всё подряд",
};

const TOPICS = ["leads", "escalation", "orders", "system"] as const;
const TOPIC_LABEL: Record<string, string> = {
  leads: "🆕 Лиды",
  escalation: "🆘 Эскалации",
  orders: "💱 Заявки",
  system: "🛠 Система",
};

const DIGESTS = ["off", "daily", "shift"] as const;
const DIGEST_LABEL: Record<string, string> = {
  off: "Выкл",
  daily: "Раз в день",
  shift: "2×/день",
};

const SEV_EMOJI: Record<string, string> = { critical: "🔴", important: "🟡", info: "ℹ️" };

function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** "2h" / "30m" / "1d" → секунды; "off"/"0"/"" → 0; мусор → null. */
export function parseMuteSeconds(arg: string): number | null {
  const a = arg.trim().toLowerCase();
  if (!a || a === "off" || a === "0") return 0;
  const m = /^(\d+)\s*(m|h|d)$/.exec(a);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unit = m[2];
  return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
}

export class OperatorBotHandler {
  private client: TelegramClient | null = null;
  private readonly appUrl: string;

  constructor(
    private readonly repo: NotificationsRepo,
    private readonly botToken: string,
    opts: { appUrl?: string } = {},
  ) {
    this.appUrl = (opts.appUrl ?? "").replace(/\/$/, "");
    if (botToken) {
      this.client = new TelegramClient({ token: botToken });
    }
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (!this.client) return;

    // Нажатия inline-кнопок (настройки информера).
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (!update.message) return;
    const { message } = update;
    const text = message.text || "";
    const chatId = String(message.chat.id);

    // 1. Личная привязка по /start <token>
    if (text.startsWith("/start ")) {
      const token = text.split(" ")[1];
      if (token) {
        await this.handleLinkToken(token, chatId);
        return;
      }
    }

    // 2. Привязка группы по /setup <token>
    if (text.startsWith("/setup ")) {
      const token = text.split(" ")[1];
      if (token) {
        await this.handleGroupLinkToken(token, message.chat.id, message.chat.title || "группа");
        return;
      }
    }

    // 2b. /setup без токена — показать ID группы
    if (text === "/setup" || text.startsWith("/setup@")) {
      await this.handleSetupGroup(message.chat.id, message.chat.title || "эту группу");
      return;
    }

    // 3. Команды информера (личный чат владельца/оператора).
    if (text === "/status") return this.cmdStatus(chatId);
    if (text === "/level") return this.cmdLevel(chatId);
    if (text === "/topics") return this.cmdTopics(chatId);
    if (text === "/digest") return this.cmdDigest(chatId);
    if (text === "/mute" || text.startsWith("/mute ")) return this.cmdMute(chatId, text);
    if (text === "/last" || text.startsWith("/last ")) return this.cmdLast(chatId, text);

    // 4. Базовый /start без параметров
    if (text === "/start") {
      await this.client.sendMessage({
        chatId,
        parseMode: "HTML",
        text:
          "👋 Привет! Я бот-информер Lead Engine.\n\n" +
          "Чтобы привязать аккаунт — Админка → Уведомления → «Подключить Telegram».\n\n" +
          "Когда привязан, настраивай прямо здесь:\n" +
          "• /status — текущие настройки\n" +
          "• /level — насколько громко информировать\n" +
          "• /topics — какие темы слать\n" +
          "• /digest — сводка (выкл/раз в день/2×)\n" +
          "• /mute 2h — заглушить на время\n" +
          "• /last — последние события",
      });
    }
  }

  // ── Команды информера ──────────────────────────────────────────────────

  private async cmdStatus(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    const now = Math.floor(Date.now() / 1000);
    const muted =
      s.informerMutedUntil && s.informerMutedUntil > now
        ? `вкл (ещё ${Math.ceil((s.informerMutedUntil - now) / 60)} мин)`
        : "выкл";
    const map = this.topicMap(s.informerTopics);
    const topicsLine = TOPICS.map((t) => `${map[t] ? "✅" : "⬜"} ${TOPIC_LABEL[t]}`).join("\n");
    await this.client?.sendMessage({
      chatId,
      parseMode: "HTML",
      text:
        "⚙️ <b>Информер</b>\n\n" +
        `Уровень: <b>${LEVEL_LABEL[s.informerLevel] ?? s.informerLevel}</b>\n` +
        `Дайджест: <b>${DIGEST_LABEL[s.informerDigest] ?? s.informerDigest}</b> ` +
        `(${s.informerDigestHour}:00 ${s.informerTz})\n` +
        `Мут: <b>${muted}</b>\n\n` +
        `Темы:\n${topicsLine}\n\n` +
        "Изменить: /level · /topics · /digest · /mute",
    });
  }

  private async cmdLevel(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Насколько громко информировать?",
      replyMarkup: this.levelKeyboard(s.informerLevel),
    });
  }

  private async cmdTopics(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Темы (нажми, чтобы вкл/выкл):",
      replyMarkup: this.topicsKeyboard(this.topicMap(s.informerTopics)),
    });
  }

  private async cmdDigest(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Как часто слать сводку?",
      replyMarkup: this.digestKeyboard(s.informerDigest),
    });
  }

  private async cmdMute(chatId: string, text: string): Promise<void> {
    const arg = text.split(/\s+/)[1] ?? "";
    const sec = parseMuteSeconds(arg);
    if (sec === null) {
      await this.client?.sendMessage({
        chatId,
        text: "Формат: /mute 30m · /mute 2h · /mute 1d · /mute off",
      });
      return;
    }
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    const until = sec === 0 ? null : Math.floor(Date.now() / 1000) + sec;
    await this.repo.updateInformerPrefs(s.adminId, { informerMutedUntil: until });
    await this.client?.sendMessage({
      chatId,
      text: until
        ? `🔇 Заглушено на ${Math.round(sec / 60)} мин. Реалтайм вернётся, события всё равно попадут в дайджест.`
        : "🔔 Мут снят.",
    });
  }

  private async cmdLast(chatId: string, text: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    const arg = Number.parseInt(text.split(/\s+/)[1] ?? "", 10);
    const limit = Number.isFinite(arg) ? Math.min(Math.max(arg, 1), 20) : 10;
    const rows = await this.repo.listRecentNotifications(s.tenantId, s.adminId, limit);
    if (rows.length === 0) {
      await this.client?.sendMessage({ chatId, text: "Пока пусто — событий ещё не было." });
      return;
    }
    let msg = `🗒 <b>Последние ${rows.length}:</b>`;
    for (const r of rows) {
      const when = new Date(r.createdAt * 1000).toISOString().slice(5, 16).replace("T", " ");
      msg += `\n\n${SEV_EMOJI[r.severity] ?? ""} <b>${escapeHtml(r.title)}</b> · ${when}`;
      if (r.body) msg += `\n${escapeHtml(r.body)}`;
    }
    await this.client?.sendMessage({ chatId, parseMode: "HTML", text: msg });
  }

  // ── Callback (нажатия кнопок) ──────────────────────────────────────────

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    if (!this.client) return;
    const chatId = String(cq.message?.chat.id ?? cq.from.id);
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) {
      await this.client.answerCallbackQuery({ callbackQueryId: cq.id, text: "Аккаунт не привязан" });
      return;
    }

    const operatorAction = parseOperatorActionCallbackData(cq.data);
    if (operatorAction.ok) {
      await this.handleOperatorAction(cq, s, operatorAction.payload);
      return;
    }
    if (operatorAction.reason === "malformed") {
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: "Кнопка устарела",
        showAlert: true,
      });
      return;
    }

    const [kind, val] = (cq.data ?? "").split(":");

    if (kind === "lvl" && (LEVELS as readonly string[]).includes(val ?? "")) {
      await this.repo.updateInformerPrefs(s.adminId, { informerLevel: val });
      await this.editKeyboard(cq, "Насколько громко информировать?", this.levelKeyboard(val as string));
      await this.client.answerCallbackQuery({ callbackQueryId: cq.id, text: LEVEL_LABEL[val as string] });
      return;
    }
    if (kind === "dig" && (DIGESTS as readonly string[]).includes(val ?? "")) {
      await this.repo.updateInformerPrefs(s.adminId, { informerDigest: val });
      await this.editKeyboard(cq, "Как часто слать сводку?", this.digestKeyboard(val as string));
      await this.client.answerCallbackQuery({ callbackQueryId: cq.id, text: DIGEST_LABEL[val as string] });
      return;
    }
    if (kind === "tpc" && (TOPICS as readonly string[]).includes(val ?? "")) {
      const map = this.topicMap(s.informerTopics);
      map[val as string] = !map[val as string];
      await this.repo.updateInformerPrefs(s.adminId, { informerTopics: JSON.stringify(map) });
      await this.editKeyboard(cq, "Темы (нажми, чтобы вкл/выкл):", this.topicsKeyboard(map));
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: `${TOPIC_LABEL[val as string]}: ${map[val as string] ? "вкл" : "выкл"}`,
      });
      return;
    }
    await this.client.answerCallbackQuery({ callbackQueryId: cq.id });
  }

  private async handleOperatorAction(
    cq: TgCallbackQuery,
    settings: OperatorSettings,
    payload: OperatorActionPayload,
  ): Promise<void> {
    if (!this.client) return;
    if (payload.tenantId !== settings.tenantId) {
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: "Нет доступа к этому чату",
        showAlert: true,
      });
      return;
    }

    if (payload.action === "open_chat") {
      const url = this.conversationUrl(payload.conversationId);
      await this.client.answerCallbackQuery(
        url
          ? { callbackQueryId: cq.id, url }
          : {
              callbackQueryId: cq.id,
              text: `Откройте чат #${payload.conversationId} в админке`,
              showAlert: true,
            },
      );
      return;
    }

    const outcome = await this.repo.applyOperatorConversationModeAction({
      tenantId: payload.tenantId,
      adminId: settings.adminId,
      conversationId: payload.conversationId,
      action: payload.action,
    });
    if (outcome.kind === "not_found") {
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: "Чат не найден или уже недоступен",
        showAlert: true,
      });
      return;
    }

    const modeLabel = payload.action === "takeover" ? "оператор" : "AI";
    await this.client.answerCallbackQuery({
      callbackQueryId: cq.id,
      text: outcome.kind === "noop" ? `Уже в режиме: ${modeLabel}` : `Готово: режим ${modeLabel}`,
    });
  }

  private conversationUrl(conversationId: number): string | null {
    if (!this.appUrl) return null;
    return `${this.appUrl}/conversations/${conversationId}`;
  }

  private async editKeyboard(
    cq: TgCallbackQuery,
    text: string,
    markup: TgReplyMarkup,
  ): Promise<void> {
    if (!this.client || !cq.message) return;
    await this.client
      .editMessageText({
        chatId: cq.message.chat.id,
        messageId: cq.message.message_id,
        text,
        replyMarkup: markup,
      })
      .catch(() => {});
  }

  // ── Клавиатуры / хелперы ───────────────────────────────────────────────

  private levelKeyboard(current: string): TgReplyMarkup {
    return {
      inline_keyboard: LEVELS.map((l) => [
        { text: `${l === current ? "• " : ""}${LEVEL_LABEL[l]}`, callback_data: `lvl:${l}` },
      ]),
    };
  }

  private digestKeyboard(current: string): TgReplyMarkup {
    return {
      inline_keyboard: DIGESTS.map((d) => [
        { text: `${d === current ? "• " : ""}${DIGEST_LABEL[d]}`, callback_data: `dig:${d}` },
      ]),
    };
  }

  private topicsKeyboard(map: Record<string, boolean>): TgReplyMarkup {
    return {
      inline_keyboard: TOPICS.map((t) => [
        { text: `${map[t] ? "✅" : "⬜"} ${TOPIC_LABEL[t]}`, callback_data: `tpc:${t}` },
      ]),
    };
  }

  /** JSON-карта тоглов → полная карта {topic:bool} с дефолтом true. */
  private topicMap(raw: string | null): Record<string, boolean> {
    const base: Record<string, boolean> = {
      leads: true,
      escalation: true,
      orders: true,
      system: true,
    };
    if (!raw) return base;
    try {
      const m = JSON.parse(raw) as Record<string, boolean>;
      for (const t of TOPICS) if (m[t] === false) base[t] = false;
      return base;
    } catch {
      return base;
    }
  }

  private async replyNotLinked(chatId: string): Promise<void> {
    await this.client?.sendMessage({
      chatId,
      text: "Сначала привяжите аккаунт: Админка → Уведомления → «Подключить Telegram».",
    });
  }

  // ── Привязка (без изменений) ───────────────────────────────────────────

  private async handleLinkToken(token: string, chatId: string): Promise<void> {
    if (!this.client) return;

    const settings = await this.repo.findByLinkToken(token);
    if (!settings) {
      await this.client.sendMessage({
        chatId,
        text: "❌ Ссылка недействительна или истекла. Пожалуйста, сгенерируйте новую в Админке.",
      });
      return;
    }

    await this.repo.linkChat(settings.adminId, chatId);

    await this.client.sendMessage({
      chatId,
      text: "✅ Аккаунт привязан! Здесь будут важные уведомления. Настрой громкость: /level · /topics · /digest",
    });
  }

  private async handleGroupLinkToken(token: string, chatId: number, title: string): Promise<void> {
    if (!this.client) return;
    const isGroup = chatId < 0;
    if (!isGroup) {
      await this.client.sendMessage({
        chatId: String(chatId),
        text: "❌ /setup с токеном работает только в группах. Добавьте бота в группу и отправьте там эту команду.",
      });
      return;
    }
    const groupToken = await this.repo.findGroupLinkToken(token);
    if (!groupToken) {
      await this.client.sendMessage({
        chatId: String(chatId),
        text: "❌ Токен недействителен или истёк. Сгенерируйте новый в Админке → Уведомления.",
      });
      return;
    }
    await this.repo.createRule({
      tenantId: groupToken.tenantId,
      eventType: groupToken.eventType,
      conditionJson: "{}",
      channelType: "telegram_group",
      targetId: String(chatId),
      priority: "normal",
      isActive: true,
    });
    await this.repo.deleteGroupLinkToken(token);
    await this.client.sendMessage({
      chatId: String(chatId),
      text: `✅ Группа <b>${title}</b> подключена к Lead Engine!\n\nОтсюда вы будете получать уведомления о событиях: <b>${groupToken.eventType}</b>.`,
      parseMode: "HTML",
    });
  }

  private async handleSetupGroup(chatId: number, title: string): Promise<void> {
    if (!this.client) return;

    const isGroup = chatId < 0;
    if (!isGroup) {
      await this.client.sendMessage({
        chatId: String(chatId),
        text: "команда /setup работает только в группах. Добавьте меня в группу и напишите там /setup.",
      });
      return;
    }

    await this.client.sendMessage({
      chatId: String(chatId),
      text: `🏗 <b>Настройка группы "${title}"</b>\n\nID этой группы: <code>${chatId}</code>\n\nСкопируйте этот ID и вставьте его в настройки уведомлений в Админке, чтобы бот мог присылать сюда алерты.`,
      parseMode: "HTML",
    });
  }
}
