# Architecture

Высокоуровневая карта проекта. Один Telegram-бот с RAG, sales-style engine, операторской админкой и пайплайном RAG-надстроек. Всё на чистом Bun + SQLite (с расширением `sqlite-vec`).

## Запрос end-to-end

```
Telegram update
   │
   ▼
POST /telegram/<secret>      ─┬─► users.byTgId / whitelist (TELEGRAM_OPEN_ACCESS)
                              │
                              ├─► messages.addUserMessageIfNew (idempotent)
                              │
                              ├─► escalation triggers? → mode=queued, return
                              │
                              └─► ack 200 + detached processInbound() ───────┐
                                                                              │
                                                                              ▼
                                                            ┌─────────────────────────────────┐
                                                            │ resolveStyle (env ▸ DB ▸ A/B)   │
                                                            │ classifyStage (regex / LLM)     │
                                                            │ users.getMemory  (RAG_USER_MEMORY) │
                                                            │ rewriteQuery     (RAG_QUERY_REWRITE) │
                                                            │ kb.hybridSearch  (RAG_HYBRID_SEARCH) │
                                                            │ composeSystemPrompt              │
                                                            │ chat.complete                    │
                                                            │ verifyAnswer     (RAG_REFLECT)  │
                                                            └─────────────────────────────────┘
                                                                              │
                                                       ┌──────────────────────┼─────────────────────┐
                                                       ▼                      ▼                     ▼
                                                send to TG          NO_CONTEXT_MARKER       ungrounded → silent
                                                       │
                                                       └─► fire-and-forget: extractUserFacts → mergeMemoryFacts
```

Все четыре RAG-надстройки **опциональны** и независимы. Подробности в [RAG_LAYERS.md](RAG_LAYERS.md).

## Слои

```
┌──────────────────────────── HTTP / WebSocket ─────────────────────────────┐
│ src/server.ts          createServer(): Bun.serve + WS upgrade             │
│ src/router.ts          мини-роутер с :params                              │
│ src/app.ts             регистрация всех routes (admin, telegram, ws, ui)  │
└────────────────────────────────────────────────────────────────────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ telegram/        │   │ admin/               │   │ questionnaire/       │
│   webhook.ts     │   │   api.ts (REST)      │   │   routes.ts          │
│   client.ts      │   │   auth.ts (sessions) │   │   /q/:token          │
│   escalation.ts  │   │   bus.ts (WS pub/sub)│   └──────────────────────┘
└──────────────────┘   └──────────────────────┘
        │                          │
        └──────────┬───────────────┘
                   ▼
┌──────────────────────────────── domain layer ─────────────────────────────┐
│ rag/                                  sales/                              │
│   answer.ts (entry point)              types.ts (Style schema, Zod)        │
│   chat.ts / embed.ts (interfaces)      prompt.ts (composeSystemPrompt)     │
│   text-style-rules.ts (postproc)       stage-router.ts (regex)             │
│   extract-user-facts.ts                stage-classifier.ts (LLM)           │
│   rewrite-query.ts                     ab-router.ts (deterministic)        │
│   reflect.ts                           styles/ (built-in styles)           │
│   providers/ (ollama, openai, openrouter)                                  │
└────────────────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────── data layer ───────────────────────────────┐
│ db/                                                                       │
│   sqlite.ts (Bun.Database + sqlite-vec extension)                         │
│   migrate.ts (file-based migrations runner)                               │
│   ensure-kb-vec.ts (auto re-create kb_vec on dim change)                  │
│   repos/                                                                  │
│     users.ts         conversations.ts    messages.ts                      │
│     kb.ts            styles.ts           experiments.ts                   │
│     admins.ts        sessions.ts         questionnaire_tokens.ts          │
└────────────────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────── persistence ────────────────────────────────┐
│ data/bot.db (SQLite, WAL)                                                 │
│   users / conversations / messages                                        │
│   kb_documents / kb_chunks / kb_vec / kb_chunks_fts                       │
│   styles / experiments                                                    │
│   admins / sessions / questionnaire_tokens                                │
└────────────────────────────────────────────────────────────────────────────┘
```

## Ключевые design decisions

### Stateless webhook, sticky DB state

Webhook ackает Telegram в <100ms (Bot API таймаут — 60s, retries дублируют сообщения). Тяжёлая обработка (RAG → LLM → sendMessage) detached в `processInbound()`. State (mode, current_stage, style_id, memory) хранится в БД — рестарты сервера ничего не теряют.

### Один conversation на user

`conversations.ensureForUser(userId)` идемпотентна — у одного Telegram-юзера только один conversation. Если оператор удалил его — следующее сообщение создаст новый, **но** `users.profile_json.memory` сохраняется (привязан к `users.id`, не к `conversations.id`). Это и нужно.

