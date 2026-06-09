import { TelegramClient } from "@chatman-media/channel-telegram";
import type { AdminInformer } from "./admin-informer.ts";
import type { NotificationRule, NotificationsRepo } from "./dal/notifications.ts";
import {
  buildOperatorActionCallbackData,
  isOperatorHandoffEvent,
} from "./operator-bot-actions.ts";

export interface NotificationEvent {
  tenantId: number;
  eventType: string;
  leadId?: number;
  conversationId?: number;
  contactId?: number;
  /** assignedAdminId — если задан, проверяется notifyOnAssignedOnly */
  assignedAdminId?: number;
  data: Record<string, unknown>;
}

export class NotificationService {
  private client: TelegramClient | null = null;

  constructor(
    private readonly repo: NotificationsRepo,
    private readonly botToken: string,
    private readonly appUrl: string,
    /**
     * Если задан — владелец (superadmin) обслуживается информером (уровни +
     * дайджест + лента) и пропускается в per-operator-рассылке ниже, чтобы не
     * было дублей. Операторские правила/группы — без изменений.
     */
    private readonly informer?: AdminInformer,
  ) {
    if (botToken) {
      this.client = new TelegramClient({ token: botToken });
    }
  }

  async notify(event: NotificationEvent): Promise<void> {
    // Владелец — через информер (уровни/дайджест/лента), отдельно от операторов.
    const ownerAdminId = this.informer
      ? await this.informer.resolveOwnerAdminId(event.tenantId)
      : null;
    if (this.informer) {
      await this.informer.emitNotificationEvent(event);
    }

    if (!this.client) return;

    const [rules, operatorSettingsList] = await Promise.all([
      this.repo.findRulesByEvent(event.tenantId, event.eventType),
      this.repo.findOperatorSettingsByTenant(event.tenantId),
    ]);

    const template = await this.repo.findTemplate(event.tenantId, event.eventType);
    const text = template ? this.renderTemplate(template.body, event) : this.formatMessage(event);
    const buttons = this.formatButtons(event);

    // 1. Групповые/канальные правила
    const matchedRules = rules.filter((rule) => this.matchesCondition(rule, event));
    for (const rule of matchedRules) {
      try {
        await this.sendMessage(rule.targetId, text, buttons);
      } catch (err) {
        console.error(`[NotificationService] rule ${rule.id} send failed:`, err);
      }
    }

    // 2. Личные уведомления операторам через operator_settings
    for (const settings of operatorSettingsList) {
      if (!settings.telegramChatId) continue;
      // Владельца обслуживает информер — пропускаем, чтобы не дублировать.
      if (ownerAdminId !== null && settings.adminId === ownerAdminId) continue;
      // Фильтр по назначению: пропускаем если флаг включён, а лид назначен другому
      if (
        settings.notifyOnAssignedOnly &&
        event.assignedAdminId !== undefined &&
        event.assignedAdminId !== settings.adminId
      ) {
        continue;
      }
      try {
        await this.sendMessage(settings.telegramChatId, text, buttons);
      } catch (err) {
        console.error(`[NotificationService] personal send to admin ${settings.adminId} failed:`, err);
      }
    }
  }

