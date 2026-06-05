<div align="center">

<a name="top"></a>

# Lead Engine

**Мультиканальный AI Sales Closer — Telegram · WhatsApp · Web-виджет**

[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![CodeQL](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/chatman-media/lead-engine/graph/badge.svg)](https://codecov.io/gh/chatman-media/lead-engine)
[![CodeRabbit](https://img.shields.io/coderabbit/prs/github/chatman-media/lead-engine?labelColor=171717&color=FF570A&label=CodeRabbit)](https://coderabbit.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![PostgreSQL + RLS](https://img.shields.io/badge/PostgreSQL-RLS%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20userbot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Stripe](https://img.shields.io/badge/Stripe-billing-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

Multi-tenant SaaS · BYOK LLM · per-tenant RAG · методологии продаж (SPIN / NEPQ / AIDA) · перехват оператором

🌐 [🇬🇧 English](README.md) &nbsp;·&nbsp; 🇷🇺 **Русский** &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>

---

**Multi-tenant SaaS**, который отвечает на входящие лиды за ~30 секунд в
Telegram, WhatsApp и web-виджете — ведёт человека от «просто интересно» до
заполненной анкеты / заявки и передаёт горячих лидов оператору. В основе —
методологии продаж (SPIN, NEPQ, AIDA), а не FAQ-бот.

Каждый клиент — изолированный `tenant` со своими каналами, конфигом LLM и
базой знаний; изоляция данных — на уровне **Postgres RLS**. **BYOK**:
используете собственный ключ OpenAI / Anthropic.

**ICP фазы 1:** рекрутинговые агентства (RU / СНГ / MENA, Telegram-first,
ARPU $99–199/мес). Сам движок вертикале-агностичен — есть шаблоны под разные
вертикали, `exchange` (обмен) уже live. *(Фаза 2: недвижимость · Фаза 3: горизонталь.)*

📖 **Docs:** [индекс](docs/README.md) · [Architecture](docs/engineering/ARCHITECTURE.md) · [Onboarding](docs/engineering/ONBOARDING.md) · [Exchange](docs/engineering/EXCHANGE.md) · [Configuration](docs/engineering/CONFIGURATION.md) · [Roadmap](docs/strategy/ROADMAP.md) · [Competitors](docs/strategy/COMPETITORS.md)

---

## Коротко о возможностях

| Каналы | AI-движок | Инструменты оператора |
|---|---|---|
| Telegram Bot + Userbot | RAG: pgvector + BM25 + RRF-fusion | Inbox + перехват диалога |
| WhatsApp Cloud API | Multi-query + MMR + reranking | Воронка лидов (Kanban) |
| Web-виджет (WebSocket) | BYOK LLM (OpenAI / Anthropic / Ollama) | Drag-and-drop конструктор воронки |
| Auto-setWebhook (60 сек) | SPIN / NEPQ / AIDA | A/B-эксперименты + ELO |
| Изоляция per-tenant (RLS) | OCR паспорта + vision по фото | Рассылки + шаблоны сообщений |
| Универсальный «костяк» фаз воронки | Hallucination guard + semantic cache | Superadmin-панель · инвайты · аудит |
| Шаблоны вертикалей (exchange live) | Per-purpose LLM-роутинг | Admin-копилот (page-aware, BYOK) |

---

## Онбординг и квоты

Self-service — **без env-переменных и рестартов**. Публичная регистрация
закрыта по умолчанию (`ALLOW_PUBLIC_SIGNUP=1`, чтобы открыть); первый админ —
`superadmin`. Доступ к кабинету гейтит обязательный vertical-aware мастер:

```
/onboarding → вертикаль → канал → LLM → (обмен: курсы → реквизиты) → KB → готово
```

Подключаете Telegram-бот (auto-`setWebhook` за 60 сек), WhatsApp или
web-виджет; сохраняете BYOK-ключ LLM (шифруется AES-256-GCM); грузите
документы в базу знаний. Каналы принимают входящие сразу, оператор может
перехватить любой диалог из inbox. Всё применяется **на лету** через
in-process bus + поллинг воркера ≤30 сек. Полный гайд:
[docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md).

**Квоты по тарифам** (`apps/api/src/lib/plans.ts`):

| Тариф | Каналы | KB-доки | Rate/мин | Цена |
|---|---|---|---|---|
| `free` | 100 | 100000 | 120 | $0 |
| `starter` | 3 | 500 | 60 | $99/мес |
| `pro` | 10 | 10000 | 120 | $199/мес |
| `enterprise` | 100 | 100000 | 600 | custom |

> В текущей exchange-/self-host-конфигурации `free` фактически **безлимитен**
> (SaaS-биллинга нет); `starter`/`pro` остаются в коде под Stripe-биллинг.
> Превышение лимита → `402` с `{ reason, limit, current, plan, upgradeHint }`.

---

## Архитектура

| Приложение | Что это |
|---|---|
| `apps/api` | HTTP-сервер: webhook-обработчики (telegram / whatsapp / stripe), `/ws/:slug` (web), весь admin API, `/metrics`, `/healthz` |
| `apps/worker` | Отправка исходящих (`SKIP LOCKED`-очередь), поллинг перезагрузки каналов, cron |
| `apps/admin-ui` | React 19 + Vite SPA (Tailwind v4 + shadcn/ui) — мастер онбординга, дашборд, каналы, диалоги, лиды, конструктор воронки, аудит, … |
| `apps/vertical-*` | Шаблоны вертикалей (`exchange` live + real-estate / recruitment / saas / video) — грузятся через `packages/verticals`, не деплоятся |

Доменная логика — в `packages/*` (публикуются в npm под `@chatman-media`):
`storage` (Drizzle-схема + миграции), `channel-{core,telegram,whatsapp,web}`,
`llm-router`, `kb` (RAG), `sales`, `conversation-engine`, `verticals`,
`observability`. Граф зависимостей и split-tx-пайплайн —
в [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Быстрый старт (локально)

Нужны [Bun](https://bun.sh) 1.3.14+ и Docker (Postgres + pgvector).

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine && bun install

cp .env.example .env
# Минимум: PLATFORM_MASTER_KEY (openssl rand -hex 32),
#          TELEGRAM_WEBHOOK_SECRET (любая строка),
#          PLATFORM_PUBLIC_URL=http://localhost:3000 (для auto-setWebhook)

bun db:up                                       # postgres @ 5434
bun run apps/api/scripts/reset-and-migrate.ts   # применить миграции

bun run dev          # apps/api  → PORT 3000
bun run dev:worker   # apps/worker (исходящие + поллинг)
cd apps/admin-ui && bun run dev   # admin-ui → http://localhost:5173
```

Для локалки поставьте `ALLOW_PUBLIC_SIGNUP=1`, откройте admin UI, создайте
tenant и пройдите мастер.

```bash
bun db:up / db:down / db:reset / db:psql   # хелперы Postgres-контейнера
bun run typecheck                          # tsc по всем пакетам
bun run test                               # bun test по монорепо
```

---

## Multi-tenant и безопасность

Каждый клиент — строка `tenant`; все доменные данные скоупятся по `tenant_id`.
На tenant-таблицы навешан `FORCE ROW LEVEL SECURITY`, а весь продакшен-код
оборачивает вызовы репо в `withTenant(db, tenantId, fn)` (выставляет
`app.tenant_id` на транзакцию). Секреты (ключи LLM, userbot-сессии) хранятся
в `tenant_secrets` зашифрованными AES-256-GCM.

> **Продакшен:** `apps/api` / `apps/worker` ОБЯЗАНЫ подключаться под ролью
> Postgres `NOSUPERUSER NOBYPASSRLS`, иначе RLS обходится. Оба логируют
> `"RLS enforced"` / `"RLS not enforced"` на старте. Миграции — под отдельной
> owner-ролью. Покрыто RLS- и multi-tenant-интеграционными тестами.

---

## Каналы и пайплайн

| Канал | Входящие | Исходящие |
|---|---|---|
| `telegram_bot` | webhook + secret-token заголовок | `apps/worker` → Bot API |
| `telegram_userbot` | MTProto receive-loop (apps/api) | in-process |
| `whatsapp` | webhook + `X-Hub-Signature-256` | `apps/worker` → Meta Graph |
| `web` | WebSocket `/ws/:slug` | in-process |

Входящее валидируется (подпись по каналу → rate-limit), сохраняется в tx1,
классифицируется и получает RAG-ответ, затем исходящее ставится в очередь в
tx2, а webhook отвечает за <100 мс; `apps/worker` разгребает `outbound_queue`
через `SKIP LOCKED`. Диаграмма и пошагово:
[docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Admin API

~120 REST-эндпоинтов под `/api/admin/*` (Bearer JWT из `/api/auth/login`):
auth и инвайты, статус онбординга, каналы, конфиги LLM, KB, диалоги, лиды +
конструктор воронки, стили, эксперименты, биллинг (Stripe), рассылки и
superadmin. Смотрите [`apps/api/src/routes/`](apps/api/src/routes); сквозной
tenant-flow — в [docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md).

---

## Тесты

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

950+ тестов по 15 пакетам — multi-tenant E2E через реальный webhook-обработчик,
контракт «не-обхода» RLS, RAG-пайплайн (~180), интеграционные тесты SaaS-роутов
и моки exchange-воркфлоу. Покрытие: `bun test --coverage`.
Подробнее: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

---

## Деплой

Ключевые env (полный референс в [docs/engineering/CONFIGURATION.md](docs/engineering/CONFIGURATION.md);
ops — в [docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md)):

| Переменная | Описание |
|---|---|
| `DATABASE_URL` ✅ | Postgres — **роль NOSUPERUSER NOBYPASSRLS в проде** |
| `PLATFORM_MASTER_KEY` ✅ | 32-байтный hex для AES-256-GCM (`tenant_secrets`) |
| `TELEGRAM_WEBHOOK_SECRET` ✅ | заголовок `X-Telegram-Bot-Api-Secret-Token` |
| `PLATFORM_PUBLIC_URL` | базовый URL apps/api для auto-`setWebhook` |
| `STRIPE_*` | secret-ключ + price-ID + webhook-секрет (пусто → биллинг выключен) |
| `RATE_LIMIT_PER_MIN` / `_PER_HOUR` | по умолчанию 60 / 600 (`0` = выкл — не в проде) |

Миграции запускайте под owner / BYPASSRLS-ролью, приложения — под
ограниченной. Полный чеклист прода: [docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md).

---

## Позиционирование

| | **Lead Engine** | Intercom Fin | Chatbase | Decagon |
|---|:---:|:---:|:---:|:---:|
| Нативный Telegram | ✅ | ❌ | ❌ | ❌ |
| WhatsApp / Web | ✅ | ✅ | web | web |
| BYOK LLM | ✅ | ❌ | частично | ❌ |
| Перехват оператором | ✅ | ✅ | ❌ | ✅ |
| Воронка лидов + конструктор | ✅ | ❌ | ❌ | ❌ |
| Self-host / open source | ✅ MIT | ❌ | ❌ | ❌ |

Ниша: AI-first клиентский сервис для messenger-центричных рынков (Telegram /
WhatsApp) с BYOK и полным workflow оператора. Полный разбор и роадмап:
[docs/strategy/COMPETITORS.md](docs/strategy/COMPETITORS.md) · [docs/strategy/ROADMAP.md](docs/strategy/ROADMAP.md).

---

## Контрибьютинг и лицензия

PR приветствуются. Используйте [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:` / `fix:` / …) — semantic-release выводит версии и публикует
`@chatman-media/*` в npm на push в `main`. Перед PR прогоните
`bun run typecheck && bun test` и прочитайте [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md)
перед правками `apps/api` или пакетов (контракты RLS / `withTenant` и split-tx —
критичные инварианты).

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

<div align="center">

[🇬🇧 English](README.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md) &nbsp;·&nbsp; [⬆ наверх](#top)

</div>
