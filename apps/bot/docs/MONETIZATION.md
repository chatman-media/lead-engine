# Монетизация: done-for-you агентство

> Технический трекинг Фазы B — [issue #69](https://github.com/chatman-media/sales-guru/issues/69).

## Context

Бот написан под одного клиента — sales-воронка визового рекрутинга в Китай. Цель —
монетизировать его шире по модели **done-for-you / агентство**: не продавать код, а
продавать результат («делаю и веду AI-воронку под ключ»). Код остаётся у владельца,
новый клиент = настройка, а не форк.

Целевые ниши: рекрутинг (другие сферы), недвижимость, плюс собственные бизнесы
владельца — услуги по разработке/автоматизации и видеосъёмка на Пхукете.

**Проблема:** сейчас каждая новая ниша = форк кода. Лид-модуль (`src/leads/`) намертво
зашит под визы:

- `templates.ts` — все тексты (анкета, визовая анкета, контракт, отказ) — русские
  строковые константы; `IntakeFields` — визовые поля; `isIntakeComplete()` —
  захардкоженный гейт.
- `intake.ts` — промпт экстрактора зашит («девушка», «рекрутинговое агентство»), 12 полей.
- `visa-docs.ts` — 32 визовых поля захардкожены.
- `service.ts` — `formatLeadCard` / `sendApprovalMessages` / `postVisaSubmissionPackage`
  завязаны на визовые шаблоны.

Хорошая новость: персона уже конфигурируется через env (`BOT_PERSONA_*`), LLM-провайдер
тоже, лид-пайплайн опционален (`LEADS_CHAT_ID` не задан → визовый авто-promote выключен),
а `intake_json` / `visa_docs_json` в БД — непрозрачный JSON, миграция БД не нужна.

## Go-to-market (бизнес-контекст)

1. **Сначала — свои бизнесы.** Поднять бота как лид-воронку для своей разработки/
   автоматизации и для видеосъёмки на Пхукете. Нулевой риск, быстрый эффект и живое
   демо для продаж. Лид-пайплайн тут не нужен — RAG-чат + персона + квалификация.
2. **Потом — продажа услуги** рекрутинговым (другие сферы) и риелторским агентствам:
   setup-платёж + помесячное ведение. Козырь в питче — self-play/коучинг: «бот сам
   улучшает конверсию».

## Технический план

### Фаза A — запустить свои воронки (почти без кода)

Бот работает as-is:

- Персона через env: `BOT_PERSONA_NAME`, `BOT_PERSONA_ROLE`, `BOT_PERSONA_COMPANY`,
  `BOT_PERSONA_FACTS`.
- KB: markdown с описанием услуг / прайсом / FAQ → `bun scripts/ingest.ts`.
- `LEADS_CHAT_ID` / `VISA_CHAT_ID` не задавать — визовая часть выключится сама.
- Опционально — `questionnaire`-токены (`/q/:token`) для предквалификации.

### Фаза B — niche playbook ([issue #69](https://github.com/chatman-media/sales-guru/issues/69))

Вынести нишевую специфику лид-модуля в конфиг-объект `NichePlaybook`.

**Новый файл `src/leads/playbook.ts`:**

- `IntakeFieldSpec` — `{ key, label, kind: "text"|"media-count"|"media-flag",
  required, extractHint }`.
- `NichePlaybook` — `{ slug, audienceNoun, intakeFields[], intakeChecklist{ru,en?},
  stage2?, templates{...} }`. `stage2` (опциональный аналог `visa-docs`) — для
  недвижимости и услуг выключен.
- `resolvePlaybook()` читает env `LEADS_PLAYBOOK` (по умолчанию `recruitment-cn` —
  полностью повторяет текущее поведение).
- Встроенные плейбуки: `recruitment-cn` (текущий визовый, перенос строк 1:1),
  `realestate` (intake: бюджет / район / срок / ипотека; stage2 off),
  `services` (intake: тип проекта / бюджет / сроки / контакт; stage2 off).

**Правки существующих файлов:**

- `src/leads/templates.ts` — функции (`intakeTemplate`, `fillIntakeTemplate`,
  `INTAKE_FIELD_LABELS`) принимают playbook; `isIntakeComplete()` итерирует
  `playbook.intakeFields.filter(f => f.required)`.
- `src/leads/intake.ts` — `SYSTEM_PROMPT` строится из `playbook.intakeFields`
  (`extractHint`) и `audienceNoun`.
- `src/leads/visa-docs.ts` — обобщить в `stage2`-экстрактор, управляемый
  `playbook.stage2`; визовая схема становится `recruitment-cn.stage2`.
- `src/leads/service.ts` — тексты и поля из playbook; убрать прямые импорты визовых
  констант.
- `src/config.ts` — добавить env `LEADS_PLAYBOOK` (default `recruitment-cn`).
- `src/telegram/` (process-inbound, lead-хуки) — пробросить playbook.

### Фаза C — onboarding scaffold

- `scripts/new-client.ts` — скаффолд развёртывания клиента: `.env` из шаблона ниши,
  директория KB, напоминание про webhook.
- Шаблоны `.env` и KB-стартеры по нишам (`recruitment`, `realestate`, `services`).
- `docs/AGENCY.md` — операторский чек-лист запуска клиента.

## Verification

- `bun test` — весь существующий набор обязан остаться зелёным: плейбук
  `recruitment-cn` даёт побайтово то же поведение.
- Новые юнит-тесты: `resolvePlaybook`, сборка промпта intake из playbook,
  `isIntakeComplete` для не-визовых ниш, `stage2` выключен.
- `bun run typecheck` + `biome` чисто.
- Ручная проверка: тестовый бот с `LEADS_PLAYBOOK=realestate` — собирается
  риелторский intake, визовая стадия не появляется.

## Объём и риск

Фаза A — конфиг, дни. Фаза B — рефакторинг лид-модуля (~1000 LOC + тесты), ~неделя
для соло. Фаза C — 2-3 дня, в основном additive. Риск низкий: миграции БД нет,
обратная совместимость гарантируется дефолтным плейбуком.
