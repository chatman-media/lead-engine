# Architecture

Детальная архитектура `lead-engine`: процессы, data flow, изоляция,
hot-reload, secrets. Для high-level introduction — см.
[`../README.md`](../README.md).

---

## Topology

```
                     ┌─────────────────────────────────────┐
                     │           Customer (end-user)       │
                     │  Telegram / WhatsApp / Web widget   │
                     └─────────────────┬───────────────────┘
                                       │
                                       ▼
       ┌──────────────────────────────────────────────────────┐
       │  apps/api (HTTP server, Bun + Hono)                  │
       │  ┌────────────────────────────────────────────────┐  │
       │  │  /webhook/telegram/:slug      ←  Telegram       │  │
       │  │  /webhook/whatsapp/:slug      ←  Meta Cloud     │  │
       │  │  /ws/:slug?user=X             ←  Web widget     │  │
       │  │  /api/auth/*  /api/admin/*    ←  Admin UI       │  │
       │  └────────────────────────────────────────────────┘  │
       │  In-memory:                                          │
       │   - ChannelRegistry (adapter instances, hot-reload)  │
       │   - InMemoryLlmRouter (per-tenant configs)           │
       │   - LoadedRef (mutable snapshot)                     │
       │   - InboundRateLimiter (sliding window per tenant)   │
       │   - WebChannelRegistry (WS pinned connections)       │
       └────────────────┬────────────────────────┬────────────┘
                        │ (writes)               │ (in-process WS dispatch)
                        ▼                        ▼
       ┌──────────────────────────┐    ┌──────────────────────┐
       │   Postgres (pgvector)    │◄───┤ apps/worker          │
       │                          │    │  - OutboundDispatcher │
       │  tenants                 │    │    (SKIP LOCKED)      │
       │  channels                │    │  - Telegram BotAPI    │
       │  conversations, messages │    │    + MTProto userbot  │
       │  kb_documents, kb_chunks │    │  - WhatsApp send      │
       │  llm_provider_configs    │    │  - Periodic channel   │
       │  tenant_secrets (AES-256)│    │    reload (30s poll)  │
       │  outbound_queue          │    │  - Cron jobs          │
       │  audit_log               │    └──────────────────────┘
       │                          │
       │  RLS FORCE ON 34 tables  │
       └──────────────────────────┘
                        ▲
                        │ (psql / migrations as bypass-role)
                        │
       ┌──────────────────────────┐
       │  apps/admin-ui (React)   │
       │  signup / login          │
       │  /channels  /settings    │
       │  /leads  /funnel         │
       │  /skills  /styles        │
       │  /experiments            │
       │  /conversations  /audit  │
       │  /diagnostics            │
       └──────────────────────────┘
```

---

## Multi-tenant isolation

### Layer 1: `tenant_id` колонка

Каждая доменная таблица имеет `tenant_id` (FK на `tenants.id`, `ON DELETE
CASCADE`). Repo-методы из `packages/conversation-engine/src/dal/`
требуют `tenantId` в `RepoCtx`.

### Layer 2: `withTenant(db, tenantId, fn)`

Открывает Postgres transaction + `SET LOCAL app.tenant_id = $1`. Внутри
транзакции `current_setting('app.tenant_id')` равно `tenantId`.

### Layer 3: FORCE ROW LEVEL SECURITY

Миграция `0004_enable_rls.sql` включает RLS на 34 таблицах с policy:

```sql
CREATE POLICY tenant_isolation ON conversations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::int)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
```

`FORCE` важен — без него owner role пропускает policy.

### Layer 4: app connection role

`apps/api` + `apps/worker` коннектятся под **NOSUPERUSER NOBYPASSRLS**.
Если кто-то забыл и поднял app под owner-role — RLS не enforces (warning
на boot).

**Validated by** `packages/storage/src/rls.integration.test.ts` — тесты
создают role с `NOBYPASSRLS` и проверяют что вне `withTenant` запросы
видят 0 rows.

---

## Pipeline

### Inbound (Telegram example)

