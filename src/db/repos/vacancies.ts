import type { Sql } from "../postgres.ts";

export interface VacancyRow {
  id: number;
  title: string;
  body: string;
  url: string | null;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export class VacanciesRepo {
  constructor(private sql: Sql) {}

  async listActive(): Promise<VacancyRow[]> {
    return this.sql<VacancyRow[]>`
      SELECT * FROM vacancies WHERE is_active = TRUE ORDER BY updated_at DESC
    `;
  }

  async listAll(): Promise<VacancyRow[]> {
    return this.sql<VacancyRow[]>`
      SELECT * FROM vacancies ORDER BY is_active DESC, updated_at DESC
    `;
  }

  async byId(id: number): Promise<VacancyRow | null> {
    const [row] = await this.sql<VacancyRow[]>`
      SELECT * FROM vacancies WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async create(input: {
    title: string;
    body: string;
    url?: string | null;
    isActive?: boolean;
  }): Promise<VacancyRow> {
    const isActive = input.isActive !== false;
    const url = normaliseUrl(input.url);
    const [row] = await this.sql<VacancyRow[]>`
      INSERT INTO vacancies (title, body, url, is_active)
      VALUES (${input.title.trim()}, ${input.body.trim()}, ${url}, ${isActive}) RETURNING *
    `;
    if (!row) throw new Error("Failed to insert vacancy");
    return row;
  }

  async update(
    id: number,
    patch: {
      title?: string;
      body?: string;
      url?: string | null;
      isActive?: boolean;
    },
  ): Promise<VacancyRow | null> {
    const existing = await this.byId(id);
    if (!existing) return null;
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const body = patch.body !== undefined ? patch.body.trim() : existing.body;
    const url = patch.url !== undefined ? normaliseUrl(patch.url) : existing.url;
    const isActive = patch.isActive === undefined ? existing.is_active : patch.isActive;
    await this.sql`
      UPDATE vacancies
      SET title = ${title}, body = ${body}, url = ${url}, is_active = ${isActive}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
    `;
    return this.byId(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM vacancies WHERE id = ${id}`;
    return result.count > 0;
  }

  async countActive(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM vacancies WHERE is_active = TRUE
    `;
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
Заработок в месяц: от $3,500+
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

export async function seedInfinityVacancies(repo: VacanciesRepo): Promise<SeedVacanciesResult> {
  const existingByTitle = new Map((await repo.listAll()).map((v) => [v.title, v]));
  let inserted = 0;
  let urlPatched = 0;
  let skipped = 0;
  for (const v of BUILTIN_VACANCIES) {
    const existing = existingByTitle.get(v.title);
    if (existing) {
      const needsUrl = !existing.url && v.url;
      const needsBody = existing.body.trim() !== v.body.trim();
      if (needsUrl || needsBody) {
        await repo.update(existing.id, {
          ...(needsBody ? { body: v.body } : {}),
          ...(needsUrl ? { url: v.url } : {}),
        });
        urlPatched++;
      } else {
        skipped++;
      }
      continue;
    }
    await repo.create({ title: v.title, body: v.body, url: v.url, isActive: true });
    inserted++;
  }
  return { inserted, urlPatched, skipped };
}

export function renderVacanciesBlock(vacancies: VacancyRow[]): string {
  const active = vacancies.filter((v) => v.is_active);
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

function normaliseUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