  async sendTestMessage(chatId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "Бот не настроен (нет токена)" };
    try {
      await this.client.sendMessage({
        chatId,
        text: "🧪 <b>Тестовое уведомление</b>\n\nПравило активно — сообщения доходят корректно.",
        parseMode: "HTML",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendDirectMessage(
    chatId: string,
    htmlText: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "Бот не настроен (нет токена)" };
    try {
      await this.sendMessage(chatId, htmlText, null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sendMessage(
    chatId: string,
    text: string,
    buttons: Array<Array<{ text: string; url?: string; callback_data?: string }>> | null,
  ): Promise<void> {
    await this.client!.sendMessage({
      chatId,
      text,
      parseMode: "HTML",
      replyMarkup: buttons ? { inline_keyboard: buttons } : undefined,
    });
  }

  matchesCondition(rule: NotificationRule, event: NotificationEvent): boolean {
    if (!rule.conditionJson || rule.conditionJson === "{}") return true;
    try {
      const condition = JSON.parse(rule.conditionJson) as Record<string, unknown>;
      for (const [key, value] of Object.entries(condition)) {
        if (event.data[key] !== value) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  renderTemplate(body: string, event: NotificationEvent): string {
    const vars: Record<string, unknown> = {
      ...event.data,
      leadId: event.leadId,
      conversationId: event.conversationId,
      tenantId: event.tenantId,
    };
    let result = body;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value ?? ""));
    }
    return result.replace(/\{\{.{0,200}?\}\}/g, "");
  }

  formatMessage(event: NotificationEvent): string {
    const emoji = this.getEventEmoji(event.eventType);
    let msg = `${emoji} <b>${this.getEventTitle(event.eventType)}</b>\n\n`;

    if (event.data.displayName) {
      msg += `👤 <b>Клиент:</b> ${event.data.displayName}\n`;
    }

    for (const [key, value] of Object.entries(event.data)) {
      if (["displayName", "toStage", "fromStage"].includes(key)) continue;
      msg += `🔹 <b>${this.formatKey(key)}:</b> ${value}\n`;
    }

    if (event.data.fromStage && event.data.toStage) {
      msg += `\n🔄 <b>Стадия:</b> ${event.data.fromStage} ➡️ ${event.data.toStage}\n`;
    } else if (event.data.toStage) {
      msg += `\n📍 <b>Стадия:</b> ${event.data.toStage}\n`;
    }

    return msg;
  }

  private formatButtons(
    event: NotificationEvent,
  ): Array<Array<{ text: string; url?: string; callback_data?: string }>> | null {
    if (isOperatorHandoffEvent(event)) {
      const conversationId = event.conversationId as number;
      return [
        [
          {
            text: "👁 Открыть чат",
            callback_data: buildOperatorActionCallbackData({
              action: "open_chat",
              tenantId: event.tenantId,
              conversationId,
            }),
          },
        ],
        [
          {
            text: "🙋 Взять в работу",
            callback_data: buildOperatorActionCallbackData({
              action: "takeover",
              tenantId: event.tenantId,
              conversationId,
            }),
          },
          {
            text: "🤖 Вернуть AI",
            callback_data: buildOperatorActionCallbackData({
              action: "return_ai",
              tenantId: event.tenantId,
              conversationId,
            }),
          },
        ],
      ];
    }
    if (event.leadId) {
      return [[{ text: "👁 Посмотреть", url: `${this.appUrl}/leads/${event.leadId}` }]];
    }
    if (event.conversationId) {
      return [[{ text: "👁 Чат", url: `${this.appUrl}/conversations/${event.conversationId}` }]];
    }
    return null;
  }

  private getEventEmoji(type: string): string {
    const map: Record<string, string> = {
      lead_intake_complete: "🆕",
      stage_changed: "🔄",
      human_takeover: "🆘",
      document_uploaded: "📸",
      high_value_deal: "💎",
      lead_stale: "⏰",
      operator_confirm_needed: "✋",
      operator_handoff_required: "✋",
    };
    return map[type] ?? "🔔";
  }

  private getEventTitle(type: string): string {
    const map: Record<string, string> = {
      lead_intake_complete: "Новый лид",
      stage_changed: "Смена стадии",
      human_takeover: "Нужна помощь оператора",
      document_uploaded: "Загружен документ",
      high_value_deal: "Крупная сделка",
      lead_stale: "Лид завис",
      operator_confirm_needed: "Нужно подтверждение оператора",
      operator_handoff_required: "Нужно действие оператора",
    };
    return map[type] ?? "Уведомление";
  }

  private formatKey(key: string): string {
    const map: Record<string, string> = {
      amount: "Сумма",
      asset: "Актив",
      network: "Сеть",
      phone: "Телефон",
      email: "Email",
    };
    return map[key] ?? key;
  }
}