```
1. Telegram POST /webhook/telegram/<tenantSlug>
   Header X-Telegram-Bot-Api-Secret-Token

2. apps/api (webhook-telegram.ts):
   ├─ verify header == TELEGRAM_WEBHOOK_SECRET                → 401 если нет
   ├─ ChannelRegistry.getTelegramBotsByTenant(slug)           → 404 если empty
   ├─ rateLimiter.check(tenantId)                              → 429 если over
   ├─ parse update (TgUpdate)
   ├─ adapter.pushUpdate(update)
   └─ for await Inbound: processInbound(...)

3. processInbound (conversation-engine):
   ┌─ Phase 1: withTenant tx1 (persist) ─────────────────────┐
   │  - resolveContact (lookup или create + ChannelIdentity)  │
   │  - resolveConversation (per channel)                      │
   │  - persist Message (uniq dedup external_message_id)       │
   │  - vertical-template.extractFields() hook                 │
   │  - stageClassifier (~300ms LLM, BLOCKS tx) → set stage    │
   │  - memoryExtractor (~500ms LLM, BLOCKS tx) → merge attrs  │
   └──────────────────────────────────────────────────────────┘

   ┌─ Phase 2: NO tx ─────────────────────────────────────────┐
   │  - replyStrategy.generate() — ~1-2s LLM call              │
   │  - Pool connection FREE на это время (PR #14 split)       │
   └──────────────────────────────────────────────────────────┘

   ┌─ Phase 3: withTenant tx2 (enqueue) ──────────────────────┐
   │  - outbound_queue INSERT (status=pending, scheduled=now)  │
   │  - idempotencyKey предотвращает дубли                     │
   └──────────────────────────────────────────────────────────┘

   ┌─ Phase 4: async, NO tx (photo classification) ───────────┐
   │  Если inbound содержит photo-части И tenant настроил     │
   │  LLM purpose='vision':                                   │
   │  - adapter.downloadMedia(mediaRef) → bytes               │
   │  - classifyPhoto() → "passport"|"full_body"|"portrait"|  │
   │                        "other"                           │
   │  - Если "passport" → extractPassportIdentity() (OCR MRZ) │
   │    → family_name, given_name, passport_number, expiry     │
   │  - withTenant tx3: mergeAttributes в contact.attrs_json  │
   │  Fire-and-forget — НЕ блокирует webhook response.        │
   └──────────────────────────────────────────────────────────┘

4. apps/api → 200 OK (typical < 100ms если LLM skipped + < 2s с LLM).
```

### Outbound

```
1. apps/worker dispatcher poll'ит outbound_queue (1s default):
   SELECT id FROM outbound_queue
     WHERE status = 'pending' AND scheduled_at <= now()
     AND kind IN ('telegram_bot', 'whatsapp', 'telegram_userbot')
     ORDER BY scheduled_at
     FOR UPDATE SKIP LOCKED
     LIMIT $batchSize

2. WorkerChannelRegistry.byChannelId(channelId) → adapter

3. adapter.send(envelope) — Telegram BotAPI HTTPS POST или Meta Graph

4. On success: UPDATE outbound_queue SET status='sent', external_message_id=...

5. On failure: SET status='failed', last_error=..., attempt++ (retry policy TBD)
```

**Web canal** — особенный: pinned WebSocket-connection живёт в
`apps/api`, поэтому отдельный `WebOutboundDispatcher` (in-process) с
фильтром `kind='web'` крутится в api-процессе. Worker дисптачер
фильтрует `claimKinds: ['telegram_bot', 'telegram_userbot', 'whatsapp']`
чтобы не grab'ить web-rows которые он не может отправить.

---

## Hot-reload

Изменения через admin-UI применяются **live** без рестартов.

### apps/api in-process bus

`apps/api/src/lib/tenant-reloader.ts` экспортирует:

```ts
makeTenantReloader({ db, cfg, ref: LoadedRef, registry, log }) →
  { reloadLlm(tenantId), reloadChannels(tenantId) }
```

Routes вызывают callback после успешного PUT/POST/DELETE:

