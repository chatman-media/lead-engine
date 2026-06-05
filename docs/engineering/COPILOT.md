# Admin copilot

Page-aware AI-ассистент в кабинете: док-панель на каждой странице, которая
знает, где находится оператор, и предлагает действия с подтверждением. BYOK —
использует chat-LLM самого тенанта.

## Backend

`apps/api/src/routes/admin-copilot.ts` — единственный эндпоинт:

```
POST /api/admin/copilot/chat
```

- Системный промпт собирается из `PAGE_HINTS` (хардкод-подсказки по `pageId`)
  + опциональный структурированный контекст (JSON) + fallback на видимый текст
  страницы.
- LLM возвращает JSON `{ "reply": "...", "action": <action | null> }`.
- Коды ошибок: `503 llm_not_configured` (chat-LLM не настроен у тенанта);
  `502` при ошибке LLM.

### Действия (allowlist)

`action` валидируется по белому списку — модель не может выполнить произвольное:

| Action | Проверка | Эффект (после подтверждения) |
|---|---|---|
| `install_vertical` | slug есть в реестре вертикалей | установить vertical template |
| `build_funnel` | стадии проходят `normalizeStages` | собрать/применить воронку |
| `navigate` | `to`/`step` валидны | перейти на страницу/шаг |

Само действие НЕ применяется на бэке автоматически — `chat` лишь возвращает
*предложение*; применяет фронт через существующие эндпоинты после подтверждения.

## Frontend

`apps/admin-ui/src/components/copilot/` (`CopilotProvider.tsx`, `CopilotDock`,
`usePageCopilot.ts`):

- Док появляется на **всех** страницах кабинета; страница → `pageId` через
  route-метаданные (dashboard / leads / conversations / funnel / exchange /
  channels / settings / onboarding / … ).
- Тоггл **Cmd/Ctrl+J**, состояние открыт/закрыт хранится в localStorage.
- Контекст: страница знает свой `pageId` и отдаёт структурированные данные
  (или видимый текст как fallback) в `copilot/chat`.

### Поток advice + confirm

```
1. оператор пишет → send(text) → POST /copilot/chat
2. copilot отвечает reply (+ возможно action)
3. если action — UI показывает диалог подтверждения
4. confirmAction() вызывает существующий эндпоинт
   (installVertical / applyWorkflow / navigate)
5. appliedTick++ → страницы перезапрашивают данные
```

## Назначение

- Онбординг-помощник: подсказывает на `/onboarding`, может предложить
  установить вертикаль или собрать воронку.
- Контекстная помощь по текущему экрану (метрики, лиды, курсы и т.д.).

Связано: AI-сборка воронки — [ARCHITECTURE.md](ARCHITECTURE.md) (AI Workflow
Builder) и костяк фаз; вертикали — [../strategy/VERTICALS.md](../strategy/VERTICALS.md).

## Карта файлов

| Что | Где |
|---|---|
| API | `apps/api/src/routes/admin-copilot.ts` |
| Провайдер/док/хук | `apps/admin-ui/src/components/copilot/` |
| Промпт-подсказки | `PAGE_HINTS` в `admin-copilot.ts` |
