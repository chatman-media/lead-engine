// Чистая UI-часть informer-бота: каталоги уровней/тем/дайджеста и сборка
// inline-клавиатур настроек. Без БД/сети — переиспользуется командами (cmd*)
// и обработчиком callback'ов; тестируется юнитами.

import type { TgReplyMarkup } from "@chatman-media/channel-telegram";

export const LEVELS = ["silent", "critical", "important", "all"] as const;
export const LEVEL_LABEL: Record<string, string> = {
  silent: "🔕 Тихо",
  critical: "🔴 Только критичное",
  important: "🟡 Важное",
  all: "📢 Всё подряд",
};

export const TOPICS = ["leads", "escalation", "orders", "system"] as const;
export const TOPIC_LABEL: Record<string, string> = {
  leads: "🆕 Лиды",
  escalation: "🆘 Эскалации",
  orders: "💱 Заявки",
  system: "🛠 Система",
};

export const DIGESTS = ["off", "daily", "shift"] as const;
export const DIGEST_LABEL: Record<string, string> = {
  off: "Выкл",
  daily: "Раз в день",
  shift: "2×/день",
};

export function levelKeyboard(current: string): TgReplyMarkup {
  return {
    inline_keyboard: LEVELS.map((l) => [
      {
        text: `${l === current ? "• " : ""}${LEVEL_LABEL[l]}`,
        callback_data: `lvl:${l}`,
      },
    ]),
  };
}

export function digestKeyboard(current: string): TgReplyMarkup {
  return {
    inline_keyboard: DIGESTS.map((d) => [
      {
        text: `${d === current ? "• " : ""}${DIGEST_LABEL[d]}`,
        callback_data: `dig:${d}`,
      },
    ]),
  };
}

export function topicsKeyboard(map: Record<string, boolean>): TgReplyMarkup {
  return {
    inline_keyboard: TOPICS.map((t) => [
      {
        text: `${map[t] ? "✅" : "⬜"} ${TOPIC_LABEL[t]}`,
        callback_data: `tpc:${t}`,
      },
    ]),
  };
}

/** JSON-карта тоглов → полная карта {topic:bool} с дефолтом true. */
export function topicMap(raw: string | null): Record<string, boolean> {
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