| Admin action | Hot-reload effect |
|---|---|
| `PUT /api/admin/llm-configs/:purpose` | `router.invalidate(tenantId)` + setConfig + mutate `LoadedRef.current.byTenant` |
| `DELETE /api/admin/llm-configs/:purpose` | то же — purpose удалён из snapshot'а |
| `POST /api/admin/channels/telegram` | `ChannelRegistry.reloadTenant(tenantId, slug)` — close old adapter, instantiate new |
| `DELETE /api/admin/channels/:id` | то же |
| `PUT /api/admin/tenant/status` | reloadChannels (evict при pause, restore при resume) |

**Edge case**: `makeReplyStrategy` решает RagReplyStrategy vs
LlmReplyStrategy один раз на boot (на основе initial `anyTenantHasEmbed`).
Если tenant добавляет embed config **после** boot — RAG не активируется
до restart. Acceptable trade-off (embed добавление редкое).

### apps/worker polling

Отдельный процесс — нет shared memory с api. Polling-based:

```ts
setInterval(async () => {
  const delta = await channels.reloadAll();   // close all + load all
  if (delta.before !== delta.after) {
    log.info('worker channels reloaded', delta);
  }
}, cfg.channelReloadIntervalMs);  // default 30s
```

30 секундный lag acceptable для onboarding. `pg_notify`-based sub-second
reload — отдельный PR когда понадобится.

---

## Secrets (AES-256-GCM)

`packages/conversation-engine/src/secrets.ts`:

```ts
encryptSecret(masterKeyHex: string, plaintext: string): string
  → returns base64(iv (12 bytes) || ciphertext || authTag (16 bytes))

decryptSecret(masterKeyHex: string, ciphertext: string): string
  → throws SecretCryptoError при auth tag mismatch

setEncryptedSecret({ db, tenantId, key, value, masterKeyHex, nowEpoch })
  → INSERT ... ON CONFLICT DO UPDATE в tenant_secrets

getDecryptedSecret({ db, tenantId, key, masterKeyHex })
  → SELECT + decrypt, returns null если row отсутствует
```

`PLATFORM_MASTER_KEY` — 32 байта (64 hex chars). Ротация — отдельный
скрипт `apps/api/scripts/rotate-master-key.ts` (re-encrypts всё под
новый ключ + atomic swap).

**Что лежит зашифрованным** в `tenant_secrets`:

