# lead-engine

**Multi-tenant SaaS platform для AI sales bots.** Принимает inbound через
Telegram / WhatsApp / Web, ведёт диалог через RAG + sales-engine, копит
metrics для admin-UI. Каждый клиент — независимый tenant с собственными
каналами, LLM-конфигом и data isolation на уровне Postgres RLS.

Извлечён из `chatman-media/sales-guru` (legacy Telegram-only bot) через
серию архитектурных PR'ов (см. CHANGELOG / git log).

---

## Архитектура

### Apps (deployable processes)

| App | Что это | Деплой |
|---|---|---|
| `apps/api` | HTTP-сервер: webhook handlers (telegram/whatsapp), `/ws/:slug` (web channel), admin-API, /metrics, /healthz | Fly app / любой Node-hosting |
| `apps/worker` | Long-running: outbound dispatcher (SKIP LOCKED очередь), cron jobs | Fly app process group |
| `apps/admin-ui` | React + Vite SPA (legacy, wire-up под новый admin-API отложен) | Static / CDN |
| `apps/vertical-recruitment-uae` | Vertical template (KB + funnel stages + style fragments). НЕ деплоится — грузится `packages/verticals` | — |

### Packages (доменные модули)

```
@chatman-media/storage          — Drizzle schema + миграции, integration helpers
@chatman-media/observability    — JsonLogger, Counter/Histogram, PlatformMetrics
@chatman-media/channel-core     — ChannelAdapter контракт, Inbound, OutboundEnvelope
@chatman-media/channel-telegram — BotAPI + MTProto userbot
@chatman-media/channel-whatsapp — Meta Graph API
@chatman-media/channel-web      — WebSocket-based chat-widget channel
@chatman-media/llm-router       — LLM I/O (chat/embed/providers/router). Single source of truth
@chatman-media/kb               — KB retrieval (RAG: ingest, answer, stores, hybrid search)
@chatman-media/sales            — sales-domain (CoachAnalyzer, StageClassifier, ELO, self-play, styles)
@chatman-media/conversation-engine — Pipeline contracts + DAL + persistence helpers
@chatman-media/verticals        — VerticalTemplate registry (recruitment_uae_v1)
```

**Dependency direction** (никаких циклов):
```
conversation-engine ── llm-router
                  ├── kb ── llm-router
                  ├── sales ── kb, llm-router, conversation-engine (для DAL типов)
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
# отредактировать .env — minimum: PLATFORM_MASTER_KEY (openssl rand -hex 32),
# TELEGRAM_WEBHOOK_SECRET (любая строка)

bun db:up          # docker compose up postgres (pgvector/pg17) на 5434
bun run apps/api/scripts/reset-and-migrate.ts   # apply 0000..0008 миграций

# Smoke onboard первого tenant'а (web-only — без telegram):
bun run apps/api/scripts/onboard-tenant.ts --slug=demo --with-web

# Запустить:
bun run dev        # apps/api на PORT 3000
bun run dev:worker # apps/worker (опционально, для outbound dispatching)
```

Web-channel smoke: открыть `apps/api/demo/web-chat.html` в браузере, host=localhost:3000, slug=demo, user=u1.

### Bun-shortcuts

```bash
bun db:up          # поднять Postgres-контейнер
bun db:down        # остановить
bun db:reset       # снести с volume + re-migrate (чистая БД)
bun db:psql        # psql shell в контейнере
bun run typecheck  # tsc по всем 14 пакетам
bun run test       # bun test по всему монорепо
```

---

## Multi-tenant модель

Каждый клиент — `tenant` row с уникальным `slug`. Все доменные данные
scoped по `tenant_id`:

```
tenants ─┬─ channels (telegram_bot / telegram_userbot / whatsapp / web)
         ├─ contacts (channel-agnostic person) ─ channel_identities (mapping per channel)
         ├─ conversations ─ messages
         ├─ leads, lead_events, lead_notes
         ├─ kb_documents ─ kb_chunks (per-tenant KB)
         ├─ styles, experiments, skills, ...
         ├─ outbound_queue
         ├─ tenant_secrets (зашифрованы AES-256-GCM)
         └─ llm_provider_configs
```

### RLS — Row-Level Security

**Миграция 0004** включает `FORCE ROW LEVEL SECURITY` на 34
tenant-scoped таблицах с policy:
```sql
USING (tenant_id = current_setting('app.tenant_id', true)::int)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int)
```

Все production code paths оборачивают repo-вызовы в `withTenant(db, tenantId, fn)`,
который открывает транзакцию + `SET LOCAL app.tenant_id = X`.

#### Critical для prod-deploy:

