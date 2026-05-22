# lead-engine

**AI Sales Closer для рекрутинговых агентств в Telegram.**
Multi-tenant SaaS платформа. Отвечает на входящие лиды за 30 секунд,
ведёт кандидата от "хочу узнать" до сданной анкеты, передаёт hot-lead'ы
рекрутеру. Использует sales-методики (SPIN, NEPQ, AIDA) — не FAQ-бот.

**Phase 1 ICP:** Рекрутинговые агентства в RU/CIS/MENA, Telegram-first,
ARPU $99–199/мес. [Phase 2: real estate. Phase 3: horizontal.]

**Как работает:** бизнес регается → подключает свой Telegram-бот
(auto-setWebhook за 60 сек) → конфигурит свой OpenAI / Anthropic ключ
(BYOK) → грузит документы в KB → AI отвечает и ведёт воронку.
Оператор перехватывает диалог в любой момент из inbox.

Каждый клиент — независимый `tenant` с собственными каналами, LLM-
конфигом, базой знаний, изоляцией данных на уровне Postgres RLS.

> Продукт технически универсален для любого клиентского бизнеса с
> мессенджер-воронкой. В Phase 1 фокус на recruitment для laser-precision
> go-to-market. Подробнее: [`docs/COMPETITORS.md §0`](docs/COMPETITORS.md).

Извлечён из `chatman-media/sales-guru` (legacy Telegram-only бот) через
серию архитектурных PR'ов (см. `docs/ROADMAP.md` и git log).

