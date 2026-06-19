/**
 * Детект и стабилизация языка диалога (#735, фундамент мультиязыка эпика #728).
 *
 * Набор поддерживаемых языков: RU / EN / KO / ZH (RU/EN — первоочерёдно).
 *
 * Подход: чистая эвристика по Unicode-скрипту (`\p{Script=…}`). Для этих 4
 * языков скрипты почти однозначны: кириллица → ru, хангыль → ko, ханьцзы (Han)
 * → zh, латиница → en. Считаем доли значащих символов (буквы/иероглифы),
 * победитель — доминирующий скрипт выше порога. Никаких внешних библиотек
 * (franc/tinyld шумят на коротких репликах и тяжёлые), никаких LLM-вызовов
 * (язык нужен синхронно в дешёвой tx + не дёргать prompt-cache).
 *
 * Стабилизация: язык не меняется на каждое сообщение — короткие/неоднозначные
 * сигналы («ok», «5000», «👍») не сбивают залипший язык. Смена только при
 * уверенном сигнале другого скрипта.
 */

export const SUPPORTED_LANGS = ["ru", "en", "ko", "zh"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export const DEFAULT_LANG: Lang = "en";

/**
 * Пороги уверенности детекта. CJK-символы информативнее одной латинской
 * буквы — для них меньший порог по количеству.
 */
const MIN_LATIN_CYRILLIC_CHARS = 4;
const MIN_CJK_CHARS = 2;
const DOMINANT_SCRIPT_RATIO = 0.7;

interface DetectScriptResult {
  lang: Lang | null;
  confident: boolean;
}

/**
 * Считает доли значащих символов по скриптам в тексте. Игнорирует цифры,
 * пунктуацию, эмодзи, пробелы.
 */
function countScripts(text: string): {
  cyrillic: number;
  latin: number;
  hangul: number;
  han: number;
  totalSignificant: number;
} {
  let cyrillic = 0;
  let latin = 0;
  let hangul = 0;
  let han = 0;
  for (const ch of text) {
    if (/\p{Script=Cyrillic}/u.test(ch)) cyrillic++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if (/\p{Script=Hangul}/u.test(ch)) hangul++;
    else if (/\p{Script=Han}/u.test(ch)) han++;
  }
  return {
    cyrillic,
    latin,
    hangul,
    han,
    totalSignificant: cyrillic + latin + hangul + han,
  };
}

/**
 * Определяет язык по доминирующему скрипту. `confident` только при ≥N
 * значащих символов И доле доминирующего скрипта ≥0.7. Короткие реплики и
 * мусор → `{ lang: null, confident: false }`.
 *
 * Примеры:
 *   "Привет, сколько стоит?"   → { lang: 'ru', confident: true }
 *   "ok"                       → { lang: null, confident: false }  (слишком коротко)
 *   "안녕하세요 환전 부탁드립니다" → { lang: 'ko', confident: true }
 *   "您好我想换钱"               → { lang: 'zh', confident: true }
 *   "5000"                     → { lang: null, confident: false }  (нет букв)
 *   "👍👍👍"                    → { lang: null, confident: false }  (эмодзи)
 */
export function detectScriptLang(text: string): DetectScriptResult {
  if (!text || typeof text !== "string") {
    return { lang: null, confident: false };
  }
  const counts = countScripts(text);
  const { totalSignificant } = counts;
  if (totalSignificant === 0) return { lang: null, confident: false };

  const candidates: Array<{ lang: Lang; count: number; minChars: number }> = [
    { lang: "ru", count: counts.cyrillic, minChars: MIN_LATIN_CYRILLIC_CHARS },
    { lang: "en", count: counts.latin, minChars: MIN_LATIN_CYRILLIC_CHARS },
    { lang: "ko", count: counts.hangul, minChars: MIN_CJK_CHARS },
    { lang: "zh", count: counts.han, minChars: MIN_CJK_CHARS },
  ];

  let best: { lang: Lang; count: number; minChars: number } = {
    lang: "en",
    count: 0,
    minChars: MIN_LATIN_CYRILLIC_CHARS,
  };
  for (const c of candidates) {
    if (c.count > best.count) best = c;
  }
  if (best.count === 0) return { lang: null, confident: false };

  const ratio = best.count / totalSignificant;
  const confident = best.count >= best.minChars && ratio >= DOMINANT_SCRIPT_RATIO;

  return { lang: confident ? best.lang : null, confident };
}

/**
 * Нормализует канал-агностичный язык-код («en-US», «zh_TW», «ru», …) в наш
 * набор. Любой неизвестный/мусорный → null. Telegram отдаёт BCP-47-подобные
 * коды в `from.language_code` — это язык интерфейса, не переписки.
 */
export function mapChannelLangHint(code: string | undefined | null): Lang | null {
  if (!code || typeof code !== "string") return null;
  const lower = code.trim().toLowerCase();
  if (lower.length === 0) return null;
  // "en", "en-us", "en_gb" → "en"
  const primary = lower.split(/[-_]/)[0];
  if (!primary) return null;
  // Известные синонимы.
  const map: Record<string, Lang> = {
    ru: "ru",
    en: "en",
    ko: "ko",
    zh: "zh",
    // Грубые маппинги «soft»: только язык, не диалект. CJK-варианты в zh.
  };
  return map[primary] ?? null;
}

/**
 * Состояние решателя перезаписи языка диалога.
 */
export interface LangResolveInput {
  /** Текущий сохранённый язык (null если ещё не определён). */
  current: Lang | null;
  /** Зафиксирован ли текущий язык (true — менять только confident-сигналом). */
  locked: boolean;
  /** Что детектор показал по тексту текущего сообщения. */
  detected: DetectScriptResult;
  /** Слабый сигнал из канала (Telegram language_code и т.п.). */
  channelHint: Lang | null;
  /**
   * Первое сообщение диалога? — bootstrap-кейс, где допустимо взять channelHint
   * для media-only. На последующих сообщениях hint не перебивает залипание.
   */
  isFirstMessage: boolean;
}

export interface LangResolveResult {
  lang: Lang | null;
  locked: boolean;
  changed: boolean;
}

/**
 * Единственный решатель перезаписи. Принимает текущее состояние + новый
 * детект + опциональный hint, возвращает решение «писать ли и что».
 *
 * Правила:
 * - current=null + confident → ставим confident.lang, locked=true.
 * - current=null + не-confident + hint + первое сообщение → ставим hint, locked=false.
 * - locked + не-confident сигнал → не трогаем (залипание защищает от дребезга).
 * - locked + confident ДРУГОГО языка → меняем (осознанная смена скрипта —
 *   сильный сигнал, например клиент перешёл с ru на en).
 * - locked + confident ТОГО ЖЕ языка → no-op (уже залипли).
 * - не-locked + confident → ставим confident.lang, locked=true.
 */
export function resolveConversationLang(input: LangResolveInput): LangResolveResult {
  const { current, locked, detected, channelHint, isFirstMessage } = input;

  // Confident-сигнал — главное.
  if (detected.confident && detected.lang) {
    if (current === detected.lang) {
      // Уже залипли на этом языке: при повторном confident — гарантируем locked.
      return { lang: current, locked: true, changed: !locked };
    }
    // Новый язык — меняем (либо первое назначение, либо смена скрипта).
    return { lang: detected.lang, locked: true, changed: true };
  }

  // Bootstrap: первое сообщение, ничего не определено, есть hint → ставим hint мягко.
  if (current == null && !locked && channelHint && isFirstMessage) {
    return { lang: channelHint, locked: false, changed: true };
  }

  // Иначе — оставить как есть.
  return { lang: current, locked, changed: false };
}

/**
 * Эффективный язык диалога для downstream-шагов (#730 роутинг, #731 перевод).
 * Каскад: сохранённый детект → тенант-дефолт → DEFAULT_LANG.
 */
export function effectiveLang(input: {
  detectedLang: string | null | undefined;
  tenantDefaultLang?: string | null | undefined;
}): Lang {
  const detected = asSupportedLang(input.detectedLang);
  if (detected) return detected;
  const tenantDefault = asSupportedLang(input.tenantDefaultLang);
  if (tenantDefault) return tenantDefault;
  return DEFAULT_LANG;
}

/**
 * Type-guard: значение → поддерживаемый Lang или null. Используется и в
 * парсере bot-settings, и в каскаде effectiveLang.
 */
export function asSupportedLang(v: unknown): Lang | null {
  if (typeof v !== "string") return null;
  const lower = v.trim().toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(lower) ? (lower as Lang) : null;
}