**apps/api / apps/worker ДОЛЖНЫ коннектиться под non-bypass Postgres role**
(NOSUPERUSER NOBYPASSRLS). Иначе RLS bypass'ится и tenant-isolation —
иллюзорна.

На boot apps/api + apps/worker логируют:
- `info` "RLS enforced" если current_user без bypass
- `warn` "RLS not enforced — connection role bypasses row-level security" +
  remediation hint иначе

Создать prod role:
```sql
CREATE ROLE lead_engine_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO lead_engine_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lead_engine_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lead_engine_app;
-- Миграции запускать отдельным BYPASSRLS role'м (owner / superuser)
```

Validated в `packages/storage/src/rls.integration.test.ts` (8 tests) и
`apps/api/src/multi-tenant.integration.test.ts` (10 E2E tests).

---

## Channels

| Channel | Inbound | Outbound | Где живёт adapter |
|---|---|---|---|
| `telegram_bot` | webhook `POST /webhook/telegram/:slug` (X-Telegram-Bot-Api-Secret-Token) | `apps/worker` через outbound-dispatcher → BotAPI HTTPS | apps/api + apps/worker |
| `telegram_userbot` | apps/worker MTProto receive loop | apps/worker через outbound-dispatcher → MTProto | apps/worker |
| `whatsapp` | webhook `POST /webhook/whatsapp/:slug` (X-Hub-Signature-256 HMAC-SHA256) + GET verify handshake | `apps/worker` через outbound-dispatcher → Meta Graph | apps/api + apps/worker |
| `web` | WebSocket `/ws/:slug?user=X&auth=Y` (apps/api) | apps/api in-process через `WebOutboundDispatcher` (pinned WS-connection) | apps/api ONLY |

**Web особенный**: pinned WebSocket-connection живёт в HTTP-сервере apps/api,
поэтому outbound dispatch для `kind='web'` rows тоже в apps/api (отдельный
mini-dispatcher). Worker'овский dispatcher фильтрует `claimKinds:
['telegram_bot', 'telegram_userbot', 'whatsapp']` чтобы не пытаться
претендовать на web-rows.

### Signature verification

- **Telegram**: `X-Telegram-Bot-Api-Secret-Token` = env `TELEGRAM_WEBHOOK_SECRET`
- **WhatsApp**: `X-Hub-Signature-256: sha256=<hex>` HMAC от raw body с
  `WHATSAPP_APP_SECRET` (Meta dashboard → App Settings → Basic). **Проверяется
  ДО tenant lookup** (anti-enumeration: 404 vs 401 раскрыло бы attacker'у
  какие slug'и существуют).
- **Web**: опциональный shared-secret через `WEB_WS_AUTH_SECRET` (`?auth=`
  в query). JWT-auth — следующая итерация когда admin-ui начнёт issue'ить
  tokens.
- **Stripe**: webhook signing secret в env `STRIPE_WEBHOOK_SECRET`.

---

## Onboarding нового tenant'а

```bash
# Только Telegram:
bun run apps/api/scripts/onboard-tenant.ts \
  --slug=studio-alpha \
  --bot-token=123456:ABC-DEF... \
  --vertical=recruitment_uae_v1

# Только Web:
bun run apps/api/scripts/onboard-tenant.ts --slug=acme --with-web

# Multi-channel:
bun run apps/api/scripts/onboard-tenant.ts \
  --slug=acme --bot-token=... --with-web
```

Скрипт:
1. INSERT в `tenants` с `slug`, `plan=free`, `status=active`, `llm_billing_mode=byok`
2. Для `--bot-token`: encrypt через AES-256-GCM (`PLATFORM_MASTER_KEY`) → `tenant_secrets` → channel row `telegram_bot`
3. Для `--with-web`: channel row `web` с `external_id = slug`
4. Опц. `--vertical=...`: создаёт funnel row с `vertical_template_id`

Webhook setup для Telegram:
```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<HOST>/webhook/telegram/<SLUG>&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

---

## Pipeline (inbound → outbound)

