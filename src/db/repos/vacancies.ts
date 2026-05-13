import type { Database } from "bun:sqlite";

/**
 * Operationally-mutable list of currently-open job offers, managed from
 * the admin UI. See migration 008 for the design rationale (fast-changing
 * data that should NOT live in the embedded KB).
 *
 * `is_active = 0` rows are kept (not deleted) so operators can re-enable
 * a previously-closed vacancy without re-typing it. Hard delete is also
 * supported for actual cleanup.
 */
export interface VacancyRow {
  id: number;
  title: string;
  body: string;
  /** Optional canonical link — Telegram channel post, group invite,
   *  external page. Surfaced to the bot so it can drop a "подробнее: …"
   *  line when the candidate asks for a link. Empty string normalised
   *  to NULL by the repo. */
  url: string | null;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export class VacanciesRepo {
  constructor(private db: Database) {}

  /** All active vacancies, freshest first. Used by the webhook on every
   *  inbound message to build the prompt block — keep it cheap. */
  listActive(): VacancyRow[] {
    return this.db
      .query<VacancyRow, []>(`SELECT * FROM vacancies WHERE is_active = 1 ORDER BY updated_at DESC`)
      .all();
  }

  /** All vacancies, regardless of active state. Used by the admin list
   *  view — operators want to see closed ones too (to re-enable). */
  listAll(): VacancyRow[] {
    return this.db
      .query<VacancyRow, []>(`SELECT * FROM vacancies ORDER BY is_active DESC, updated_at DESC`)
      .all();
  }

  byId(id: number): VacancyRow | null {
    return (
      this.db.query<VacancyRow, [number]>("SELECT * FROM vacancies WHERE id = ? LIMIT 1").get(id) ??
      null
    );
  }

  create(input: {
    title: string;
    body: string;
    url?: string | null;
    isActive?: boolean;
  }): VacancyRow {
    const isActive = input.isActive === false ? 0 : 1;
    const url = normaliseUrl(input.url);
    const row = this.db
      .query<VacancyRow, [string, string, string | null, number]>(
        `INSERT INTO vacancies (title, body, url, is_active)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(input.title.trim(), input.body.trim(), url, isActive);
    if (!row) throw new Error("Failed to insert vacancy");
    return row;
  }

  /**
   * Patches any subset of mutable fields. Always bumps `updated_at` so the
   * webhook's freshest-first ordering reflects the operator's edit.
   * Returns null when the row doesn't exist (UI handles 404).
   */
  update(
    id: number,
    patch: {
      title?: string;
      body?: string;
      url?: string | null;
      isActive?: boolean;
    },
  ): VacancyRow | null {
    const existing = this.byId(id);
    if (!existing) return null;
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const body = patch.body !== undefined ? patch.body.trim() : existing.body;
    const url = patch.url !== undefined ? normaliseUrl(patch.url) : existing.url;
    const isActive = patch.isActive === undefined ? existing.is_active : patch.isActive ? 1 : 0;
    this.db.run(
      `UPDATE vacancies
       SET title = ?, body = ?, url = ?, is_active = ?, updated_at = unixepoch()
       WHERE id = ?`,
      [title, body, url, isActive, id],
    );
    return this.byId(id);
  }

  /** Hard delete. Closed-but-archived vacancies are kept via is_active=0;
   *  this is for actual cleanup of mistaken entries. */
  delete(id: number): boolean {
    const res = this.db.run("DELETE FROM vacancies WHERE id = ?", [id]);
    return res.changes > 0;
  }

  countActive(): number {
    const r = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vacancies WHERE is_active = 1")
      .get();
    return r?.n ?? 0;
  }
}

const FALLBACK_CHANNEL = "https://t.me/infinity_agency_world";

const BUILTIN_VACANCIES: Array<{ title: string; body: string; url: string }> = [
  {
    title: "Корея — Караоке хостес (₩110k + tips)",
    body: `Локация: Южная Корея
Роль: караоке хостес
Оплата: ₩110,000 за смену база + ₩1,500/час чаевых
Контракт: от 2 месяцев
Смена: 19:00–04:00 (иногда до 05:00)
Возраст: 19–30
Без интима. Жильё бесплатно (2–3 комн.), встреча в аэропорту, перелёт в счёт работы. 2 выходных в месяц.`,
    url: FALLBACK_CHANNEL,
  },
  {
    title: "Шаохинг / Иу — Premium хостес (9k–10k юаней + %)",
    body: `Локация: Шаохинг, Иу (Китай)
Роль: хостес, flower consumption
Оплата: 9 000–10 000 юаней база + 40% с цветов + % с напитков и столов
Заработок: $2 500–$4 000+ в месяц
Возраст: 18–30
Смена: ночная, 8–10 часов
Без интима. Жильё бесплатно (2 чел.), легальный контракт, виза и перелёт в счёт работы.`,
    url: FALLBACK_CHANNEL,
  },
  {
    title: "Санья / Чжэцзян / Шанхай — KTV хостес ($5000+)",
    body: `Локация: Санья, Чжэцзян, Шанхай
Роль: KTV хостес
Оплата: 700–800 юаней room fee + чай полностью ваш
Заработок: $5 000+ в месяц
Возраст: 18+
Смена: 21:00–02:00
Жильё бесплатно. Поддерживающая команда.`,
    url: FALLBACK_CHANNEL,
  },
  {
    title: "Менеджер агентства (Шаохинг / Иу / Корея)",
    body: `Роль: менеджер / рекрутёр агентства
Локации и оплата:
- Шаохинг: $1 300–$1 800
- Иу: $700–$900
- Корея: $700
Возраст: 18+, ответственность, пунктуальность.
Обучение есть, заработок включает комиссии.`,
    url: FALLBACK_CHANNEL,
  },
];

export interface SeedVacanciesResult {
  inserted: number;
  urlPatched: number;
  skipped: number;
}

/**
 * Idempotent seeder for INFINITY AGENCY built-in vacancies. Safe to call on
 * every boot — skips rows whose `title` already exists, patches missing URLs.
 */
export function seedInfinityVacancies(repo: VacanciesRepo): SeedVacanciesResult {
  const existingByTitle = new Map(repo.listAll().map((v) => [v.title, v]));
  let inserted = 0;
  let urlPatched = 0;
  let skipped = 0;
  for (const v of BUILTIN_VACANCIES) {
    const existing = existingByTitle.get(v.title);
    if (existing) {
      if (!existing.url && v.url) {
        repo.update(existing.id, { url: v.url });
        urlPatched++;
      } else {
        skipped++;
      }
      continue;
    }
    repo.create({ title: v.title, body: v.body, url: v.url, isActive: true });
    inserted++;
  }
  return { inserted, urlPatched, skipped };
}

/**
 * Render active vacancies into the prompt-friendly block prepended to
 * the RAG CONTEXT. Returns "" when no active vacancies — caller skips
 * adding the heading entirely. Exported separately so unit tests can
 * verify formatting without touching the DB.
 */
export function renderVacanciesBlock(vacancies: VacancyRow[]): string {
  const active = vacancies.filter((v) => v.is_active === 1);
  if (active.length === 0) return "";
  const items = active
    .map((v, i) => {
      const head = `[В${i + 1}] ${v.title}`;
      const link = v.url ? `\nСсылка: ${v.url}` : "";
      return `${head}\n${v.body}${link}`;
    })
    .join("\n\n");
  const openLocations = extractOpenLocations(active);
  const locationsLine =
    openLocations.length > 0 ? `ОТКРЫТЫЕ ЛОКАЦИИ: ${openLocations.join(", ")}.\n` : "";
  return (
    `АКТУАЛЬНЫЕ ВАКАНСИИ (свежие, из админки — отвечай по ним в первую очередь).\n` +
    `${locationsLine}` +
    `ЖЁСТКОЕ ПРАВИЛО: список ниже — это ПОЛНЫЙ перечень открытых вакансий. ` +
    `Если кандидат спрашивает про страну/город/локацию, которой здесь НЕТ ` +
    `(например Дубай, Стамбул, Турция, Европа, США), — НЕ переноси цифры/условия ` +
    `из CONTEXT (KB) на эту локацию, НЕ выдумывай. Ответь по-человечески: ` +
    `«сейчас в [N] мы не работаем, открыты вот эти направления: [перечисли]. ` +
    `Что-то из этого подойдёт?» — и больше ничего.\n` +
    `Если у вакансии есть строка "Ссылка:" — ВСЕГДА включай её когда называешь эту вакансию кандидату. ` +
    `Ссылка даёт возможность почитать подробности самостоятельно — не жди, пока попросят.\n` +
    items
  );
}

/**
 * Pull the headline location(s) from each active vacancy. Operators title
 * vacancies as "Город / Город — Роль (детали)" or "Страна — Роль (детали)";
 * we split on " — " and take the part before it. The result feeds into the
 * "ОТКРЫТЫЕ ЛОКАЦИИ:" line so the LLM has a concise allow-list it can echo
 * when redirecting "сколько в Дубае?" → "в Дубае не работаем".
 *
 * Falls back to the full title when there's no " — " separator. Deduplicated
 * preserving first occurrence so the order matches operator priority.
 */
function extractOpenLocations(active: VacancyRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of active) {
    const head = v.title.split(/\s+[—–-]\s+/)[0]?.trim();
    if (!head) continue;
    if (seen.has(head)) continue;
    seen.add(head);
    out.push(head);
  }
  return out;
}

/** Empty / whitespace → NULL. URLs without a scheme get an `https://` prefix
 *  so the bot copies a clickable form into Telegram. Anything that already
 *  has a scheme (https / http / tg / tonsite) passes through. */
function normaliseUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