### Two-tier system prompt

- **Legacy persona** (`buildSystemPrompt`) — простой, через `BOT_PERSONA_*` env vars. Достаточно для одного бота с одной воронкой.
- **Sales-style engine** (`composeSystemPrompt`) — богатый: persona + voice + framework + Cialdini hooks + per-stage guidance + few-shot. Управляется в админке (`/admin/styles`), поддерживает A/B через `experiments`.

Style побеждает persona когда оба заданы (`answerWithRag` смотрит сначала на `input.style`).

### NO_CONTEXT — silent, не stall

Когда RAG не находит контекст ИЛИ reflection детектит галлюцинацию, бот **молчит**. Conversation остаётся в `mode=ai`, следующее сообщение снова попробует RAG. Альтернатива (отправлять "сейчас уточню") создавала бы false expectations и вешала бы дискуссию на оператора без явного триггера.

Эскалация на оператора — отдельный путь: только по явным ключевым словам кандидата (`escalation.ts`).

### Pluggable LLM providers, decoupled chat ↔ embeddings

`LLM_PROVIDER` управляет чатом, `EMBEDDING_PROVIDER` — embeddings. Их разделяет реальность — у OpenRouter нет endpoint'а для embeddings. Поддерживаемые сочетания:

| Chat | Embed | Use case |
|------|-------|----------|
| OpenAI | OpenAI | стандарт |
| OpenRouter | Ollama | Claude/GPT в облаке + локальные дешёвые embeddings |
| OpenRouter | OpenAI | всё в облаке, но через OpenRouter аналитику |
| Ollama | Ollama | full-local, без расхода токенов |

### Operator-first UI

Админка — не CRUD над БД, а инструмент для **перехвата** диалога. Ключевые операции:
- `Take over` → `mode=human`, бот замолкает, оператор пишет в TG
- `Release` → `mode=ai`, бот возобновляет
- `MEMORY` pane — править то, что бот «знает» о кандидате
- `Delete` → стереть переписку (например, тестовый чат), persona-память сохраняется

WS `/admin/api/ws` стримит события в реальном времени — список чатов сам перестраивается без рефреша.

## Слои данных

| Таблица | Назначение |
|---------|-----------|
| `users` | whitelisted Telegram-юзеры, `status` для воронки, `profile_json.memory.facts` для cross-session памяти |
| `conversations` | одна на юзера, `mode` ∈ ai/queued/human, `current_stage`, `style_id`+`experiment_id` (A/B-стiky) |
| `messages` | `role` ∈ user/assistant/human/system, idempotent по `tg_message_id`, `meta_json` для `used_chunk_ids`, `stage` для funnel-аналитики |
| `kb_documents` | source файлы для RAG, dedup по `content_hash` |
| `kb_chunks` | чанки ≈1500 символов с overlap 150 |
| `kb_vec` | vector index (sqlite-vec, dim из конфига) |
| `kb_chunks_fts` | BM25 keyword index (FTS5, unicode61 tokenizer) — синхронизирован триггерами |
| `styles` | sales-style configs, версионируется (parent_id) |
| `experiments` | A/B definitions (slug + allocation JSON + status) |
| `admins` / `sessions` | argon2id auth, HttpOnly cookies |
| `questionnaire_tokens` | one-shot tokens для формы `/q/:token` |

## Documentation map

- [README.md](../README.md) — настройка, env, провайдеры, CLI, KB pipeline, full setup guide
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — этот файл, общая навигация
- [docs/RAG_LAYERS.md](RAG_LAYERS.md) — четыре опциональные надстройки (hybrid, memory, rewrite, reflect): зачем, как, цена, тесты
- [docs/SALES_STYLES.md](SALES_STYLES.md) — sales-style engine: схема Style, A/B testing, integration с RAG
- [docs/ROADMAP.md](ROADMAP.md) — что сделано, что в очереди (Tier 1/2/3 по ROI)

## Тестовая стратегия

- **Unit tests** (`bun run test`, ≥478): TDD, каждый модуль изолирован, `:memory:` SQLite. Тесты на каждый repo, prompt builder, RAG layer, parsing helper, admin handler.
- **E2E tests** (`bun run test:e2e`, 14): Playwright прогоняет happy-path через всю стек (Telegram update → admin UI → ответ обратно в TG). Отдельная test DB, `TEST_HOOKS=1` для seed эндпоинтов.
- **Build check**: `bun run build:ui` — Vite сборка React-админки. Должна быть зелёной перед PR.
- **Type check**: `bunx tsc --noEmit --ignoreDeprecations 6.0` — TypeScript strict, известные warnings в test-файлах из-за Bun 1.3 fetch types (не блокирующие).
