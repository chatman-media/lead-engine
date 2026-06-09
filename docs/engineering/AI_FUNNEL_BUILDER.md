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

## Что AI генерит (полный цикл)

**Структура.** Стадии (`kind`, `stageType`, `phase`, `nextStages`, `supportMode`,
`autoAdvanceCondition`) и поля (`fieldType`, `required`, `aiExtractable`, `hint`,
`options`) — строго из закрытого каталога `STAGE_TYPES` / `FIELD_TYPES` (`admin-funnel.ts`).

**Мульти-запрос (ветвящиеся воронки).** Билдер собирает не только линейные воронки, но и
**ветвящиеся** (консьерж / сервис-деск): intake с select-полем `request_type` → ветки
`<X>_request/offer/fulfill` → общие won/lost. `validateBackbone` + `multiRequestBranchErrors`
проверяют контракт веток (каждый тип запроса имеет ветку). Один клиент ↔ N параллельных
заявок. Полный разбор — [`CONCIERGE_FUNNEL_CONVERGENCE.md`](CONCIERGE_FUNNEL_CONVERGENCE.md).

**Оператор-handoff.** Билдер ставит `stageType: awaiting_operator` там, где условия/цену/решение
даёт человек — бот придерживает гостя и ждёт оператора, не выдумывая деталей.

**Поведенческий слой — Phase 2 (готово):**
- ✅ **Стиль:** `POST /api/admin/styles/generate-full` — AI собирает полный `StyleSchema`
  (персона/тон/фреймворк/хуки/goal+guidance/few-shot) из описания бизнеса, валидирует и
  сохраняет активным (`StylesRepo`).
- ✅ **Per-tenant активация стиля** (#201): `llm-bootstrap.resolveStyle` фолбэчит на самый
  свежий активный стиль тенанта — сгенерированный стиль ведёт бота без env/эксперимента.
- ✅ **Пер-стадийные `goal`/`guidance`** на структурных стадиях (`stage_definitions`, миграция
  `0034`): билдер их эмитит, `applyFunnelStages` сохраняет, а резолвер `makeStageGuidanceResolver`
  доводит до `composeSystemPrompt` (#211 + wiring-fix). Бот исполняет цель/инструкцию стадии.
- ✅ **Подбор навыков** (#212): `POST /api/admin/workflows/recommend-skills` — AI выбирает
  техники убеждения из каталога (`skills-catalogue.ts`) под бизнес.
- ✅ **Контекст запроса в промпте** (мульти-запрос): тип текущего запроса гостя + число
  открытых заявок («ЗАПРОС ГОСТЯ»).

Итог: структуру, стиль, навыки, пер-стадийное поведение и (для мульти-сервиса) ветвление —
AI собирает по описанию бизнеса, а бот исполняет это в рантайме.

## Требования и лимиты
- **BYOK chat-LLM** у тенанта обязателен — иначе `/ai-chat` → `503`.
- Anthropic **prompt caching** системного промпта (длинный диалог экономит токены).
- Линейные воронки короткие (**4–8 стадий**); ветвящиеся (мульти-запрос) длиннее (1 + 3×N + 2). Диалог ≤ **60 ходов**.
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

Опциональная live-проверка модели (не CI, стоит токены):

```bash
LLM_PROVIDER=openai LLM_MODEL=gpt-4o-mini LLM_API_KEY=sk-... \
  bun run --cwd apps/api eval:funnel-builder --output=tmp/funnel-eval.json
```

Или через tenant BYOK-конфиг:

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<hex> \
  bun run --cwd apps/api eval:funnel-builder --tenant=<slug>
```

Eval гоняет линейный, clear/fulfill-heavy exchange и multi-request concierge
сценарии, скорит backbone/branch contract/поля/goal+guidance и сохраняет
конкретные невалидные outputs без секретов.

## Дальше

Поведенческий слой Phase 2 и мульти-запрос — **готовы** (см. выше). Открытые направления:

1. **Оператор-в-петле до конца** (R5-остаток): `/send-offer` завершает `awaiting_operator`-
   стадию (двигает лид) + нотификация оператору при входе в стадию; и (R6) первоклассная
   сущность «заявка/тикет» для мульти-запроса вместо nullable-колонки. См.
   [`CONCIERGE_FUNNEL_CONVERGENCE.md`](CONCIERGE_FUNNEL_CONVERGENCE.md).
2. **Унификация входов** (panel + copilot на одном бэкенд-промпте).
3. **Версионирование/откат** воронки (сейчас `apply` замещает без undo).
4. **Vertical auto-suggest** по описанию + **in-chat валидация** костяка (не только на apply).

Стратегический контекст — [`../strategy/ROADMAP.md`](../strategy/ROADMAP.md).
