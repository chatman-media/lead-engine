# tg-chatbot

[![CI](https://img.shields.io/github/actions/workflow/status/chatman-media/sales-guru/ci.yml?style=flat-square&label=ci)](https://github.com/chatman-media/sales-guru/actions/workflows/ci.yml)

Telegram sales-funnel бот с RAG, pluggable sales-style engine, A/B-тестами, самообучением через self-play и полноценной операторской админкой. Всё на чистом Bun без HTTP-фреймворка — PostgreSQL + pgvector для векторного поиска, gramjs для MTProto userbot-режима.

## Возможности

**RAG pipeline** — ответы из базы знаний: hybrid retrieval (BM25 + vector + RRF), cross-session memory кандидата, query rewriting, reflection-проверка на галлюцинации, conversation summarization, topic-routed retrieval. Все слои opt-in через `.env`. Подробности — [docs/RAG_LAYERS.md](docs/RAG_LAYERS.md).

**Sales-style engine** — pluggable персоны с фреймворками продаж (AIDA / PAS / SPIN / NEPQ / Straight Line), хуками Чалдини и per-stage guidance. Управляется из `/admin/styles`, поддерживает A/B через `/admin/experiments`. Подробности — [docs/SALES_STYLES.md](docs/SALES_STYLES.md).

**Skills catalogue** — каталог техник убеждения (`social_proof_with_numbers`, `reciprocity_gift_offer` и т.д.), включаемых по-стильно. Инжектируются в system prompt, граются post-generation LLM-вызовом. Результаты на лидерборде в `/admin/skills`.

**Self-play + coaching** — автоматизированный тренировочный цикл: бот (salesperson-LLM) против LLM-кандидата → LLM-судья → ELO-рейтинг стилей → coach-LLM предлагает правки → shadow A/B validation. Без ручного труда. Подробности — [docs/SELF_PLAY.md](docs/SELF_PLAY.md).

**Lead pipeline** — воронка кандидата от диалога до подачи на визу: авто-сбор intake (рост / вес / город / фото / загран), карточка в TG-чат с кнопками одобрить/отклонить, авто-парсинг 27 полей визовой анкеты, финальный пакет с `VS-YYYY-NNNN` в визовый чат. Подробности — [docs/LEADS.md](docs/LEADS.md).

**Vacancies** — быстро-меняющийся слой: оператор добавляет вакансию в `/admin/vacancies` → следующий ответ бота уже её видит, без re-embedding.

**Userbot (MTProto)** — бот может работать с личного аккаунта Telegram через gramjs. Отвечает на входящие личные сообщения. Подробности — [docs/USERBOT.md](docs/USERBOT.md).

**Operator admin** — React SPA: список диалогов, ручной перехват (`Take over` / `Release`), reply из браузера, MEMORY pane для редактирования памяти о кандидате, lead pipeline UI, KB browser с approval queue для незнакомых вопросов, styles + experiments + self-play + coach + analytics — всё в реальном времени через WebSocket. Раздел **Операции** (`/admin/ops`) даёт UI-эквиваленты частых CLI-задач: re-ingest KB с диска, привязать/сменить Telegram webhook, очистить старые self-play результаты, ре-засеять дефолтные вакансии, посмотреть очередь userbot.

**Conversation export** — диалоги как JSONL (OpenAI fine-tune compatible): `GET /admin/api/conversations/export.jsonl` с фильтрами по style/experiment/status. Готово для дообучения модели.

### Documentation map

| Файл | Что |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Слои, request lifecycle, data layer, design decisions |
| [docs/RAG_LAYERS.md](docs/RAG_LAYERS.md) | 6 opt-in RAG надстроек: hybrid / memory / rewrite / reflect / summary / topic-routing |
| [docs/SALES_STYLES.md](docs/SALES_STYLES.md) | Sales-style engine: схема Style, skills, A/B testing, промпт |
| [docs/SELF_PLAY.md](docs/SELF_PLAY.md) | Self-play / pairwise / coaching / shadow evaluation |
| [docs/LEADS.md](docs/LEADS.md) | Lead pipeline: state machine, intake/visa-docs, operator workflow |
| [docs/USERBOT.md](docs/USERBOT.md) | Userbot (MTProto): setup, auth, конфигурация |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Docker / nginx / Cloudflare Tunnel / backups / KB ingest / recovery |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Что сделано, что в очереди |

---

## Быстрый старт

### Dev (Bun)

```bash
bun install
cp .env.example .env        # отредактируйте под себя
# Обязательно задайте DATABASE_URL=postgres://... в .env
bun run dev
```

### Production (Docker)

```bash
cp .env.example .env        # TELEGRAM_BOT_TOKEN, LLM-провайдер, LEADS_CHAT_ID, VISA_CHAT_ID
docker compose up -d
docker compose logs -f app
# Полностью локальный стек с Ollama:
# docker compose --profile ollama up -d
```

Полная инструкция (reverse proxy / HTTPS / бэкапы) — [docs/DEPLOY.md](docs/DEPLOY.md).

Сервер слушает `PORT` (по умолчанию `3000`). Health-чек: `GET /health`.

---

## Выбор LLM-провайдера

`LLM_PROVIDER` управляет **чатом**, `EMBEDDING_PROVIDER` — **эмбеддингами**. Разделены, потому что у OpenRouter нет endpoint'а для embeddings — даже с `LLM_PROVIDER=openrouter` нужен отдельный провайдер для векторного поиска.

### OpenAI / OpenAI-совместимый

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIM=1536
```

### OpenRouter (Claude / GPT / Gemini одним ключом)

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_CHAT_MODEL=anthropic/claude-haiku-4.5

# OpenRouter не делает embeddings — embedder отдельно.
EMBEDDING_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=bge-m3:latest
OLLAMA_EMBEDDING_DIM=1024

# Опционально — атрибуция в OpenRouter dashboard:
OPENROUTER_SITE_URL=https://your-site.com
OPENROUTER_APP_NAME=tg-chatbot
```

Рекомендуемые модели:

| Модель | Цена | Русский | Стиль |
|---|---|---|---|
| `anthropic/claude-haiku-4.5` | $$ | excellent | тёплый/холодный держит ровно |
| `anthropic/claude-sonnet-4.6` | $$$$ | excellent | лучший few-shot |
| `openai/gpt-4o-mini` | $ | good | быстро, но стилистически блёкло |
| `google/gemini-2.5-flash` | $ | good | дешевле всех frontier-class |
| `qwen/qwen3-8b` | $ | good | то же что локальный, но в облаке |

### Локальная Ollama (без токенов)

```bash
LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen3:latest
OLLAMA_EMBEDDING_MODEL=bge-m3:latest
OLLAMA_EMBEDDING_DIM=1024
RAG_MAX_DISTANCE=1.00
RAG_TOP_K=5
```

```bash
ollama serve
ollama pull qwen3      # 8B, q4_K_M, ~5 GB VRAM, 30K context
ollama pull bge-m3     # 567M, мультиязычный (ru/zh/ko), 1024-dim
```

`qwen3` хорошо выдерживает строгие правила system-prompt и поддерживает `think:false` (bot подмешивает `/no_think` чтобы подавить CoT-блок). `gemma3` и `rnj-1` **не рекомендуются** — склонны переспрашивать вместо ответа.

| Embedder | dim |
|---|---|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `bge-m3` | 1024 |

Размерность `kb_vec` синхронизируется автоматически — при смене `OLLAMA_EMBEDDING_DIM` таблица пересоздаётся (KB нужно переиндексировать).

---

## CLI

Большинство частых операций есть и в админке — раздел **`/admin/ops`** (Операции). CLI ниже остаётся для bootstrap (первый admin, userbot auth) и для тяжёлых пайплайнов (Telegram-экспорт, Whisper).

```bash
bun run build:ui                                 # собрать React SPA
bun run dev:ui                                   # Vite dev-сервер с HMR → :5173

bun scripts/create-admin.ts <email> <password>   # bootstrap: первый аккаунт оператора (UI gated)
bun scripts/userbot-auth.ts                      # одноразовый MTProto-логин (интерактивный)

# Эти доступны и из /admin/ops:
bun scripts/set-webhook.ts set <publicUrl>        # привязать webhook к Telegram
bun scripts/set-webhook.ts info                  # проверить статус
bun scripts/set-webhook.ts delete                # отвязать
bun scripts/ingest.ts ./kb/curated               # индексировать .md/.txt в KB
bun scripts/ingest-books.ts ./kb/books           # книги с topic=books
bun scripts/kb-wipe.ts                           # очистить KB
bun scripts/seed-vacancies-infinity.ts           # задать демо-вакансии
bun scripts/purge-old-outcomes.ts                # очистить старые skill_outcomes

# CLI-only (большие/интерактивные/одноразовые):
bun scripts/tag-kb-by-keyword.ts                 # прокатить keyword-теги по существующей KB
bun scripts/extract-tg.ts kb/result.json kb/extracted  # парсить Telegram-экспорт
bun scripts/transcribe.ts kb/result.json kb/extracted  # расшифровать голосовые (Whisper)
bun scripts/self-play.ts                         # один self-play матч (UI: /admin/self-play)
bun scripts/pairwise.ts                          # pairwise A/B матч (UI: /admin/pairwise)
bun scripts/coach.ts                             # coach-предложения (UI: /admin/coach)
bun scripts/get-chat-ids.ts                      # найти ID групп для LEADS_CHAT_ID / VISA_CHAT_ID
```

---

## База знаний: пайплайн данных

```
Telegram-экспорт (result.json + медиа)
        │
        ▼  scripts/extract-tg.ts
kb/extracted/  posts/  dialogs/  voice/INDEX.md
        │
        ▼  scripts/transcribe.ts   (опционально: голосовые → текст через Whisper)
        │
        ▼  курация вручную → kb/curated/
        │
        ▼  scripts/ingest.ts
PostgreSQL + pgvector  (kb_documents / kb_chunks / kb_vec FTS)
```

Бот видит обновлённую базу сразу — перезапуск сервера не нужен.

Подробно о каждом шаге — в README секции "База знаний: пайплайн данных" ниже, или сразу в [docs/DEPLOY.md](docs/DEPLOY.md#ingesting-the-kb-inside-the-container) для продакшн-индексации.

### Экстракция (`extract-tg.ts`)

Парсит `result.json` из Telegram Desktop export:
- **Посты** — уникальные длинные (≥250 символов) реплики агента, дедуплицированные по содержимому.
- **Диалоги** — Q&A-пары из чатов с реальной активностью.
- **Голосовые** — индекс `voice/INDEX.md` для последующей транскрипции.

```bash
bun scripts/extract-tg.ts kb/result.json kb/extracted
# Другой отправитель:
bun scripts/extract-tg.ts kb/result.json kb/extracted --agent user1234567890
```

### Транскрипция (`transcribe.ts`)

```bash
bun scripts/transcribe.ts kb/result.json kb/extracted
bun scripts/transcribe.ts kb/result.json kb/extracted --all     # включая голосовые кандидатов
bun scripts/transcribe.ts kb/result.json kb/extracted --dry-run # что будет расшифровано

# .env:
WHISPER_BASE_URL=https://api.openai.com/v1
WHISPER_API_KEY=sk-...
WHISPER_MODEL=whisper-1
WHISPER_LANGUAGE=ru
```

Резюмируемый — повторный запуск пропускает уже расшифрованные. После транскрипции повторно запустите `extract-tg.ts` — встроит транскрипты в диалоги.

### Индексация (`ingest.ts`)

```bash
bun scripts/ingest.ts kb/curated
# Размер чанка можно переопределить (default: 1500 символов, overlap 150):
bun scripts/ingest.ts kb/curated --max-chars 1200 --overlap 100
```

Идемпотентен — SHA-256 каждого файла, неизменённые пропускаются. PDF-поддержка через `unpdf` без нативных зависимостей.

---

## RAG-надстройки

Все выключены по умолчанию. Включай по одному, проверяй на своём трафике.
Подробное описание каждого — в [docs/RAG_LAYERS.md](docs/RAG_LAYERS.md).

```bash
RAG_HYBRID_SEARCH=true       # BM25 + vector + RRF. Без LLM-цены, чистый upgrade.
RAG_USER_MEMORY=true         # Cross-session memory. Видно и редактируется в админке.
RAG_QUERY_REWRITE=true       # "а в Стамбуле?" → полный вопрос перед retrieval.
RAG_REFLECT=true             # Reflection: ответ проверяется на галлюцинации.
RAG_CONVERSATION_SUMMARY=true # Сжатие старых turn'ов (>30) в параграф.
RAG_TOPIC_ROUTING=true       # Фильтр KB по теме (visa/payment/locations/...).
RAG_BOOKS_PRIORITY=true      # Книги (topic=books) отвечают первыми, общая KB — fallback.
```

### Библиотека книг

```bash
bun scripts/ingest-books.ts ./kb/books   # PDF/TXT/MD → topic=books

# или через Admin UI → /admin/library (drag-and-drop)

# .env:
RAG_BOOKS_PRIORITY=true
```

---

## Sales-style engine

Управление через `.env` или `/admin/styles` + `/admin/experiments`.

```bash
# Один стиль для всех:
BOT_SALES_STYLE=alina-infinity-v1

# Или A/B через админку: Experiments → New → Start
```

Built-in стили:

| slug | Персона | Фреймворк | Тон |
|---|---|---|---|
| `alina-infinity-v1` | Алина, INFINITY AGENCY | NEPQ | тёплый, менеджер в личке |
| `flirty-belfort-v1` | Алина — флирт-рекрутер | Straight Line | тёплый, дерзкий |
| `empathetic-nepq-v1` | Маша — эмпатичный консультант | NEPQ | спокойный, low-pressure |
| `cold-direct-pas-v1` | Игорь — прямой | PAS | сухой, без воды |

Подробности, схема Style, skills catalogue, authoring guide — [docs/SALES_STYLES.md](docs/SALES_STYLES.md).

---

## Self-play и coaching

Автоматизированный тренировочный цикл:

```
self-play матч  →  судья  →  ELO рейтинг  →  coach предложения  →  shadow A/B  →  новый стиль
```

```bash
# Запустить матч вручную:
bun scripts/self-play.ts --style alina-infinity-v1

# Pairwise A/B:
bun scripts/pairwise.ts --style-a flirty-belfort-v1 --style-b alina-infinity-v1

# Coach-предложения из недавних поражений:
bun scripts/coach.ts
```

Через админку: `/admin/self-play`, `/admin/pairwise`, `/admin/coach`.
Подробности — [docs/SELF_PLAY.md](docs/SELF_PLAY.md).

---

## Userbot (MTProto)

Бот работает с личного аккаунта Telegram. Одноразовая авторизация:

```bash
# .env:
TELEGRAM_USERBOT=1
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abc123...

# Первый запуск (телефон → OTP → 2FA):
bun scripts/userbot-auth.ts

# Потом просто:
bun run dev
```

Подробности — [docs/USERBOT.md](docs/USERBOT.md).

---

## Персона (legacy)

Когда `BOT_SALES_STYLE` не задан, используется простой legacy-режим:

```bash
BOT_PERSONA_NAME=Алина
BOT_PERSONA_ROLE=human       # human / assistant
BOT_PERSONA_COMPANY=INFINITY AGENCY
```

В режиме `human` промпт запрещает упоминать «бот», «ИИ», «ассистент». Когда KB не нашлась — бот молчит (не сочиняет), conversation остаётся в `mode=ai`.

---

## Тесты

### Локальный setup (один раз)

Тестам нужен **отдельный** PostgreSQL с pgvector. `cleanTestDb` между тестами делает `TRUNCATE CASCADE` по всем доменным таблицам — против прод-базы это снесёт данные, поэтому `getTestSql()` отказывается работать если host не `localhost` И имя БД не содержит `test`.

```bash
# 1. Создать локальную тестовую БД (один раз)
createdb tgchatbot_test
psql tgchatbot_test -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 2. Добавить в .env:
TEST_DATABASE_URL=postgres://localhost/tgchatbot_test
```

`TEST_DATABASE_URL` имеет приоритет над `DATABASE_URL`, продовая connection-string остаётся нетронутой. Скрипт `test` сам выставляет `OPENAI_EMBEDDING_DIM=8 / OLLAMA_EMBEDDING_DIM=8` (фейковые embedders в тестах 8-мерные, `activeEmbeddingDim()` должна совпадать со схемой).

### Запуск

```bash
bun run test              # unit tests
bun run test:coverage     # unit tests с отчётом покрытия
bun run test:e2e:install  # установить Playwright (один раз)
bun run test:e2e          # E2E (Playwright)
```

Playwright поднимает сервер на `E2E_PORT` (по умолчанию `3100`) с тестовой БД и `TEST_HOOKS=1` (seed-эндпоинты `/__test/*`, только с этим флагом).

---

## Архитектура (кратко)

```
Telegram update (Bot API webhook)
   │
   ▼
POST /telegram/<secret>
   ├─ whitelist (UsersRepo)
   ├─ message saved (idempotent by tg_message_id)
   ├─ escalation trigger? → mode=queued
   └─ ack 200 + detached processInbound()
          │
          ▼
   resolveStyle (env ▸ DB ▸ A/B experiment)
   classifyStage (regex / LLM)
   rewriteQuery (RAG_QUERY_REWRITE)
   kb.hybridSearch (RAG_HYBRID_SEARCH)
   composeSystemPrompt (persona + voice + framework + hooks + stage + few-shot + KB)
   chat.complete → sanitize → sendMessage
   verifyAnswer (RAG_REFLECT)
          │
          └─ fire-and-forget:
               extractUserFacts → mergeMemoryFacts
               gradeSkills → recordSkillOutcome
               intakeCheck → leadStateTransition

Telegram personal account (Userbot MTProto, optional)
   msg.reply() per message → same processInbound()
```

Полная карта слоёв — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
