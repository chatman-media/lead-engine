import { TelegramClient } from "@chatman-media/channel-telegram";
import type { NotificationsRepo, NotificationRule } from "./dal/notifications.ts";

export interface NotificationEvent {
  tenantId: number;
  eventType: string;
  leadId?: number;
  conversationId?: number;
  contactId?: number;
  data: Record<string, any>;
}

export class NotificationService {
  private client: TelegramClient | null = null;

  constructor(
    private readonly repo: NotificationsRepo,
    private readonly botToken: string,
    private readonly appUrl: string
  ) {
    if (botToken) {
      this.client = new TelegramClient({ token: botToken });
    }
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (!this.client) return;

    const rules = await this.repo.findRulesByEvent(event.tenantId, event.eventType);
    const filteredRules = rules.filter((rule) => this.matchesCondition(rule, event));

    for (const rule of filteredRules) {
      try {
        await this.sendNotification(rule, event);
      } catch (err) {
        console.error(`Failed to send notification for rule ${rule.id}:`, err);
      }
    }
  }

  private matchesCondition(rule: NotificationRule, event: NotificationEvent): boolean {
    if (!rule.conditionJson) return true;
    try {
      const condition = JSON.parse(rule.conditionJson);
      for (const [key, value] of Object.entries(condition)) {
        if (event.data[key] !== value) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private async sendNotification(rule: NotificationRule, event: NotificationEvent): Promise<void> {
    if (!this.client) return;

    const template = await this.repo.findTemplate(event.tenantId, event.eventType);
    const text = template 
      ? this.renderTemplate(template.body, event)
      : this.formatMessage(event);

    const buttons = this.formatButtons(event);

    await this.client.sendMessage({
      chat_id: rule.targetId,
      text,
      parse_mode: "HTML",
      reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
    });
  }

  private renderTemplate(body: string, event: NotificationEvent): string {
    let result = body;
    const vars = {
      ...event.data,
      leadId: event.leadId,
      conversationId: event.conversationId,
      tenantId: event.tenantId,
    };

    for (const [key, value] of Object.entries(vars)) {
      const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, "g");
      result = result.replace(placeholder, String(value ?? ""));
    }
    
    // Очистка неиспользованных плейсхолдеров
    result = result.replace(/\{\{.*?\}\}/g, "");
    
    return result;
  }

  private formatMessage(event: NotificationEvent): string {
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

  private formatButtons(event: NotificationEvent): any[] | null {
    const buttons = [];

    if (event.leadId) {
      const url = `${this.appUrl}/admin/leads/${event.leadId}`;
      buttons.push({ text: "👁 Посмотреть", url });
    } else if (event.conversationId) {
      const url = `${this.appUrl}/admin/conversations/${event.conversationId}`;
      buttons.push({ text: "👁 Чат", url });
    }

    return buttons.length > 0 ? buttons : null;
  }

  private getEventEmoji(type: string): string {
    switch (type) {
      case "lead_intake_complete": return "🆕";
      case "stage_changed": return "🔄";
      case "human_takeover": return "🆘";
      case "document_uploaded": return "📸";
      case "high_value_deal": return "💎";
      case "lead_stale": return "⏰";
      default: return "🔔";
    }
  }

  private getEventTitle(type: string): string {
    switch (type) {
      case "lead_intake_complete": return "Новый лид";
      case "stage_changed": return "Смена стадии";
      case "human_takeover": return "Нужна помощь оператора";
      case "document_uploaded": return "Загружен документ";
      case "high_value_deal": return "Крупная сделка";
      case "lead_stale": return "Лид завис";
      default: return "Уведомление";
    }
  }

  private formatKey(key: string): string {
    const map: Record<string, string> = {
      amount: "Сумма",
      asset: "Актив",
      network: "Сеть",
      phone: "Телефон",
      email: "Email",
    };
    return map[key] || key;
  }
}
