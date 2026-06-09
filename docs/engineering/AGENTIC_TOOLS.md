# Agentic tools (tool-loop)

Бот не только читает KB и отвечает — он может **вызывать инструменты**
(agentic actions). Поверх RAG-ответа крутится tool-loop: LLM решает вызвать
инструмент, получает результат и продолжает, пока не сформирует финальный ответ.

## Контракт инструмента

`packages/kb/src/tool-loop.ts` — интерфейс `RagTool`:

```ts
interface RagTool<TParams extends z.ZodTypeAny> {
  name: string;                 // имя функции для LLM
  description: string;          // когда вызывать (читает модель)
  parameters: TParams;          // Zod-схема → JSON schema аргументов
  execute: (args) => Promise<unknown>;  // выполнение
}
```

Zod-схема конвертится в OpenAI function-формат (`toolToOpenAIFunction()`),
аргументы валидируются перед `execute`.

## Алгоритм tool-loop

`runToolLoop()` (`tool-loop.ts`), макс. циклов `DEFAULT_MAX_TOOL_CYCLES = 4`:

```
повтор до maxCycles:
  1. chat.completeWithTools(messages, toolDefs)
  2. нет tool-calls → return { content, exhausted: false }   ← финал
  3. добавить assistant-сообщение с вызовами
  4. выполнить инструменты параллельно (Promise.allSettled)
  5. результат каждого → message { role: "tool", tool_call_id, content }
  6. записать ToolCallRecord (name, args, result/ошибка, cycle)
лимит исчерпан → return { content: null, exhausted: true }
```

Устойчивость к ошибкам: неизвестный инструмент и брошенная `execute`-ошибка
возвращаются модели как `{ error }` — loop **никогда не падает** на ошибке
инструмента, модель может попробовать иначе.

## Встроенные инструменты

| Инструмент | Файл | Что делает |
|---|---|---|
| `offer_booking_link` | `packages/kb/src/built-in-tools/calendly.ts` | `makeBookingLinkTool(url)` — когда лид хочет записаться/созвониться, возвращает `{ url }` (Calendly/Cal.com/Tidycal). Без аргументов. |
| Exchange-инструменты | `apps/api/src/lib/exchange/tools.ts` | `makeExchangeTools()` — котировка, KYC-гейт, заявка, реквизиты и т.д. (подключаются если у тенанта есть активные курсы). См. [EXCHANGE.md](EXCHANGE.md). |

## Подключение в pipeline

- `RagReplyStrategy.resolveTools({ tenantId, conversationId })`
  (`packages/conversation-engine/src/reply-strategy/rag-reply.ts`) вызывается
  раз на входящее сообщение и возвращает список `RagTool[]`; они передаются в
  `answerWithRag()`. Нет резолвера → пустой список → tool-loop не активен.
- Если tool-loop реально вызвал инструменты, `RagReplyStrategy.recordToolCalls`
  и `LlmReplyStrategy.recordToolCalls` сохраняют trace в `agent_tool_calls`
  через `AgentToolCallsRepo`: tool name, args/result JSON, error flag,
  cycle/index, conversation/contact. Это основа для self-learning/coach/outcome
  анализа; запись идёт после LLM/tool execution через отдельную короткую
  `withTenant` транзакцию.
- Admin quality API даёт read/review слой поверх traces:
  `GET /api/admin/quality/tool-calls` фильтрует вызовы по tenant/conversation/
  message/outbound/tool/error/source, а `POST /api/admin/quality/tool-calls/:id/feedback`
  пишет human label в `agent_tool_call_feedback` (`good_reply`, `wrong_tool`,
  `missing_tool`, `bad_args`, `other`). `GET /api/admin/quality/tool-call-feedback/summary`
  показывает label counts и top failing tools, `GET /api/admin/quality/tool-call-feedback/proposals`
  группирует actionable labels (`wrong_tool`, `missing_tool`, `bad_args`) в
  operator-facing improvement proposals, а JSONL export даёт разметку для
  offline анализа.
- Coach proposals (`POST /api/admin/quality/coach/proposals`) подтягивают
  последние actionable feedback labels по тому же `styleId` и передают их в
  CoachAnalyzer как human-reviewed defects. Coach не меняет tool contracts
  автоматически: он выражает эти сигналы через style guidance, examples,
  skill attach/detach suggestions или rationale для operator follow-up.
- Резолвер собирается в `apps/api/src/llm-bootstrap.ts`: booking (из секрета
  `tool_booking_url`) + exchange-инструменты (если активны курсы). Кеши
  сбрасываются `invalidateToolsFor(tenantId)` после правок в админке.

## Настройка booking (admin API)

`apps/api/src/routes/admin-tools.ts`, хранение в `tenant_secrets`
(`tool_booking_url`, encrypted):

```
GET    /api/admin/tools             — список инструментов + enabled-флаги
GET    /api/admin/tools/booking     — { enabled, url }
POST   /api/admin/tools/booking     — { url } → валидирует, шифрует, hot-reload
DELETE /api/admin/tools/booking     — отключить
```

UI: страница «Инструменты» (`/tools`).

## Как добавить кастомный инструмент

1. Реализовать `RagTool` (name / description / Zod `parameters` / `execute`).
2. Вернуть его из резолвера в `RagReplyStrategy` (через опцию `resolveTools`).
3. Если конфигурируется тенантом — завести секрет/конфиг, ручки в admin-API и
   подключить в `llm-bootstrap.ts` с кешем + `onReload`-инвалидацией.

Образец — booking-инструмент выше.

## Roadmap

Дальнейшие инструменты (CRM create-lead, calendar book-slot, payment invoice,
operator alert) — см. [strategy/ROADMAP.md](../strategy/ROADMAP.md) (M7).
