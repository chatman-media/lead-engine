# AI Funnel Builder — сборка воронки по описанию бизнеса

_Обновлено: 2026-06-06._

**Ключевая возможность платформы:** оператор описывает свой бизнес обычным
языком, а AI собирает рабочую воронку продаж/квалификации — стадии, поля и фазы —
поверх **универсального костяка**. Это движок self-serve онбординга: «расскажи про
бизнес → готовая AI-воронка». Exchange (`exchanges·agency`) — первая live-вертикаль
на этом движке; concierge-модель показывает мульти-тип ветвление на том же костяке.

Технический разбор костяка и роутов — в
[`ARCHITECTURE.md`](ARCHITECTURE.md#funnel-phase-backbone-костяк). Этот документ —
end-to-end-нарратив и границы возможностей.

## Поток (end-to-end)

```
оператор: "у меня обменник крипты на THB"
  │
  ▼  POST /api/admin/workflows/ai-chat   (multi-turn, ≤60 ходов; BYOK chat-LLM)
SYSTEM_PROMPT ведёт диалог → AI задаёт уточняющие вопросы по одному
  │  когда картина ясна → JSON { reply, readyToGenerate:true, stages:[…] }
  ▼  normalizeStages()  — санитизация slug'ов, валидные kind/stageType/fieldType,
  │                       проставление phase (deriveDefaultPhase fallback), позиции,
  │                       чистка nextStages
  ▼  validateBackbone()  — 1 intake, ≥1 won/lost, qualify+offer, монотонность фаз
  │  → preview (для UI) + backbone (errors/warnings)
  ▼  POST /api/admin/workflows/apply   (повторно normalize+validate на сервере)
applyFunnelStages()  — заменяет активную воронку: stage_definitions + stage_fields
  │  audit: funnel.ai_apply
  ▼  воронка готова, лид может идти по стадиям
```

## Два входа (на сегодня)

| Вход | Эндпоинт | UI | Назначение |
|---|---|---|---|
| **AI Workflow Panel** | `POST /api/admin/workflows/ai-chat` + `/apply` | `AiWorkflowPanel.tsx` (Sheet с чатом + preview + «Применить») | Глубокая сборка воронки диалогом |
| **Admin Copilot** | `POST /api/admin/copilot/chat` → action `build_funnel` | `components/copilot/*` (док на всех страницах) | Контекстная подсказка + быстрая сборка |

Оба пути идут через **один и тот же** `normalizeStages` → `validateBackbone` →
`applyFunnelStages`, но имеют **отдельные системные промпты**. Унификация входов —
в роадмапе (см. ниже).

## Что AI генерит сейчас vs пока нет

**Генерит (структура):** стадии (`kind`, `stageType`, `phase`, `nextStages`,
`supportMode`, `autoAdvanceCondition`) и поля (`fieldType`, `required`,
`aiExtractable`, `hint`, `options`) — строго из закрытого каталога `STAGE_TYPES` /
`FIELD_TYPES` (`admin-funnel.ts`).

**Пока НЕ генерит (поведенческий слой):**
- пер-стадийные `goal`/`guidance` (таких колонок в `stage_definitions` ещё нет);
- стиль/персону бота (`StyleSchema`) — есть отдельный `POST /api/admin/styles/generate`,
  но он не вшит в сборку воронки;
- подбор навыков (`skills-catalogue.ts`).

То есть AI собирает **скелет воронки**, а «как бот себя ведёт» пока настраивается
отдельно (стили + навыки). Сборка поведенческого слоя вместе с воронкой — следующий
шаг (см. роадмап).

## Требования и лимиты
- **BYOK chat-LLM** у тенанта обязателен — иначе `/ai-chat` → `503`.
- Anthropic **prompt caching** системного промпта (длинный диалог экономит токены).
- Короткие воронки: **4–8 стадий**; диалог ≤ **60 ходов**.
- Клиенту не доверяем: `/apply` **повторно** нормализует и валидирует костяк.

## Карта файлов
- `apps/api/src/routes/admin-workflow.ts` — `SYSTEM_PROMPT`, `normalizeStages`, `/ai-chat`, `/apply`
- `apps/api/src/routes/admin-copilot.ts` — `CopilotAction` (`build_funnel`/`install_vertical`/`navigate`)
- `apps/api/src/routes/admin-funnel.ts` — `applyFunnelStages`, `SEED_TEMPLATES`, `STAGE_TYPES`/`FIELD_TYPES`
- `packages/verticals/src/phases.ts` — `validateBackbone`, `buildSkeletonFunnel`, `deriveDefaultPhase`
- `apps/admin-ui/src/components/AiWorkflowPanel.tsx`, `src/components/copilot/*`, `src/pages/SaasFunnel.tsx`

## Тесты
- `apps/api/src/routes/funnel-backbone.test.ts` — костяк (validate/skeleton)
- `apps/api/src/routes/admin-funnel.integration.test.ts` — CRUD + seed + `applyFunnelStages`
- `apps/api/src/routes/admin-workflow.integration.test.ts` — `/ai-chat` + `/apply` (фейковый LLM, e2e)
- `apps/api/src/routes/admin-copilot.integration.test.ts` — copilot actions (вкл. `build_funnel`)

LLM подменяется фейковым `resolveChat` (детерминированный `complete()`), поэтому тесты
проверяют нашу логику парсинга/нормализации/валидации, а не модель.

## Дальше (путь к полностью AI-собираемой воронке)
1. **Поведенческий слой в сборку**: AI вместе с воронкой предлагает стиль (`StyleSchema`,
   reuse `styles/generate`) + навыки + пер-стадийные `goal`/`guidance` (новые колонки
   `stage_definitions`); `composeSystemPrompt()` читает их.
2. **Унификация входов** (panel + copilot на одном бэкенд-промпте).
3. **Версионирование/откат** воронки (сейчас apply замещает без undo).
4. **Vertical auto-suggest** по описанию + **in-chat валидация** костяка (не только на apply).

Стратегический контекст — [`../strategy/ROADMAP.md`](../strategy/ROADMAP.md).