- `channel_telegram_bot_<username>` — Telegram bot token
- `channel_userbot_<phone>` — MTProto session string (TBD)
- `channel_whatsapp_<phone_id>` — WhatsApp access token (TBD UI)
- `llm_chat_apikey` — OpenAI/Anthropic chat key
- `llm_embed_apikey` — embedding API key
- `llm_vision_apikey` — vision LLM key (используется photo-processor'ом для классификации фото и OCR паспортов)
- `llm_judge_apikey` — judge LLM key (используется для ELO-grading skills)

---

## Per-tenant LLM routing

```
LoadedRef {
  current: LoadedLlmConfigs {                  ← mutable, mutated by reloader
    byTenant: Map<tenantId, Map<purpose, ResolvedLlmConfig>>
    anyTenantHasChat: boolean
    anyTenantHasEmbed: boolean
  }
  router: InMemoryLlmRouter                     ← shared instance
}
```

`InMemoryLlmRouter` (из `packages/llm-router`) — `setConfig({ tenantId,
purpose, provider, model, apiKey, ... })`. На `resolveChat(tenantId,
purpose)` → cached `ChatClient` (OpenAI / Anthropic / Ollama).

`router.invalidate(tenantId)` сбрасывает все cached clients этого
tenant'а — следующий resolve пересоберёт с новым config'ом.

`llm-config-loader.loadTenantLlmConfigs()` на boot читает все
`llm_provider_configs` + decrypts apiKeys, fall back'ит на env vars
если у tenant'а нет DB row'а.

---

## Plan tiers + quota

`apps/api/src/lib/plans.ts` — source-of-truth:

| Plan | maxChannels | maxKbDocuments | rateLimitPerMinute | priceUsd |
|---|---|---|---|---|
| `free` | 1 | 50 | 30 | 0 |
| `starter` | 3 | 500 | 60 | 49 |
| `pro` | 10 | 10000 | 120 | 149 |
| `enterprise` | 100 | 100000 | 600 | null (custom / self-host) |

`resolvePlan(planStr)` маппит `tenants.plan` строку в `PlanLimits`.
Unknown plan → fallback на `free` с warning hook.

**Quota enforcement** — `apps/api/src/lib/quota.ts`:

- `canAddChannel({ db, tenantId })` — вызывается в `POST /api/admin/channels/telegram`
  и `/whatsapp` **только** на new-channel path. Token rotation для существующего
  channel bypass'ит quota.
- `canAddKbDocument({ db, tenantId })` — вызывается в `POST /api/admin/kb/documents`.
  Dedup по `content_hash` работает orthogonally — same-content re-upload не
  увеличивает count.

Превышение → `402 Payment Required` со structured response:

```json
{
  "error": "quota_exceeded",
  "reason": "max_channels",
  "limit": 1,
  "current": 1,
  "plan": "free",
  "planLabel": "Free",
  "upgradeHint": "Перейдите на план Starter ($49/мес) для большего числа каналов"
}
```

---

## Stripe billing

`apps/api/src/lib/stripe-api.ts` — минимальный REST-wrapper над Stripe API
(без `stripe-node` dependency). Покрывает три use-case'а:

- `createCustomer({ email, tenantId, tenantSlug })` — POST `/v1/customers`
  с `metadata.tenant_id` для idempotency lookup.
- `createCheckoutSession({ customerId, priceId, tenantId, successUrl,
  cancelUrl, trialDays })` — subscription mode + `client_reference_id=tenantId`
  для webhook resolve.
- `createBillingPortalSession({ customerId, returnUrl })` — Customer
  Portal session для self-service cancel / change card.

**Endpoint flow (M1b):**

```
POST /api/admin/billing/checkout { plan: 'starter' | 'pro' }
  ↓
  1. Lookup admin.email + tenant.slug
  2. Lookup или create stripe_customers row (idempotent)
  3. createCheckoutSession (14-day trial)
  4. recordAudit billing.checkout_started
  5. Return { url, sessionId }
  ↓
client redirect → window.location.href = res.url
  ↓
Tenant платит на Stripe Checkout
  ↓
Stripe POST /webhook/stripe (HMAC-SHA256 verify)
  ↓
  customer.subscription.created/updated:
    - INSERT/UPDATE stripe_subscriptions
    - priceMap[priceId] → newPlan ('starter' | 'pro')
    - status='active'|'trialing' → tenants.plan = newPlan
  customer.subscription.deleted:
    - tenants.plan = 'free'
  ↓
Next /api/admin/channels POST → canAddChannel reads fresh tenants.plan →
quota lifted instantly без рестарта.
```

`priceToPlan` map передаётся в `makeStripeWebhookRoutes` на boot из env
(`STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`). Unknown priceId → warning,
`tenants.plan` не меняется.

Идемпотентность: `stripeWebhookEvents.stripe_event_id` уникальный, дубли
events возвращают `{ ok: true, deduped: true }`.

---

## Audit log

`apps/api/src/lib/audit.ts`:

```ts
recordAudit(db, {
  tenantId, adminId,
  action: 'channel.create',     // taxonomy: {entity}.{verb}
  targetKind: 'channel',
  targetId: 42,
  details: { kind: 'telegram_bot', username: '...' },  // НЕТ secret value!
});
```

Fail-quiet: ошибка audit'а не валит request. Записи живут вечно (нет TTL
сейчас — добавится когда `audit_log` row count станет проблемой).

Чтение — `GET /api/admin/audit-log?limit=N&cursor=<epoch>` (cursor по
`createdAt DESC`). UI рендерит JSON details collapsibly.

**Текущая taxonomy actions:**

