/**
 * Настройки поведения бота по сообщениям (эпик #623). Хранятся одним JSON-блоком
 * в `tenants.bot_settings_json`, парсятся типизированно с дефолтами и клампингом.
 *
 * Дефолты подобраны так, что «пустые» настройки = текущее поведение (нулевая
 * регрессия): часы выкл, стоп-слов нет, дробления нет, STT вкл, авто-закрытие
 * выкл, параметры генерации — null (стратегия берёт свои дефолты 0.7/600/20).
 */
export interface BotSettings {
  // #629 — параметры генерации (null → дефолт стратегии).
  temperature: number | null; // 0..1.5
  maxOutputTokens: number | null; // 100..4000
  compactAfterMessages: number | null; // 5..100
  // #630/#631 — контент.
  fallbackText: string | null; // текст «уточню у оператора»
  greetingText: string | null; // авто-приветствие при первом сообщении
  // #625 — рабочие/тихие часы (минуты от полуночи в таймзоне tenant'а).
  hoursEnabled: boolean;
  hoursStartMin: number | null; // 0..1439
  hoursEndMin: number | null; // 0..1439
  hoursTz: string | null; // IANA, напр. "Asia/Manila"
  offhoursMessage: string | null; // авто-ответ вне часов (один раз за окно)
  // #626/#627 — эскалация к оператору.
  stopWords: string[]; // совпадение во входящем → сразу оператор
  handoffAfterFallbacks: number | null; // N фолбэков бота подряд → оператор
  // #628 — каденция.
  splitReplies: boolean; // резать длинный ответ по абзацам на несколько сообщений
  typingIndicator: boolean; // слать «печатает…» перед ответом
  // #632 — авто-закрытие диалога после N часов тишины.
  autocloseHours: number | null; // 1..720
  // #633 — медиа/голос.
  voiceStt: boolean; // транскрибировать голосовые (по умолчанию вкл)
  mediaAckText: string | null; // ответ на media-only без подписи (иначе молчим)
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  temperature: null,
  maxOutputTokens: null,
  compactAfterMessages: null,
  fallbackText: null,
  greetingText: null,
  hoursEnabled: false,
  hoursStartMin: null,
  hoursEndMin: null,
  hoursTz: null,
  offhoursMessage: null,
  stopWords: [],
  handoffAfterFallbacks: null,
  splitReplies: false,
  typingIndicator: false,
  autocloseHours: null,
  voiceStt: true,
  mediaAckText: null,
};

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return Math.min(max, Math.max(min, i));
  return i;
}

function clampFloat(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, maxLen = 1000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, maxLen);
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function wordList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(/[\n,]/)
      : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const w = item.trim().toLowerCase();
    if (w.length > 0 && !out.includes(w)) out.push(w);
    if (out.length >= 100) break;
  }
  return out;
}

/**
 * Парсит сырой JSON в нормализованный BotSettings (с клампингом/дефолтами).
 * Битый/пустой JSON → дефолты. Безопасно к мусору в полях.
 */
export function parseBotSettings(json: string | null | undefined): BotSettings {
  if (!json) return { ...DEFAULT_BOT_SETTINGS };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { ...DEFAULT_BOT_SETTINGS };
  }
  return {
    temperature: raw.temperature == null ? null : clampFloat(raw.temperature, 0, 1.5),
    maxOutputTokens: raw.maxOutputTokens == null ? null : clampInt(raw.maxOutputTokens, 100, 4000),
    compactAfterMessages:
      raw.compactAfterMessages == null ? null : clampInt(raw.compactAfterMessages, 5, 100),
    fallbackText: str(raw.fallbackText, 1000),
    greetingText: str(raw.greetingText, 1000),
    hoursEnabled: bool(raw.hoursEnabled, false),
    hoursStartMin: raw.hoursStartMin == null ? null : clampInt(raw.hoursStartMin, 0, 1439),
    hoursEndMin: raw.hoursEndMin == null ? null : clampInt(raw.hoursEndMin, 0, 1439),
    hoursTz: str(raw.hoursTz, 64),
    offhoursMessage: str(raw.offhoursMessage, 1000),
    stopWords: wordList(raw.stopWords),
    handoffAfterFallbacks:
      raw.handoffAfterFallbacks == null ? null : clampInt(raw.handoffAfterFallbacks, 1, 20),
    splitReplies: bool(raw.splitReplies, false),
    typingIndicator: bool(raw.typingIndicator, false),
    autocloseHours: raw.autocloseHours == null ? null : clampInt(raw.autocloseHours, 1, 720),
    voiceStt: bool(raw.voiceStt, true),
    mediaAckText: str(raw.mediaAckText, 500),
  };
}

/**
 * Сериализует BotSettings обратно в JSON для записи в tenants.bot_settings_json.
 */
export function serializeBotSettings(s: BotSettings): string {
  return JSON.stringify(s);
}

/**
 * Мерджит частичный patch (из admin PUT) поверх текущих настроек и нормализует.
 * Принимает «сырые» значения patch'а — нормализация в parseBotSettings.
 */
export function mergeBotSettings(
  current: BotSettings,
  patch: Record<string, unknown>,
): BotSettings {
  return parseBotSettings(JSON.stringify({ ...current, ...patch }));
}

/**
 * true, если now (epoch сек.) попадает в рабочее окно [start,end) в таймзоне
 * настроек. Окно через полночь (start>end) поддержано. Если часы выкл или не
 * заданы — всегда true (бот отвечает). Невалидная таймзона → true (fail-open).
 */
export function isWithinBotHours(settings: BotSettings, nowEpochSec: number): boolean {
  if (!settings.hoursEnabled) return true;
  if (settings.hoursStartMin == null || settings.hoursEndMin == null) return true;
  let minutes: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: settings.hoursTz ?? "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowEpochSec * 1000));
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    minutes = (hh % 24) * 60 + mm;
  } catch {
    return true; // невалидная таймзона — не блокируем бота
  }
  const { hoursStartMin: start, hoursEndMin: end } = settings;
  if (start === end) return true; // вырожденное окно = весь день
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // окно через полночь
}

/**
 * Совпадение стоп-слова во входящем тексте (подстрока, регистронезависимо).
 * Возвращает найденное слово или null.
 */
export function matchStopWord(settings: BotSettings, text: string): string | null {
  if (settings.stopWords.length === 0) return null;
  const lower = text.toLowerCase();
  for (const w of settings.stopWords) {
    if (lower.includes(w)) return w;
  }
  return null;
}
