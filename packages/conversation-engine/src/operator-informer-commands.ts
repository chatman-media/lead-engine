// Обработчики команд informer-бота (/status /level /topics /digest /mute /last),
// вынесенные из operator-bot-handler. Коллабораторы — TelegramClient + repo
// (NotificationsRepo); UI-сборка и каталоги берутся из operator-informer-ui.

import type { TelegramClient } from "@chatman-media/channel-telegram";
import type { NotificationsRepo } from "./dal/notifications.ts";
import { escapeHtml, parseMuteSeconds } from "./operator-bot-shared.ts";
import {
  DIGEST_LABEL,
  digestKeyboard,
  LEVEL_LABEL,
  levelKeyboard,
  SEV_EMOJI,
  TOPIC_LABEL,
  TOPICS,
  topicMap,
  topicsKeyboard,
} from "./operator-informer-ui.ts";

export class InformerCommands {
  // client читается лениво: handler может выставить его после конструктора
  // (lazy-инициализация бота / инъекция в тестах).
  constructor(
    private readonly getClient: () => TelegramClient | null,
    private readonly repo: NotificationsRepo,
  ) {}

  private get client(): TelegramClient | null {
    return this.getClient();
  }

  async cmdStatus(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    const now = Math.floor(Date.now() / 1000);
    const muted =
      s.informerMutedUntil && s.informerMutedUntil > now
        ? `вкл (ещё ${Math.ceil((s.informerMutedUntil - now) / 60)} мин)`
        : "выкл";
    const map = topicMap(s.informerTopics);
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

  async cmdLevel(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Насколько громко информировать?",
      replyMarkup: levelKeyboard(s.informerLevel),
    });
  }

  async cmdTopics(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Темы (нажми, чтобы вкл/выкл):",
      replyMarkup: topicsKeyboard(topicMap(s.informerTopics)),
    });
  }

  async cmdDigest(chatId: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    await this.client?.sendMessage({
      chatId,
      text: "Как часто слать сводку?",
      replyMarkup: digestKeyboard(s.informerDigest),
    });
  }

  async cmdMute(chatId: string, text: string): Promise<void> {
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
    await this.repo.updateInformerPrefs(s.adminId, {
      informerMutedUntil: until,
    });
    await this.client?.sendMessage({
      chatId,
      text: until
        ? `🔇 Заглушено на ${Math.round(sec / 60)} мин. Реалтайм вернётся, события всё равно попадут в дайджест.`
        : "🔔 Мут снят.",
    });
  }

  async cmdLast(chatId: string, text: string): Promise<void> {
    const s = await this.repo.findOperatorSettingsByChatId(chatId);
    if (!s) return this.replyNotLinked(chatId);
    const arg = Number.parseInt(text.split(/\s+/)[1] ?? "", 10);
    const limit = Number.isFinite(arg) ? Math.min(Math.max(arg, 1), 20) : 10;
    const rows = await this.repo.listRecentNotifications(s.tenantId, s.adminId, limit);
    if (rows.length === 0) {
      await this.client?.sendMessage({
        chatId,
        text: "Пока пусто — событий ещё не было.",
      });
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

  private async replyNotLinked(chatId: string): Promise<void> {
    await this.client?.sendMessage({
      chatId,
      text: "Сначала привяжите аккаунт: Админка → Уведомления → «Подключить Telegram».",
    });
  }
}
