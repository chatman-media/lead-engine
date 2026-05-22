# @chatman-media/vertical-recruitment-uae

Vertical template для рекрутинговых агентств: найм на работу за рубежом
(UAE / КНР рабочая виза). В проде с реального production-tenant'а
(`slug=legacy`) — Phase 1 USP проекта.

## Что делает этот пакет

- Определяет 12-state funnel machine (intake_pending → closed/rejected)
- 15-field intake questionnaire (анкета кандидата, включая фото/видео)
- 32-field step-by-step visa interview (для китайской рабочей визы, латиница)
- 3 production-curated sales-styles (flirty-belfort,
  empathetic-nepq, cold-direct-pas)
- Регистрируется в `@chatman-media/verticals#defaultRegistry` через side-effect
  import

## Состояние аудита (Phase 1, 2026-05)

### ✅ Работает в проде

| Компонент | Файл | Статус |
|-----------|------|--------|
| Funnel state machine (12 stages) | `src/funnel-stages.ts` | ✅ Используется `apps/api` |
| Intake questionnaire (15 fields) | `src/intake.ts` | ✅ conversation-engine использует |
| Visa interview (32 fields) | `src/visa-interview.ts` | ✅ Шаг visa_form в воронке |
| VerticalTemplate registration | `src/template.ts` + `src/index.ts` | ✅ Грузится при boot |
| Sales styles (4 шт) | `src/styles/` | ✅ Seed в DB через `seed-styles.ts` |
| Template tests | `src/template.test.ts` | ✅ 5 passing |

### ⚠️ Placeholders

| Компонент | Статус | Что нужно |
|-----------|--------|-----------|
| `kbSeedFiles: []` в template.ts | Placeholder | KB seed'ится оператором вручную через admin UI. Automated seed — Phase 2 / "Этап 8". |
| `TEMPLATE_BY_TENANT_SLUG = { legacy: ... }` в `apps/api/src/index.ts` | Временный hardcode | После per-tenant funnel lookup (DB-based) станет ненужным. Помечено `// После Этапа 8`. |
| `const template = RECRUITMENT_UAE_V1` в `apps/api/src/llm-bootstrap.ts` | Временный hardcode | То же — один legacy tenant, один vertical. |

### ⚠️ Phase 2 blockers (НЕ мешают Phase 1)

Перед тем как добавить **второй vertical** (real estate или любой другой),
нужно провести миграцию DB:

1. **`leads_state_check` constraint** — в `packages/storage/src/schema.ts`
   таблица `leads` имеет hardcoded CHECK constraint со списком UAE-специфичных
   stage slug'ов:
   ```sql
   state IN ('intake_pending','intake_complete',...,'visa_form','visa_filing',...)
   ```
   Нужно: убрать constraint или сделать его динамическим (per-tenant vertical).

2. **`visaDocsJson` column** — UAE-specific название. Нужно: переименовать
   в `customDataJson` (generic JSONB blob для любого vertical).

3. **`visaInterviewField` column** — UAE-specific. Нужно: переименовать
   в `questionnaireField`.

4. **`state DEFAULT 'intake_pending'`** — UAE-specific default. Нужно:
   NULL + first stage из vertical template.

Эти изменения потребуют migration `0011_*` и рефакторинга `LeadsRepo`.

## Архитектура

```
@chatman-media/vertical-recruitment-uae
    ↓ side-effect import
@chatman-media/verticals#defaultRegistry   ← lookup по slug
    ↓
apps/api/src/index.ts                      ← TEMPLATE_BY_TENANT_SLUG (legacy hardcode)
apps/api/src/llm-bootstrap.ts             ← const template = RECRUITMENT_UAE_V1
    ↓
apps/api/scripts/seed-styles.ts           ← seeds RECRUITMENT_UAE_STYLES → DB styles table
```

## Styles: два набора (by design)

В проде сосуществуют два набора стилей:

| Набор | Где | Как используется |
|-------|-----|-----------------|
| `apps/vertical-recruitment-uae/src/styles/` | Этот пакет | `seed-styles.ts` грузит в DB `styles` table per-tenant. Runtime lookup: `StylesRepo` → DB. |
| `packages/sales/src/styles/` | Отдельный пакет | In-memory registry (`listStyles()`, `getStyle()`). Для новых generic-tenants и тестов. |

Новый стиль `recruiter-empathetic-v1` (Phase 1) добавлен в `packages/sales/src/styles/`
— для generic recruitment агентств (не только UAE/dance). Для legacy-tenant'а
нужно явно прогнать `seed-styles.ts` если требуется.

## Запуск тестов

```bash
bun test apps/vertical-recruitment-uae  # 5 tests
```
