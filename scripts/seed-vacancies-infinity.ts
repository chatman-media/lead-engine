/**
 * One-shot seeder: pulls the 4 active offers currently posted on
 * t.me/infinity_agency_world (snapshot taken interactively) into the
 * local vacancies table so the bot starts grounding answers in fresh
 * data instead of stale KB chunks.
 *
 * Idempotent: skips a row whose `title` already exists, so you can
 * re-run without duplicating. Edit/close in /admin/vacancies once seeded.
 */
import { config } from "../src/config.ts";
import { VacanciesRepo } from "../src/db/repos/vacancies.ts";
import { openDb } from "../src/db/sqlite.ts";

const VACANCIES = [
  {
    title: "Корея — Караоке хостес (₩110k + tips)",
    body: `Локация: Южная Корея
Роль: караоке хостес
Оплата: ₩110,000 за смену база + ₩1,500/час чаевых
Контракт: от 2 месяцев
Смена: 19:00–04:00 (иногда до 05:00)
Возраст: 19–30
Без интима. Жильё бесплатно (2–3 комн.), встреча в аэропорту, перелёт в счёт работы. 2 выходных в месяц.`,
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
  },
];

const db = openDb({ path: config.dbPath });
const repo = new VacanciesRepo(db);

const existing = new Set(repo.listAll().map((v) => v.title));
let inserted = 0;
let skipped = 0;
for (const v of VACANCIES) {
  if (existing.has(v.title)) {
    console.log(`  skip (exists): ${v.title}`);
    skipped++;
    continue;
  }
  const row = repo.create({ title: v.title, body: v.body, isActive: true });
  console.log(`  + id=${row.id}: ${row.title}`);
  inserted++;
}
console.log(`\nDone. inserted=${inserted}, skipped=${skipped}, total active=${repo.listActive().length}`);
db.close();
