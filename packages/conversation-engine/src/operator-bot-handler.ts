import { TelegramClient, type TgUpdate } from "@chatman-media/channel-telegram";
import type { NotificationsRepo } from "./dal/notifications.ts";

export class OperatorBotHandler {
  private client: TelegramClient | null = null;

  constructor(
    private readonly repo: NotificationsRepo,
    private readonly botToken: string
  ) {
    if (botToken) {
      this.client = new TelegramClient({ token: botToken });
    }
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (!this.client || !update.message) return;

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

    // 3. Базовый /start без параметров
    if (text === "/start") {
      await this.client.sendMessage({
        chat_id: chatId,
        text: "👋 Привет! Я бот-уведомитель для Lead Engine.\n\nЧтобы привязать свой аккаунт, перейдите в Админку -> Настройки уведомлений и нажмите 'Подключить Telegram'.",
      });
    }
  }

  private async handleLinkToken(token: string, chatId: string): Promise<void> {
    if (!this.client) return;

    const settings = await this.repo.findByLinkToken(token);
    if (!settings) {
      await this.client.sendMessage({
        chat_id: chatId,
        text: "❌ Ссылка недействительна или истекла. Пожалуйста, сгенерируйте новую в Админке.",
      });
      return;
    }

    await this.repo.linkChat(settings.adminId, chatId);

    await this.client.sendMessage({
      chat_id: chatId,
      text: "✅ Аккаунт успешно привязан! Теперь вы будете получать важные уведомления здесь.",
    });
  }

  private async handleGroupLinkToken(token: string, chatId: number, title: string): Promise<void> {
    if (!this.client) return;
    const isGroup = chatId < 0;
    if (!isGroup) {
      await this.client.sendMessage({
        chat_id: String(chatId),
        text: "❌ /setup с токеном работает только в группах. Добавьте бота в группу и отправьте там эту команду.",
      });
      return;
    }
    const groupToken = await this.repo.findGroupLinkToken(token);
    if (!groupToken) {
      await this.client.sendMessage({
        chat_id: String(chatId),
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
      chat_id: String(chatId),
      text: `✅ Группа <b>${title}</b> подключена к Lead Engine!\n\nОтсюда вы будете получать уведомления о событиях: <b>${groupToken.eventType}</b>.`,
      parse_mode: "HTML",
    });
  }

  private async handleSetupGroup(chatId: number, title: string): Promise<void> {
    if (!this.client) return;

    const isGroup = chatId < 0;
    if (!isGroup) {
      await this.client.sendMessage({
        chat_id: String(chatId),
        text: "команда /setup работает только в группах. Добавьте меня в группу и напишите там /setup.",
      });
      return;
    }

    await this.client.sendMessage({
      chat_id: String(chatId),
      text: `🏗 <b>Настройка группы "${title}"</b>\n\nID этой группы: <code>${chatId}</code>\n\nСкопируйте этот ID и вставьте его в настройки уведомлений в Админке, чтобы бот мог присылать сюда алерты.`,
      parse_mode: "HTML",
    });
  }
}