📖 **См. также:**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — детали data flow, RLS, hot-reload
- [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — путь нового tenant'а (UI + curl)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — что готово, что в работе, что дальше
- [`docs/COMPETITORS.md`](docs/COMPETITORS.md) — анализ конкурентов и позиционирование

---

## Self-service tenant flow

Полный цикл онбординга **без env vars, без рестартов**:

```
1. /signup       → email + password → JWT + tenant created (free plan)
2. /channels     → tab Telegram: paste @BotFather token → auto setWebhook + encrypt + reload
                   tab WhatsApp: paste { phoneNumberId, accessToken } → Meta Graph
                   validate → encrypt + webhook-setup-hint для Meta dashboard
                   ✓ Каналы принимают inbound сразу (Worker reload ≤30s)
3. /settings     → save OpenAI / Anthropic / Ollama key → encrypted AES-256-GCM,
                   InMemoryLlmRouter hot-reload → ✓ AI готов отвечать
4. /dashboard    → upload .txt / .md / .json → ingest + embed → kb_chunks
                   ✓ RAG-ответы по знаниям бизнеса
5. /conversations → inbox с auto-poll 5s. "Перехватить" → mode='human' →
                   AI замолкает на этом диалоге. "Вернуть AI" → обратно
6. /audit        → кто из админов что менял (всё PUT/POST/DELETE)
7. /diagnostics  → health check всего setup'а одной кнопкой
8. /dashboard    → PlanWidget: usage bars + "Upgrade Starter $49 / Pro $149"
                   → Stripe Checkout (14-day trial) → webhook поднимает план →
                   quota мгновенно увеличивается
```

**Quota по tier'ам** (см. `apps/api/src/lib/plans.ts`):

| Plan | Channels | KB docs | Rate/min | Цена |
|---|---|---|---|---|
| `free` | 1 | 50 | 30 | $0 |
| `starter` | 3 | 500 | 60 | $49/мес |
| `pro` | 10 | 10000 | 120 | $149/мес |
| `enterprise` | 100 | 100000 | 600 | custom (self-host) |

Превышение лимита на channel/KB POST → `402 Payment Required` со structured
response (`{ reason, limit, current, plan, upgradeHint }`) — UI показывает
"Upgrade" CTA.

Изменения применяются **live** через in-process bus (`apps/api`) +
30-сек polling reload (`apps/worker`). Подробности в
[`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md).

---

## Архитектура

### Apps (deployable processes)

| App | Что это | Деплой |
|---|---|---|
| `apps/api` | HTTP-сервер: webhook handlers (telegram/whatsapp/stripe), `/ws/:slug` (web), admin-API (auth + KB + LLM-config + channels + conversations + audit + diagnostics + tenant pause), `/metrics`, `/healthz` | Fly app / Node-hosting |
| `apps/worker` | Outbound dispatcher (`SKIP LOCKED` очередь), polling channel-reload, cron jobs | Fly app process group |
| `apps/admin-ui` | React 19 + Vite SPA — full SaaS UI (signup → channels → settings → conversations → audit → diagnostics) | Static / CDN |
| `apps/vertical-recruitment-uae` | Vertical template (KB seed + funnel stages + style prompts) — НЕ деплоится, грузится через `packages/verticals` | — |

### Packages (доменные модули)

```
@chatman-media/storage            — Drizzle schema + миграции, integration helpers
@chatman-media/observability      — JsonLogger, Counter/Histogram, PlatformMetrics
@chatman-media/channel-core       — ChannelAdapter контракт, Inbound, OutboundEnvelope
@chatman-media/channel-telegram   — BotAPI + MTProto userbot
@chatman-media/channel-whatsapp   — Meta Graph API
@chatman-media/channel-web        — WebSocket-based chat-widget channel
@chatman-media/llm-router         — LLM I/O (chat/embed/providers/router). Per-tenant config
@chatman-media/kb                 — RAG (ingest, answer, hybrid search, ABRouter)
@chatman-media/sales              — sales-domain (CoachAnalyzer, StageClassifier, ELO)
@chatman-media/conversation-engine — Pipeline contracts + DAL + persistence
@chatman-media/verticals          — VerticalTemplate registry (recruitment_uae_v1)
```

**Dependency direction** (без циклов):

```
conversation-engine ── llm-router
                  ├── kb ── llm-router
                  ├── sales ── kb, llm-router
                  └── storage
channel-* ── channel-core
apps/api ── conversation-engine, channel-*, sales, kb, llm-router
apps/worker ── conversation-engine, channel-telegram
```

---

## Quick start (local dev)

### Требования

- [Bun](https://bun.sh) 1.3.14+
- Docker (для Postgres с pgvector)

### Setup

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install

cp .env.example .env
# Minimum: PLATFORM_MASTER_KEY (openssl rand -hex 32),
#          TELEGRAM_WEBHOOK_SECRET (любая строка),
#          PLATFORM_PUBLIC_URL=http://localhost:3000 (для auto-setWebhook)

bun db:up                                                    # postgres@5434
bun run apps/api/scripts/reset-and-migrate.ts                # apply миграций

bun run dev          # apps/api на PORT 3000
bun run dev:worker   # apps/worker (outbound + reload polling)
cd apps/admin-ui && bun run dev   # admin-ui на http://localhost:5173
```

Открыть `http://localhost:5173/signup` → создать tenant → пройти 5-шаговый
onboarding checklist.

### Bun shortcuts

```bash
bun db:up          # поднять Postgres-контейнер
bun db:down        # остановить
bun db:reset       # снести + re-migrate (чистая БД)
bun db:psql        # psql shell в контейнере
bun run typecheck  # tsc по всем 15 пакетам
bun run test       # bun test по всему монорепо (700+ тестов)
```

---

## Multi-tenant модель

Каждый клиент — `tenant` row с уникальным `slug`. Все доменные данные
scoped по `tenant_id`:

```
tenants ─┬─ admins (multi-admin per tenant — invite flow TODO)
         ├─ channels (telegram_bot / telegram_userbot / whatsapp / web)
         ├─ contacts ─ channel_identities (channel-agnostic person ↔ messenger)
         ├─ conversations ─ messages
         ├─ leads ─ lead_events ─ lead_notes
         ├─ kb_documents ─ kb_chunks (per-tenant RAG)
         ├─ styles, experiments, skills, ...
         ├─ outbound_queue (SKIP LOCKED)
         ├─ tenant_secrets (AES-256-GCM encrypted)
         ├─ llm_provider_configs (per-purpose: chat | embed | vision | judge)
         └─ audit_log
```

### RLS — Row-Level Security

`FORCE ROW LEVEL SECURITY` на 34 tenant-scoped таблицах с policy:

```sql
USING (tenant_id = current_setting('app.tenant_id', true)::int)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int)
```

Все production code paths оборачивают repo-вызовы в `withTenant(db, tenantId, fn)`
— открывает транзакцию + `SET LOCAL app.tenant_id = X`.

**Production critical:** `apps/api` / `apps/worker` ДОЛЖНЫ коннектиться
под `NOSUPERUSER NOBYPASSRLS` Postgres role. Иначе RLS bypass'ится. На
boot оба процесса логируют `info "RLS enforced"` или
`warn "RLS not enforced"` с remediation hint.

Validated в `packages/storage/src/rls.integration.test.ts` (8 tests) и
`apps/api/src/multi-tenant.integration.test.ts` (10 E2E tests).

---

## Channels

| Channel | Inbound | Outbound | Где adapter |
|---|---|---|---|
| `telegram_bot` | webhook `POST /webhook/telegram/:slug` (X-Telegram-Bot-Api-Secret-Token) | `apps/worker` → BotAPI HTTPS | apps/api + apps/worker |
| `telegram_userbot` | `apps/worker` MTProto receive loop | `apps/worker` → MTProto | apps/worker |
| `whatsapp` | webhook `POST /webhook/whatsapp/:slug` (X-Hub-Signature-256) | `apps/worker` → Meta Graph | apps/api + apps/worker |
| `web` | WebSocket `/ws/:slug?user=X&auth=Y` | `apps/api` in-process через `WebOutboundDispatcher` (pinned WS) | apps/api only |

**Auto-setWebhook**: `POST /api/admin/channels/telegram` после insert
автоматически дёргает Telegram `setWebhook(url=<PLATFORM_PUBLIC_URL>/webhook/telegram/<slug>,
secret_token=<TELEGRAM_WEBHOOK_SECRET>)`. Канал работает сразу, без
ручной curl-команды.

### Signature verification

- **Telegram**: `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`
- **WhatsApp**: `X-Hub-Signature-256` HMAC-SHA256 от raw body с `WHATSAPP_APP_SECRET`. Проверяется **до** tenant lookup (anti-enumeration).
- **Web**: опциональный shared-secret через `WEB_WS_AUTH_SECRET`. JWT — следующая итерация.
- **Stripe**: HMAC-SHA256 с `STRIPE_WEBHOOK_SECRET`.

---

## Pipeline (inbound → outbound)

```
1. Webhook handler принимает HTTP POST                          (apps/api)
2. Validate signature → 401 если bad
3. Lookup tenant + channel via ChannelRegistry (in-memory)
4. Rate-limit check per tenant (60/min, 600/hour default) → 429 если over
5. adapter.pushUpdate(payload) → adapter inbox
6. ┌─ Phase 1 (tx1, withTenant): persist inside Postgres ──────┐
   │  - resolveContact (lookup or create Contact + ChannelIdentity)
   │  - resolveConversation (per channel)
   │  - persist Message (uniq dedup по external_message_id)
   │  - vertical-template extractFields hook
   │  - stageClassifier (~300ms LLM) → applyClassifiedStage
   │  - memoryExtractor (~500ms LLM) → mergeAttributes
   └────────────────────────────────────────────────────────────┘
7. Phase 2 (НЕ в tx): reply.generate(...) — ~1-2s LLM. Pool connection
   освобождён.
8. Phase 3 (tx2, withTenant): enqueue OutboundEnvelope[] в outbound_queue.
9. Webhook → 200 ack (< 100ms typical).
10. apps/worker (TG/WA/userbot) или apps/api (web) дренируют outbound_queue
    через SKIP LOCKED → adapter.send → mark sent.
```

---

## Hot-reload (без рестартов apps)

| Изменение | Effect | Latency |
|---|---|---|
| `PUT /api/admin/llm-configs/:purpose` | `InMemoryLlmRouter.invalidate(tenantId)` + setConfig + mutate `LoadedRef.current` | instant |
| `POST /api/admin/channels/telegram` | `ChannelRegistry.reloadTenant(tenantId)` в `apps/api` instant; `apps/worker` подхватит через polling | instant в api, ≤30s в worker |
| `POST /api/admin/channels/whatsapp` | то же, Meta webhook setup в Meta dashboard ручной | instant в api, ≤30s в worker |
| `PUT /api/admin/tenant/status` (pause/resume) | reloadChannels — evict при pause, restore при resume | instant в api |
| `PUT /api/admin/conversations/:id/mode` | mutate `conversations.mode`, pipeline сразу respect'ит | instant |
| Stripe webhook `customer.subscription.*` | `tenants.plan` mutates на основе priceId map | instant (после Stripe delivery) |
| KB upload | DrizzleKbStore читает live из БД | instant |

Подробности в [`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md).

---

## Admin API endpoints (SaaS-flow)

Все под `/api/admin/*`, требуют `Authorization: Bearer <jwt>` (`/api/auth/signup` или `/login`).

```
GET    /api/auth/me                              — admin + tenant info
POST   /api/auth/signup                          — создать tenant + admin
POST   /api/auth/login                           — выдать JWT
POST   /api/auth/logout                          — invalidate (client-side)

GET    /api/admin/onboarding-status              — checklist (channel/llm/kb)
GET    /api/admin/tenant                         — { id, slug, plan, status, ... }
PUT    /api/admin/tenant/status                  — { paused: boolean } → pause/resume
GET    /api/admin/diagnostics                    — health-check (channel + LLM + KB)

POST   /api/admin/channels/telegram              — { botToken } → auto-setWebhook
POST   /api/admin/channels/whatsapp              — { phoneNumberId, accessToken } → Meta Graph validate + webhook-setup-hint
GET    /api/admin/channels                       — list (без credentials)
DELETE /api/admin/channels/:id

PUT    /api/admin/llm-configs/:purpose           — { provider, model, apiKey?, ... }
GET    /api/admin/llm-configs                    — list (без secret values)
DELETE /api/admin/llm-configs/:purpose

POST   /api/admin/kb/documents                   — multipart file ИЛИ { title, body, topic? }
GET    /api/admin/kb/documents                   — list
DELETE /api/admin/kb/documents/:id

GET    /api/admin/conversations                  — paginated list (cursor)
GET    /api/admin/conversations/:id              — thread + messages
POST   /api/admin/conversations/:id/reply        — operator reply (mode=human)
PUT    /api/admin/conversations/:id/mode         — { mode: 'ai'|'human' } toggle takeover

GET    /api/admin/audit-log                      — cursor-paginated audit history

GET    /api/admin/billing/plan                   — current plan + usage + status
GET    /api/admin/billing/plans                  — list 4 tiers + stripeEnabled bool
POST   /api/admin/billing/checkout               — { plan: 'starter'|'pro' } → Stripe Checkout URL
POST   /api/admin/billing/portal                 — Stripe Customer Portal URL
```

---

## Testing

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

**741 tests** в 13 пакетах (apps/api: 305; kb: 156; sales: 116; conversation-engine: 59;
worker: 15; storage: 15; channel-whatsapp: 17; observability: 16; channel-telegram: 11;
channel-web: 11; llm-router: 9; verticals: 6; vertical-recruitment-uae: 5). Highlights:

- **Multi-tenant E2E** (`apps/api/src/multi-tenant.integration.test.ts`): tenant isolation через real webhook handler + admin API
- **RLS contract** (`packages/storage/src/rls.integration.test.ts`): non-bypass role validation
- **withTenant wiring** regression oracles в apps/api + apps/worker
- **Split processInbound invariant**: `events.indexOf("llm-call") < events.indexOf("tx-open")`
- **SaaS routes** (auth, KB, LLM-configs, channels, conversations, onboarding, audit, diagnostics, tenant-pause): ~250 integration tests
- **Rate-limiter**: 6 unit + 3 webhook integration tests
- **Hot-reload**: 6 tenant-reloader tests (LLM + channels)

---

## Deployment

### Env vars (см. `.env.example`)

| Var | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection. **NOSUPERUSER NOBYPASSRLS role в prod** |
| `PLATFORM_MASTER_KEY` | ✅ | 32-byte hex для AES-256-GCM (tenant_secrets) |
| `PLATFORM_AUTH_SECRET` | opt | HMAC секрет для JWT-like auth tokens (fallback на MASTER_KEY) |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | X-Telegram-Bot-Api-Secret-Token header |
| `PLATFORM_PUBLIC_URL` | opt | Базовый URL apps/api для auto-setWebhook (`https://api.example.com`) |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | opt | Meta webhook setup |
| `WEB_WS_AUTH_SECRET` | opt | Shared secret для `/ws/:slug?auth=...` |
| `STRIPE_SECRET_KEY` | opt | `sk_test_xxx` / `sk_live_xxx`. Пусто → `/checkout` и `/portal` вернут 503 |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | opt | Price IDs из Stripe dashboard. Webhook handler маппит priceId → plan |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` | opt | Redirect URLs (поддерживают `{TENANT}` placeholder) |
| `STRIPE_WEBHOOK_SECRET` | opt | Stripe webhook HMAC |
| `LLM_*` / `LLM_EMBED_*` | opt | Env fallback если у tenant'а нет DB config'а |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | opt | Default 60 / 600. `0` = disabled |
| `WORKER_CHANNEL_RELOAD_MS` | opt | Worker polling interval. Default 30000. `0` = disabled |

### Production checklist

- [ ] Postgres role `NOSUPERUSER NOBYPASSRLS` для apps (НЕ owner / НЕ superuser)
- [ ] Migrations run отдельным BYPASSRLS-role (owner / superuser)
- [ ] `WHATSAPP_APP_SECRET` set если WhatsApp активен
- [ ] `WEB_WS_AUTH_SECRET` set если web channels активны (или JWT-auth)
- [ ] `PLATFORM_MASTER_KEY` ротировать через `rotate-master-key.ts` скрипт
- [ ] `PLATFORM_PUBLIC_URL` set для auto-setWebhook UX (Telegram channel onboarding)
- [ ] `RATE_LIMIT_*` set (не оставлять disabled в prod — runaway-cost защита)
- [ ] Stripe: `STRIPE_SECRET_KEY` + `STRIPE_PRICE_STARTER` + `STRIPE_PRICE_PRO` +
      `STRIPE_WEBHOOK_SECRET` + success/cancel URLs. В Stripe dashboard
      зарегистрировать webhook на `<PLATFORM_PUBLIC_URL>/webhook/stripe`
- [ ] Boot log check: `"RLS enforced"` в info; `"RLS not enforced"` warn = misconfigured

---

## Roadmap & competitors

- **Что готово / в работе / дальше** — см. [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **Анализ рынка и позиционирование** — см. [`docs/COMPETITORS.md`](docs/COMPETITORS.md)

TL;DR продуктовая ниша: **AI-first customer service для мессенджер-
центричных рынков** (Telegram / WhatsApp). Конкуренты типа Intercom Fin
/ Sierra / Decagon — enterprise + web-chat-first. Chatbase / CustomGPT
— простые knowledge bots без operator-takeover и channels-as-a-service.
Наша позиция: open-architecture + BYOK + Telegram-first + полный
operator-workflow (inbox + reply + audit + диагностика).

---

## License

MIT
