<div align="center">

<a name="top"></a>

# Lead Engine

**AI front office для бизнеса, который живёт в мессенджерах**

[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![CodeQL](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/chatman-media/lead-engine/graph/badge.svg)](https://codecov.io/gh/chatman-media/lead-engine)
[![Security](https://github.com/chatman-media/lead-engine/actions/workflows/security.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/security.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![PostgreSQL + RLS](https://img.shields.io/badge/PostgreSQL-RLS%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![License: PolyForm NC 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20userbot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Messenger](https://img.shields.io/badge/Messenger-Send%20API-0084FF?logo=messenger&logoColor=white)](https://developers.facebook.com/docs/messenger-platform)
[![VK](https://img.shields.io/badge/VK-Callback%20API-0077FF?logo=vk&logoColor=white)](https://dev.vk.com/api/callback/getting-started)
[![MAX](https://img.shields.io/badge/MAX-Bot%20API-111827)](https://dev.max.ru/docs-api)
[![Stripe](https://img.shields.io/badge/Stripe-billing-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

Telegram Bot + Userbot · WhatsApp · Facebook Messenger · VK · MAX · Web Widget · BYOK LLM · RAG · операторский handoff · marketplace провайдеров

**🟢 Live: [exchanges.agency](https://exchanges.agency)** &nbsp;·&nbsp; [админка](https://client.exchanges.agency) &nbsp;·&nbsp; [dev](https://dev.exchanges.agency)

🌐 [🇬🇧 English](README.md) &nbsp;·&nbsp; 🇷🇺 **Русский** &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>

---

Lead Engine — это **multi-tenant AI operations platform** для бизнесов, где
продажи и исполнение идут через Telegram, WhatsApp, Messenger, VK, MAX и web
widget. Это не FAQ-бот. Он превращает хаотичный входящий чат в структурированные
заявки, стадии лида, ответы по базе знаний, решения оператора, передачу
партнёрам и аудит.

В текущем продукте есть два marketplace-слоя:

- **AI provider routing** — BYOK-конфиги на тенанта для назначений `chat`,
  `embed`, `vision`, `judge`, `reranker`, `transcribe`.
- **Service provider marketplace** — готовые и кастомные исполнители услуг,
  которых можно поставить в каталог тенанта и дальше маршрутизировать в
  воронку, партнёрский handoff, webhook или ручную обработку.

У каждого tenant'а свои каналы, LLM-конфиги, база знаний, воронки, каталог
услуг, партнёрский ledger и зашифрованные секреты. Изоляция данных enforced на
уровне **Postgres Row-Level Security**, а не только фильтрами в коде.

📖 **Docs:** [индекс](docs/README.md) · [Architecture](docs/engineering/ARCHITECTURE.md) · [Onboarding](docs/engineering/ONBOARDING.md) · [Service catalog](docs/engineering/SERVICE_CATALOG.md) · [Exchange](docs/engineering/EXCHANGE.md) · [Configuration](docs/engineering/CONFIGURATION.md) · [Roadmap](docs/strategy/ROADMAP.md)

---

## Что уже есть

| Слой | Что работает |
|---|---|
| Мессенджеры | Telegram bot, Telegram userbot (MTProto), WhatsApp Cloud API, Facebook Messenger, VK community messages, MAX Bot API, WebSocket web widget |
| AI routing | Конфиги провайдеров на тенанта, encrypted BYOK keys, hot reload в API, отдельные назначения для chat / embeddings / vision / judge / reranker / voice transcription |
| Retrieval | Hybrid RAG: pgvector, BM25, RRF, multi-query, dynamic trimming, MMR, Jina/Cohere reranker, hallucination guard |
| Workflows | Универсальный костяк воронки, AI funnel builder, drag-drop стадии/поля, multi-request concierge, exchange rates/orders, awaiting-operator стадии |
| Marketplace услуг | Curated Phuket providers, свои провайдеры, service catalog routes, partner services, partner deals, комиссии и handoff modes |
| Кабинет оператора | Inbox, AI/human takeover, board лидов, каталог, партнёры, уведомления, outreach, шаблоны, аудит, диагностика, admin copilot |
| Безопасность | Tenant RLS, AES-256-GCM secrets, webhook signatures, rate limiting, audit без raw secrets |

---

## Как устроен продукт

### Мессенджеры

| Kind | Входящие | Исходящие | Детали |
|---|---|---|---|
| `telegram_bot` | Bot API webhook + `X-Telegram-Bot-Api-Secret-Token` | worker -> Bot API | Auto-`setWebhook`, если задан `PLATFORM_PUBLIC_URL` |
| `telegram_userbot` | MTProto receive loop в `apps/api` | in-process userbot dispatcher | Per-tenant `api_id` / `api_hash`, fallback env |
| `whatsapp` | Meta webhook + `X-Hub-Signature-256` | worker -> Meta Graph | Per-tenant access token, verify token, app secret |
| `facebook` | Messenger webhook + `X-Hub-Signature-256` | worker -> Messenger Send API | Page Access Token, правило 24h response window |
| `vk` | VK Callback API | worker -> VK `messages.send` | Сообщения сообщества, text-first MVP |
| `max` | MAX Bot API webhook + `X-Max-Bot-Api-Secret` | worker -> MAX `POST /messages` | Per-channel bot token и webhook secret, text-first MVP |
| `web` | WebSocket `/ws/:slug` | in-process web dispatcher | Embed script + standalone demo client |

Входящее валидируется, проходит rate-limit, сохраняется в `tx1`, затем LLM/RAG
работает **без открытой DB-транзакции**, после чего исходящее кладётся в очередь
в `tx2`. Worker забирает `outbound_queue` через `FOR UPDATE SKIP LOCKED`; web и
userbot отправляются in-process, потому что live-соединение живёт в `apps/api`.

### AI-провайдеры

Тенант может собрать свою модельную связку:

| Purpose | Типичные провайдеры | Для чего |
|---|---|---|
| `chat` | OpenAI, OpenRouter, Ollama; DB/UI также несёт Anthropic slots | Ответы, extraction, sales reasoning, tools |
| `embed` | OpenAI / OpenAI-compatible endpoints, Ollama | Индексация KB и retrieval vectors |
| `vision` | OpenAI, OpenRouter-compatible vision models | Анализ фото/документов, KYC |
| `judge` | OpenAI, OpenRouter, Anthropic | Quality lab, self-play, evaluation |
| `reranker` | Jina, Cohere | Cross-encoder после hybrid retrieval |
| `transcribe` | OpenRouter, OpenAI-compatible APIs | Расшифровка voice notes, включая Groq через custom base URL |

Ключи лежат в `tenant_secrets` под AES-256-GCM. Один ключ можно переиспользовать
между назначениями одного провайдера. Изменения применяются без рестарта
`apps/api`.

### Marketplace провайдеров услуг

Каталог — главная поверхность для бизнесов, которые продают не одну услугу, а
набор операций: трансфер, уборка, массаж, салон, жильё, exchange, кастомные
офферы и любые услуги тенанта.

Услуга в каталоге ведёт в один из четырёх маршрутов:

| Route type | Значение |
|---|---|
| `funnel` | Lead Engine сам ведёт процесс: стадии, поля, AI-поведение, операторские шаги |
| `partner_service` | Услугу исполняет партнёр/провайдер; платформа трекает handoff и комиссию |
| `webhook` | Заявка уходит во внешнюю систему |
| `manual` | Оператор разбирает вручную |

Curated marketplace install создаёт сразу `partners`, `partner_services` и
`service_catalog_items`. Если нужного исполнителя нет в витрине, его можно
добавить как кастомного провайдера из UI. Детали:
[SERVICE_CATALOG.md](docs/engineering/SERVICE_CATALOG.md).

---

## Vertical packs

Runtime вертикале-агностичен, но в репозитории уже есть готовые стартовые
наборы: воронки, поля, промпты и поведение стадий.

| Template | Бизнес | Статус |
|---|---|---|
| `exchange_v1` | Crypto/RUB -> THB exchange desk | live, самая активная |
| `concierge_v1` | Multi-service desk для вилл, expat и hospitality | multi-request, provider handoff |
| `recruitment_v1` | Рекрутинг и релокация | GTM ICP |
| `modeling_v1` | Модельные агентства | implemented |
| `real_estate_v1` | Продажа недвижимости | implemented |
| `saas_v1` | SaaS sales pipeline | implemented |
| `video_v1` | Видеопродакшн | implemented |
| `visa_v1` | Визы и immigration services | implemented |
| `scooter_v1` | Аренда байков и скутеров | implemented |

Универсальный костяк:

```text
capture -> qualify -> offer -> [clear] -> [fulfill] -> won / lost
```

У активных стадий хранится `phase`; intake и terminal-стадии — якоря. AI builder
и `/api/admin/workflows/apply` валидируют монотонность фаз и наличие обязательных
`qualify` / `offer` перед сохранением.

---

## Демо

| Демо | Что показывает |
|---|---|
| `apps/landing` | Public demos: exchange, concierge/service desk, provider marketplace, visa, vertical library |
| `apps/api/demo/web-chat.html` | Standalone web-channel клиент для `/ws/:slug` |
| `apps/api/scripts/seed-modeling-demo.ts` | Seed/demo data для modeling vertical |
| `docs/gtm/sales-bot/SETUP.md` | Meta-demo: бот, который продаёт сам Lead Engine |
| `packages/kb/examples/*` | RAG-примеры с OpenAI или локальной Ollama |

Запустить landing demos:

```bash
bun run dev:landing
```

Для API/admin stack используйте quick start ниже, затем откройте кабинет и
поставьте vertical/provider из UI.

---

## Архитектура

| App / package | Ответственность |
|---|---|
| `apps/api` | Hono HTTP server: auth, admin API, webhooks, web widget WS, hot reload, metrics |
| `apps/worker` | Outbound queue dispatcher, channel reload polling, cron |
| `apps/admin-ui` | React 19 + Vite cabinet: onboarding, channels, settings, catalog, leads, conversations, quality lab |
| `apps/landing` | Public demo/marketing site |
| `apps/vertical-*` | Vertical template packages, загружаются через `packages/verticals` |
| `packages/storage` | Drizzle schema, migrations, RLS helpers |
| `packages/channel-*` | Channel adapters за `ChannelAdapter` |
| `packages/llm-router` | Provider clients и per-tenant routing |
| `packages/kb` | RAG, ingest, reranking, tools, vision helpers |
| `packages/sales` | Styles, skills, stage classifier, coach/evaluation |
| `packages/conversation-engine` | Inbound pipeline, DAL, `withTenant`, reply dispatch |
| `packages/observability` | JSON logger и Prometheus metrics |

Граф зависимостей acyclic; приложения собирают конкретные адаптеры и routes,
а доменные пакеты не знают про UI/HTTP. Детали:
[ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Быстрый старт

Нужны [Bun](https://bun.sh) 1.3.14+ и Docker.

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install

cp .env.example .env
# Минимум:
#   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine
#   PLATFORM_MASTER_KEY=<openssl rand -hex 32>
#   TELEGRAM_WEBHOOK_SECRET=dev-tg-secret
#   ALLOW_PUBLIC_SIGNUP=1   # только для локалки

bun db:up
bun run apps/api/scripts/reset-and-migrate.ts

bun run dev          # apps/api -> http://localhost:3000
bun run dev:worker   # outbound worker
bun run dev:ui       # admin UI -> http://localhost:5173
```

После локального signup/reset flow дефолтный логин: `bob@demo.io` /
`test1234`. Публичный signup закрыт, пока не выставлен `ALLOW_PUBLIC_SIGNUP=1`.

Полезные команды:

```bash
bun db:up
bun db:down
bun db:reset
bun db:psql

bun run typecheck
bun run test
bun run check
```

---

## Инварианты

- **RLS обязателен.** Все production reads/writes tenant-таблиц идут через
  `withTenant(db, tenantId, fn)`. В проде DB role приложения должна быть
  `NOSUPERUSER NOBYPASSRLS`.
- **LLM не вызывается внутри долгой транзакции.** `processInbound` сначала
  persist'ит, отпускает DB connection, вызывает LLM/RAG, затем открывает вторую
  транзакцию для outbound enqueue.
- **Hot reload — часть продукта.** LLM configs, channels и tenant status
  применяются сразу в `apps/api`; worker подхватывает каналы polling'ом.
- **Secrets не попадают в audit.** LLM keys, channel tokens, userbot sessions,
  exchange requisites и provider credentials хранятся encrypted в
  `tenant_secrets`.

---

## Admin API

Authenticated endpoints под `/api/admin/*`:

- auth, invites, password reset
- onboarding status
- channel CRUD
- LLM provider configs
- KB documents
- conversations и operator takeover
- funnels, AI workflow builder, leads
- service catalog, provider marketplace, partners, partner deals
- exchange rates, requisites, orders
- notifications, outreach, templates
- billing, audit, diagnostics, quality lab, superadmin

Route factories и integration tests: [`apps/api/src/routes/`](apps/api/src/routes).

---

## Тесты

Тестам нужен Postgres на `5434`.

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

Suite покрывает RLS enforcement, multi-tenant route isolation, webhook flows,
channel adapters, RAG, exchange workflows, service catalog/provider marketplace,
quality lab и split-transaction pipeline. Подробнее:
[TESTING.md](docs/engineering/TESTING.md).

---

## Деплой

Ключевые env vars:

| Var | Описание |
|---|---|
| `DATABASE_URL` | Postgres connection string; app role в проде должна быть `NOSUPERUSER NOBYPASSRLS` |
| `PLATFORM_MASTER_KEY` | 32-byte hex key для AES-256-GCM secrets |
| `PLATFORM_PUBLIC_URL` | Public API URL для webhooks и snippets |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret-token header |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | Fallback-креды Meta WhatsApp webhook |
| `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET` | Fallback-креды Meta Messenger webhook |
| `MAX_WEBHOOK_SECRET` | Optional fallback для MAX webhook; per-channel secret предпочтительнее |
| `WEB_WS_AUTH_SECRET` | Optional shared secret для web widget |
| `KB_UPLOAD_DIR` / `KB_MAX_UPLOAD_BYTES` | Путь хранения оригиналов KB-файлов и лимит файла; в prod нужен persistent storage |
| `STRIPE_*` | Optional billing |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | Inbound tenant rate limits |

Миграции запускаются под owner/BYPASSRLS-ролью, apps — под restricted app role.
Полные референсы: [CONFIGURATION.md](docs/engineering/CONFIGURATION.md) и
[SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md).

---

## Позиционирование

| Capability | Lead Engine | Intercom Fin | Chatbase | ManyChat |
|---|:---:|:---:|:---:|:---:|
| Telegram bot + personal account | да | нет | нет | частично |
| WhatsApp / Messenger / VK / MAX / Web | да | частично | web | да |
| BYOK LLM на тенанта | да | нет | частично | нет |
| RAG + workflow stages | да | частично | только RAG | flow-builder |
| Operator takeover | да | да | нет | да |
| Service provider marketplace | да | нет | нет | нет |
| Self-host / source-available | да | нет | нет | нет |

Ниша: messenger-native AI operations для RU/CIS/MENA и service-heavy бизнесов.
Не "бот отвечает FAQ", а "мессенджерный диалог превращается в revenue workflow".

---

## Контрибьютинг и лицензия

Используйте [Conventional Commits](https://www.conventionalcommits.org/).
Перед отправкой кода:

```bash
bun run typecheck
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

**Лицензия:** продукт — [PolyForm Noncommercial 1.0.0](LICENSE). Коммерческое
использование требует платной лицензии от
[chatman-media](https://github.com/chatman-media). Reusable libraries в
`packages/*` остаются MIT. © Alexander Kireev / chatman-media.

<div align="center">

[🇬🇧 English](README.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md) &nbsp;·&nbsp; [⬆ наверх](#top)

</div>