```
1. Webhook handler принимает HTTP POST  (apps/api)
2. Validate signature (Telegram/WhatsApp)
3. Lookup tenant + channel via ChannelRegistry
4. adapter.pushUpdate(payload) → adapter inbox
5. ┌─ Phase 1 (tx1, withTenant): persist inside Postgres ─────────┐
   │  - resolveContact (lookup or create Contact + ChannelIdentity) │
   │  - resolveConversation (lookup or create per channel)          │
   │  - persist Message (uniq dedup по external_message_id)         │
   │  - vertical-template extractFields hook                        │
   │  - stageClassifier (~300ms LLM) → applyClassifiedStage         │
   │  - memoryExtractor (~500ms LLM) → mergeAttributes              │
   └────────────────────────────────────────────────────────────────┘
6. Phase 2 (НЕ в tx): reply.generate(...) — ~1-2s LLM call. Pool connection
   освобождён на это время (split из PR #14).
7. Phase 3 (tx2, withTenant): enqueue OutboundEnvelope[] в outbound_queue.
8. Webhook возвращает 200 (быстро, < 100ms typical).
9. apps/worker (telegram/whatsapp/userbot) или apps/api (web) дренируют
   outbound_queue через SKIP LOCKED, шлют через adapter.send, mark sent/failed.
```

---

## Testing

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun test
```

**524 tests** в 59 файлах, включая:
- **Multi-tenant E2E** (`apps/api/src/multi-tenant.integration.test.ts`): 10 tests, валидируют tenant isolation через real webhook handler + admin API
- **RLS contract** (`packages/storage/src/rls.integration.test.ts`): 8 tests с non-bypass Postgres role
- **withTenant wiring** (`apps/worker/src/dispatcher.rls.integration.test.ts`, `apps/api/src/routes/admin.rls.integration.test.ts`): regression oracle'ы — если кто-то откатит withTenant, тест fail'нёт
- **Split processInbound invariant** (`packages/conversation-engine/src/dispatch-reply.test.ts`): events.indexOf("llm-call") < events.indexOf("tx-open")
- **WhatsApp signature gating** (7 tests): valid/invalid/missing/malformed sig, anti-enumeration

---

## Deployment notes

### Env vars (см. `.env.example`)

| Var | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string. **Должен быть под NOSUPERUSER NOBYPASSRLS role** в prod |
| `PLATFORM_MASTER_KEY` | ✅ | 32-byte hex для AES-256-GCM шифрования tenant_secrets |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ если Telegram | header X-Telegram-Bot-Api-Secret-Token |
| `WHATSAPP_VERIFY_TOKEN` | opt | Meta verify handshake |
| `WHATSAPP_APP_SECRET` | ⚠️ | Production обязан — иначе signature check выключен (warning в logs) |
| `WEB_WS_AUTH_SECRET` | opt | Shared secret для `/ws/:slug?auth=...` |
| `STRIPE_WEBHOOK_SECRET` | opt | Stripe webhook HMAC |
| `LLM_*`, `LLM_EMBED_*` | opt | LLM provider config (если null — pipeline persist'ит inbound, не отвечает) |
| `PLATFORM_BASE_DOMAIN` | opt | Активирует admin-API под subdomain (e.g. `acme.leadengine.app`) |

### Production checklist
- [ ] Postgres role с `NOSUPERUSER NOBYPASSRLS` (НЕ owner / НЕ superuser)
- [ ] Migrations run отдельным BYPASSRLS-role'м (owner/superuser)
- [ ] `WHATSAPP_APP_SECRET` set если WhatsApp channels active
- [ ] `WEB_WS_AUTH_SECRET` set если web channels active (или сделать JWT-auth)
- [ ] `PLATFORM_MASTER_KEY` ротировать через `rotate-master-key.ts` скрипт
- [ ] Boot log check: ожидаем "RLS enforced" в info; "RLS not enforced" warn = misconfigured

---

## Архитектурные решения

### Что отложено / не сделано (по решению)
- `apps/admin-ui` wire-up к новому admin-API — admin-ui 1251-строчный legacy
  под старый tg-chatbot backend (99 endpoints, ~24 страницы), современный
  admin-API exposes 8 endpoints. Migration требует major frontend rewrite —
  отложен до product-pressure.
- Stage classifier + memory extractor LLM ВНУТРИ tx — split #3 закрыл
  только большой reply.generate (1-2s). Stage/memory (~300-500ms каждый)
  пока inside tx — full 3-phase split возможен но сложен (нужно split
  runMemoryExtraction на read-existing-facts + LLM-extract + write).
- Rename колонок `user_id` → `contact_id` в conversations/leads/
  questionnaire_tokens — отложено (требует sync с admin-ui Drizzle типами).

### Что НЕ делаем сейчас (по плану)
- Реальная multi-region / sharding (один Postgres до ~50 tenant'ов хватит).
- Stripe billing — manually первые 3-5 клиентов.
- Custom domains для admin-ui (subdomain *.leadengine.app достаточно).
- Реальный WhatsApp business → opt-in (Meta dashboard вручную).
- Event-sourcing / CQRS (обычные CRUD + append-only messages).
- Per-tenant Postgres database — одна БД, `tenant_id` колонка.

---

## License

MIT