```
auth.signup                       — tenant + admin создан
llm_config.create / update / delete
channel.create / update / delete  — kind='telegram_bot' | 'whatsapp'
conversation.reply                — operator отправил message с role='human'
conversation.mode.takeover        — mode 'ai' → 'human'
conversation.mode.return_to_ai    — mode 'human' → 'ai'
tenant.pause                      — tenant.status 'active' → 'suspended'
tenant.resume                     — tenant.status 'suspended' → 'active'
billing.checkout_started          — POST /checkout, details: { plan, priceId, customerId }
```

Raw secrets / tokens / apiKey НИКОГДА не попадают в `details` — verified
в integration-тестах через `expect(JSON.stringify(details)).not.toContain(rawToken)`.

---

## Rate limiting

`apps/api/src/lib/rate-limiter.ts` — `InboundRateLimiter` с sliding-window
counter per `tenantId`. Windows: 60s + 3600s.

```ts
const decision = limiter.check(tenantId);
if (!decision.allowed) {
  c.header('Retry-After', String(decision.retryAfterSec));
  return c.json({
    error: 'rate_limit_exceeded',
    reason: decision.reason,            // 'per_minute' | 'per_hour'
    retryAfterSec: decision.retryAfterSec,
  }, 429);
}
```

In-process (single instance). Restart сбрасывает state — acceptable
(attacker за restart-окно не успевает накопить полный hour-bucket).
Cross-process — Redis (TODO).

Defaults: 60 msg/min, 600 msg/hour per tenant. Configurable через env.

---

## Database migrations

`packages/storage/migrations/`:

```
0000_init_full_schema.sql          — Drizzle generated baseline
0001_multi_tenant.sql              — tenants, tenant_secrets, channels, ...
0002_tenant_id_existing_tables.sql — add tenant_id to legacy 28 tables
0003_backfill_users_to_contacts.sql— users → contacts data migration
0004_enable_rls.sql                — FORCE ROW LEVEL SECURITY
0005_outbound_processing_status.sql— status enum + processing intent
0006_stripe_billing.sql            — stripe_customers, stripe_subscriptions
0007_conversations_to_contacts_fk.sql — FK swap users → contacts
0008_drop_users.sql                — drop legacy users table
```

Migrations run раздельно от app process под superuser/owner role. Apps
запускаются под `NOSUPERUSER NOBYPASSRLS`.

---

## Observability

`@chatman-media/observability`:

- **`PlatformMetrics`** — Counter / Histogram registry. Prometheus
  exposition через `GET /metrics` (apps/api) + `:9100/metrics` (apps/worker
  если `METRICS_PORT` задан).
- **`JsonLogger`** — структурированные JSON logs (`info` / `warn` / `error`)
  с `app`, `ts`, `event`, `tenantId` контекстом.
- **`makeMetricsSink`** — emits pipeline events (`inbound_received`,
  `inbound_persisted`, `inbound_deduped`, `reply_generated`,
  `outbound_enqueued`, `outbound_sent`) с tenantId label'ом.

Key metrics:

```
lead_engine_webhook_requests_total{channel, status}   — webhook hit count
lead_engine_webhook_latency_seconds{channel}          — handler duration
lead_engine_inbound_received_total{tenant, channel}   — pipeline ingress
lead_engine_inbound_deduped_total{tenant}             — duplicate detection
lead_engine_reply_generated_total{tenant, kind}       — RAG vs LLM-only
lead_engine_outbound_sent_total{tenant, channel}      — успешные send'ы
lead_engine_outbound_failed_total{tenant, channel, kind} — failures по kind
lead_engine_llm_calls_total{provider, purpose}        — token-cost proxy
lead_engine_llm_errors_total{provider, purpose, kind} — error rates
```

---

## Where things live

