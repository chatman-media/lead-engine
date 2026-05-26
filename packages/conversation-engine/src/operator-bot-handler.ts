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

    // 2. Настройка группы по /setup
    if (text === "/setup" || text === "/setup@operator_bot") { // Заменить на реальный username если нужно
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
