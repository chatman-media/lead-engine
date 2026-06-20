/**
 * Скриптовые диалоги — записанные (анонимизированные) реплики реальных клиентов
 * из Telegram-экспортов. В отличие от LLM-персон, здесь реплики ФИКСИРОВАНЫ: их
 * шлют боту по очереди (детерминированный прогон, без LLM-клиента и трат токенов).
 *
 * Источник: apps/vertical-exchange/evals/exchange-candidate-cases/
 *   - *.md в корне каталога      → диалоги под THB (Таиланд)
 *   - ph/*.md (подпапка)          → диалоги под PHP (Филиппины)
 *
 * Формат markdown:
 *   # Реплики кандидата: <заголовок>
 *   ## 1
 *   <строки реплики клиента>      (несколько строк = несколько «пузырей» подряд)
 *   ## 2
 *   ...
 *
 * Медиа-плейсхолдеры (отдельной строкой) → вложения:
 *   [фото]      → photo      (паспорт / чек / скрин)
 *   [файл]      → document
 *   [голосовое] → voice
 * Inline-редакции ([телефон], [карта], [счёт], [ссылка], [ФИО]) — это затёртые
 * чувствительные данные ВНУТРИ текста; остаются как есть (бот видит плейсхолдер).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ScriptedDialogCurrency = "THB" | "PHP";

/** Вид вложения, «присланного» клиентом на данном ходу. */
export type ScriptedMediaKind = "photo" | "document" | "voice";

export interface ScriptedTurn {
  /** Текст реплики (несколько «пузырей» склеены через \n; редакции inline). */
  text: string;
  /** Вложения этого хода (могут идти вместе с текстом или без него). */
  media: ScriptedMediaKind[];
}

export interface ScriptedDialog {
  /** basename файла без расширения, напр. "07-rub-qr-kyc-reuse-35k". */
  id: string;
  /** Человекочитаемый заголовок из первой строки `# Реплики кандидата: …`. */
  title: string;
  currency: ScriptedDialogCurrency;
  turns: ScriptedTurn[];
  /** Сколько вложений всего (для отображения в UI). */
  mediaCount: number;
}

const TITLE_PREFIX_RE = /^#\s*Реплики кандидата:\s*/i;
const TURN_HEADING_RE = /^##\s+/;

// Медиа-строки (целиком — это вложение). Inline-редакции сюда НЕ попадают.
const MEDIA_BY_MARKER: Record<string, ScriptedMediaKind> = {
  "[фото]": "photo",
  "[файл]": "document",
  "[голосовое]": "voice",
};

/**
 * Парсит markdown одного candidate-case в структуру диалога.
 * Возвращает null, если в файле нет ни одной реплики (напр. index.md).
 */
export function parseCandidateCaseMarkdown(
  id: string,
  currency: ScriptedDialogCurrency,
  markdown: string,
): ScriptedDialog | null {
  const lines = markdown.split(/\r?\n/);
  let title = id;
  const turns: ScriptedTurn[] = [];
  let cur: { textLines: string[]; media: ScriptedMediaKind[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.textLines.join("\n").trim();
    // Пустой ход без медиа пропускаем (артефакт лишних `##`).
    if (text || cur.media.length > 0) turns.push({ text, media: cur.media });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (TITLE_PREFIX_RE.test(line)) {
      title = line.replace(TITLE_PREFIX_RE, "").trim() || id;
      continue;
    }
    // Не candidate-case (нет нужного заголовка) — пропускаем заголовки H1.
    if (line.startsWith("# ")) continue;
    if (TURN_HEADING_RE.test(line)) {
      flush();
      cur = { textLines: [], media: [] };
      continue;
    }
    if (!cur) continue; // строки до первого `##` игнорируем
    const media = MEDIA_BY_MARKER[line.toLowerCase()];
    if (media) {
      cur.media.push(media);
      continue;
    }
    if (line) cur.textLines.push(raw.trim());
  }
  flush();

  if (turns.length === 0) return null;
  const mediaCount = turns.reduce((n, t) => n + t.media.length, 0);
  return { id, title, currency, turns, mediaCount };
}

/** Каталог записанных диалогов в монорепо (apps/vertical-exchange/evals/...). */
function candidateCasesDir(): string {
  // scripted-dialogs.ts: apps/api/src/lib/exchange → вверх до apps (4 уровня).
  return resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "vertical-exchange",
    "evals",
    "exchange-candidate-cases",
  );
}

function readDialogsFrom(dir: string, currency: ScriptedDialogCurrency): ScriptedDialog[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // каталог отсутствует (напр. не задеплоен) — мягкий fallback
  }
  const out: ScriptedDialog[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md") || name === "index.md") continue;
    const id = name.replace(/\.md$/, "");
    let md: string;
    try {
      md = readFileSync(resolve(dir, name), "utf8");
    } catch {
      continue;
    }
    const dialog = parseCandidateCaseMarkdown(id, currency, md);
    if (dialog) out.push(dialog);
  }
  return out;
}

/**
 * Загружает записанные диалоги для валюты тенанта.
 *   THB → файлы в корне каталога candidate-cases
 *   PHP → файлы в подпапке ph/
 * Кэшируется на процесс (файлы статичны между деплоями).
 */
const CACHE = new Map<ScriptedDialogCurrency, ScriptedDialog[]>();

export function loadScriptedDialogs(currency: ScriptedDialogCurrency): ScriptedDialog[] {
  const cached = CACHE.get(currency);
  if (cached) return cached;
  const base = candidateCasesDir();
  const dir = currency === "PHP" ? resolve(base, "ph") : base;
  const dialogs = readDialogsFrom(dir, currency);
  CACHE.set(currency, dialogs);
  return dialogs;
}

/** Один диалог по id (в рамках валюты). */
export function getScriptedDialog(
  currency: ScriptedDialogCurrency,
  id: string,
): ScriptedDialog | undefined {
  return loadScriptedDialogs(currency).find((d) => d.id === id);
}

/** Тестовый хук: сбросить кэш (после подмены файлов в тестах). */
export function __clearScriptedDialogsCache(): void {
  CACHE.clear();
}