| Concept | File |
|---|---|
| Auth (JWT-like HMAC-SHA256 tokens) | `apps/api/src/lib/auth.ts` |
| Require-auth middleware | `apps/api/src/middleware/require-auth.ts` |
| Channel registry (api) | `apps/api/src/channel-registry.ts` |
| Channel registry (worker) | `apps/worker/src/channel-registry.ts` |
| LLM bootstrap (factories) | `apps/api/src/llm-bootstrap.ts` |
| LLM config loader | `apps/api/src/lib/llm-config-loader.ts` |
| Tenant reloader (hot-reload bus) | `apps/api/src/lib/tenant-reloader.ts` |
| Audit helper | `apps/api/src/lib/audit.ts` |
| Photo classifier + passport OCR | `apps/api/src/lib/photo-processor.ts` |
| Rate limiter | `apps/api/src/lib/rate-limiter.ts` |
| Plan tiers (PlanLimits) | `apps/api/src/lib/plans.ts` |
| Quota helpers | `apps/api/src/lib/quota.ts` |
| Stripe API wrapper | `apps/api/src/lib/stripe-api.ts` |
| Stripe signature verification | `apps/api/src/lib/stripe-signature.ts` |
| Secrets (AES-256-GCM) | `packages/conversation-engine/src/secrets.ts` |
| withTenant wrapper | `packages/conversation-engine/src/with-tenant.ts` |
| RLS check | `packages/conversation-engine/src/rls-check.ts` |
| Pipeline (processInbound) | `packages/conversation-engine/src/process-inbound.ts` |
| Reply strategies | `packages/conversation-engine/src/{llm,rag}-reply-strategy.ts` |
| RAG core | `packages/kb/src/answer.ts` + `hybrid-search.ts` |
| Drizzle schema | `packages/storage/src/schema.ts` |

---

## Universal lead pipeline

Стадии лида хранятся в БД (`stage_definitions` / `stage_fields`) и
настраиваются из admin-UI без деплоя. Каждый тенант создаёт свою воронку
с произвольным набором стадий.

### Ключевые таблицы

| Таблица | Назначение |
|---|---|
| `stage_definitions` | Стадии воронки: slug, тип (`form_fill`, `document_upload`, `external_approval`, `payment`, `waiting`, `interaction`, `assessment`, `milestone`), позиция, timeout |
| `stage_fields` | Поля данных на стадии: тип (`text`, `number`, `date`, `select`, `multiselect`, `boolean`, `phone`, `email`, `file`, `photo`), `required`, `ai_extractable` |
| `lead_field_values` | Значения полей для конкретного лида (upsert по `(lead_id, field_id)`) |
| `leads` | Лид с `stage_definition_id` FK; `state` text-колонка сохранена для backward compatibility с вертикалью recruitment-UAE |

### Типы стадий

| Тип | Что происходит |
|---|---|
| `form_fill` | Бот/оператор собирает данные через `stage_fields` |
| `document_upload` | Кандидат присылает файлы |
| `document_signature` | Подписание договора |
| `external_approval` | Ждём решения третьей стороны (webhook) |
| `payment` | Оплата |
| `waiting` | Ждём по таймауту |
| `interaction` | Встреча/звонок/просмотр |
| `assessment` | Оценка/квалификация |
| `milestone` | Контрольная точка |

### Photo + passport fields

Поля с `fieldType='photo'` и `aiExtractable=true` предназначены для
автоматического заполнения через vision-pipeline (Phase 4 в pipeline выше).
Когда кандидат присылает фото паспорта — `classifyPhoto()` + `extractPassportIdentity()`
OCR'ят MRZ и заполняют `contact.attributes_json` с ключами
`passport_family_name`, `passport_given_name`, `passport_number`, `passport_expiry`.

**Активация**: добавить LLM config с `purpose='vision'` (openai или openrouter,
любая vision-capable модель — `gpt-4o`, `google/gemini-2.5-flash`).

---

## What's deliberately NOT done

- **Per-tenant Postgres** — одна БД, `tenant_id` колонка. До ~100 tenant'ов
  одной инстанции pgvector хватит. Sharding — когда понадобится.
- **Event sourcing / CQRS** — append-only `messages` + обычные CRUD'ы
  достаточно. Lossless audit через `audit_log`.
- **Custom domains per tenant** — subdomain `*.leadengine.app` достаточно.
- **Real-time WS feed для conversations** — 5s auto-poll проще, latency
  acceptable для operator inbox.
- **Multi-region / globally distributed** — single PG instance до 50+
  tenants. Region-pinned deployment когда GDPR требует.

См. `docs/ROADMAP.md` — что отложено намеренно vs что в очереди.
