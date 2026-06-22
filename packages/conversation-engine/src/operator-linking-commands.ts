// Привязка аккаунта/группы к informer-боту (/start <token>, /setup <token>,
// /setup), вынесенная из operator-bot-handler. Коллабораторы — TelegramClient
// + repo (NotificationsRepo). client читается лениво (handler выставляет после
// конструктора).

import type { TelegramClient } from "@chatman-media/channel-telegram";
import type { NotificationsRepo } from "./dal/notifications.ts";

export class LinkingCommands {
  constructor(
    private readonly getClient: () => TelegramClient | null,
    private readonly repo: NotificationsRepo,
  ) {}

  private get client(): TelegramClient | null {
    return this.getClient();
  }

  async handleLinkToken(token: string, chatId: string): Promise<void> {
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

  async handleGroupLinkToken(
    token: string,
    chatId: number,
    title: string,
    isForum = false,
  ): Promise<void> {
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
      // #651: форум-группа → 1 топик на диалог (см. NotificationService).
      targetIsForum: isForum,
      priority: "normal",
      isActive: true,
    });
    await this.repo.deleteGroupLinkToken(token);
    await this.client.sendMessage({
      chatId: String(chatId),
      text:
        `✅ Группа <b>${title}</b> подключена к Lead Engine!\n\n` +
        `Отсюда вы будете получать уведомления о событиях: <b>${groupToken.eventType}</b>.` +
        (isForum
          ? "\n\n🧵 Это форум-группа: каждый диалог получит свой топик, а ваш ответ в топике уйдёт тому клиенту."
          : ""),
      parseMode: "HTML",
    });
  }

  async handleSetupGroup(chatId: number, title: string): Promise<void> {
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
