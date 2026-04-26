# tg-chatbot

Telegram-бот с RAG по базе знаний, анкетой по токену и админкой с ручным
перехватом диалога. Всё на чистом Bun без HTTP-фреймворка, БД — встроенный
`bun:sqlite` + расширение `sqlite-vec`. Поддерживаются OpenAI-совместимые
API и локальная Ollama (без расхода токенов).

Разрабатывается через TDD: на каждый юнит сначала падающий тест, потом
минимальная реализация. Текущее состояние: **88 unit + 12 e2e зелёных, 0 линтов.**

## Быстрый старт

```bash
bun install
cp .env.example .env        # отредактируйте под себя
bun run dev
```

Сервер слушает `PORT` (по умолчанию 3000). Health-чек:
[http://localhost:3000/health](http://localhost:3000/health).

## Выбор LLM-провайдера

В `.env` переключатель `LLM_PROVIDER`:

### OpenAI / любой OpenAI-совместимый API

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIM=1536
```

### Локальная Ollama (без токенов)

```bash
LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_CHAT_MODEL=llama3.1
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_EMBEDDING_DIM=768
```

Перед стартом:

```bash
ollama serve                       # или Ollama Desktop
ollama pull llama3.1
ollama pull nomic-embed-text
```

Размерность векторного индекса синхронизируется автоматически: если
`OLLAMA_EMBEDDING_DIM` отличается от текущей, таблица `kb_vec` пересоздаётся
при старте (с предупреждением — KB нужно переиндексировать).

| Эмбеддинг-модель | dim |
|---|---|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `bge-m3` | 1024 |

## CLI

```bash
bun run build:ui                               # собрать React SPA (admin-ui/dist/)
bun run dev:ui                                 # Vite dev-server с HMR на :5173 (proxy → :3000)
bun scripts/ingest.ts ./docs                   # индексация .md/.txt в KB
bun scripts/create-admin.ts <email> <password> # создать аккаунт оператора
bun scripts/set-webhook.ts set <publicUrl>     # привязать webhook к Telegram
bun scripts/set-webhook.ts info                # проверить статус
bun scripts/set-webhook.ts delete              # отвязать
```

## Тесты

- Бэкенд (юниты): `bun run test`
- E2E (Playwright): `bun run test:e2e:install` (один раз) и `bun run test:e2e`

Playwright поднимает сервер автоматически на отдельном порту (`E2E_PORT`,
по умолчанию 3100) с тестовой БД `data/test.db` и `TEST_HOOKS=1`, чтобы тесты
могли сидать данные через `/__test/*` (эти роуты доступны только при этом
флаге и не должны включаться в проде).

## Архитектура

```
Telegram → /telegram/<secret> ─┬─► whitelist (UsersRepo)
                                ├─► message persisted (MessagesRepo)
                                ├─► escalation triggers? ─► mode=queued
                                └─► RAG: embed → kb.search → LLM
                                    └─► NO_CONTEXT? ─► mode=queued
```

- `src/router.ts` — мини-роутер поверх `Bun.serve`.
- `src/server.ts` — `createServer()`: объединяет router + WebSocket upgrade.
- `src/db/` — `bun:sqlite` + `sqlite-vec`, миграции, репозитории.
- `src/rag/` — чанкинг, эмбеддинги (OpenAI/Ollama), retrieval, ответы.
- `src/telegram/` — клиент Bot API, webhook, эскалация.
- `src/questionnaire/` — токены и форма `/q/:token`.
- `src/admin/auth.ts` — логин/логаут/сессии (`Bun.password` argon2id, HttpOnly cookie).
- `src/admin/api.ts` — REST: пользователи, диалоги, take/release.
- `src/admin/bus.ts` — `AdminBus`: pub/sub для WS-клиентов.

### Admin API (все за исключением `login` требуют авторизацию через cookie)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/admin/api/login` | Вход, возвращает `Set-Cookie` |
| `POST` | `/admin/api/logout` | Выход, сбрасывает cookie |
| `GET` | `/admin/api/me` | Текущий администратор |
| `GET` | `/admin/api/users` | Список пользователей |
| `GET` | `/admin/api/conversations` | Список диалогов (queued первые) |
| `GET` | `/admin/api/conversations/:id` | Диалог + сообщения |
| `POST` | `/admin/api/conversations/:id/take` | Переключить в `human` |
| `POST` | `/admin/api/conversations/:id/release` | Вернуть в `ai` |
| `WS` | `/admin/api/ws` | Realtime-события (`message:new`, `conversation:updated`) |

## Прогресс

| # | Задача | Статус |
|---|---|---|
| 1 | `bootstrap` — Bun.serve, мини-роутер, `/health`, Playwright smoke | ✅ |
| 2 | `db-layer` — `bun:sqlite` + `sqlite-vec`, миграции, репозитории | ✅ |
| 3 | `tg-client` — клиент Bot API + `setWebhook` CLI | ✅ |
| 4 | `webhook` — `/telegram/<secret>` с whitelist и плейсхолдером | ✅ |
| 5 | `kb-ingest` — CLI: txt/md → чанки → эмбеддинги | ✅ |
| 6 | `rag` — retrieval top-k + LLM + ответ в TG | ✅ |
| 7 | `questionnaire` — токен + GET/POST `/q/:token` + Playwright | ✅ |
| 8 | `ollama` — нативный провайдер + динамический `kb_vec` | ✅ |
| 9 | `escalation` — триггеры (ключевые слова + `NO_CONTEXT`) → `queued` | ✅ |
| 10 | `admin-auth` — `Bun.password` + сессии + middleware `/admin/*` | ✅ |
| 11 | `admin-api-ws` — REST + WebSocket-бродкаст для админки | ✅ |
| 12 | `admin-ui` — React + Vite: Login / Users / Chats / Chat | ✅ |
| 13 | `operator-reply` — ответ оператора → TG + WS + возврат `mode=ai` | ⏳ |
| 14 | `smoke` — финальный happy-path E2E + чеклист релиза | ⏳ |
