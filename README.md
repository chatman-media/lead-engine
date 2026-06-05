<div align="center">

<a name="top"></a>

# Lead Engine

**Multichannel AI Sales Closer — Telegram · WhatsApp · Web Widget**

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

Multi-tenant SaaS · BYOK LLM · per-tenant RAG · sales methodologies (SPIN / NEPQ / AIDA) · operator takeover

---

🌐 **Language / Язык / 语言**

🇬🇧 **English** &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>

---

**Multichannel AI Sales Closer for recruitment agencies.**
A multi-tenant SaaS platform. Replies to inbound leads in 30 seconds
across Telegram, WhatsApp, and a web widget — walks a candidate from
"just curious" to a submitted application, and hands hot leads off to a
recruiter. Driven by sales methodologies (SPIN, NEPQ, AIDA) — not a FAQ bot.

**Phase 1 ICP:** recruitment agencies in RU/CIS/MENA, Telegram-first,
ARPU $99–199/mo. [Phase 2: real estate. Phase 3: horizontal.]

**How it works:** a business signs up → connects its own Telegram bot
(auto-`setWebhook` in 60s) → configures its own OpenAI / Anthropic key
(BYOK) → uploads documents into the KB → the AI replies and drives the
funnel. An operator can take over any conversation at any time from the
inbox.

Each customer is an independent `tenant` with its own channels, LLM
config, knowledge base, and data isolation enforced at the Postgres RLS
level.

> The product is technically universal for any customer-facing business
> with a messenger funnel. Phase 1 focuses on recruitment for a
> laser-precision go-to-market. More in [`docs/COMPETITORS.md §0`](docs/COMPETITORS.md).

Extracted from a legacy Telegram bot through a series of architectural
PRs (see `docs/ROADMAP.md` and the git log).

📖 **See also:**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — data flow, RLS, hot-reload details
- [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — a new tenant's path (UI + curl)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's done, in progress, and next
- [`docs/COMPETITORS.md`](docs/COMPETITORS.md) — competitor analysis and positioning

---

## Features at a glance

| Channels | AI Engine | Operator Tools |
|---|---|---|
| Telegram Bot | RAG: pgvector + BM25 + RRF fusion | Inbox + conversation takeover |
| Telegram Userbot | Multi-query expansion (parallel search) | Lead pipeline (Kanban) |
| WhatsApp Cloud API | MMR diversification + distance threshold | Drag-and-drop funnel builder |
| Web Widget (WebSocket) | Jina / Cohere cross-encoder reranking | A/B experiments + ELO ranking |
| Auto-setWebhook (60s) | BYOK LLM (OpenAI / Anthropic / Ollama) | Outreach broadcasts (bulk message) |
| Per-tenant RLS isolation | SPIN / NEPQ / AIDA methodologies | Message templates CRUD |
| — | Passport OCR + photo vision | Superadmin panel (tenant list + plan mgmt) |
| — | Hallucination guard + semantic cache | Forgot/reset password flow |
| — | Per-purpose LLM routing | Admin invite flow + roles |

> **Screenshot / GIF coming soon** — admin UI preview (inbox · lead pipeline · funnel builder)

---

## Self-service tenant flow

The full onboarding cycle — **no env vars, no restarts**:

```
1. /signup       → email + password → JWT + tenant created (free plan) →
                   redirect to /onboarding (guided wizard: channel → keys → KB → done)
2. /channels     → Telegram tab: paste @BotFather token → auto setWebhook + encrypt + reload
                   Personal tab: phone → code → 2FA (MTProto userbot, superadmin)
                   WhatsApp tab: paste { phoneNumberId, accessToken } → Meta Graph
                   validate → encrypt + webhook-setup hint for the Meta dashboard
                   ✓ Channels accept inbound immediately (Worker reload ≤30s)
3. /settings     → save OpenAI / Anthropic / Ollama key → encrypted AES-256-GCM,
                   InMemoryLlmRouter hot-reload → ✓ AI ready to answer
4. /dashboard    → upload .txt / .md / .json → ingest + embed → kb_chunks
                   ✓ RAG answers grounded in the business's knowledge
5. /conversations → inbox with auto-poll 5s. "Take over" → mode='human' →
                   AI goes silent on that conversation. "Return to AI" → back
6. /audit        → which admin changed what (every PUT/POST/DELETE)
7. /diagnostics  → health check of the whole setup with one button
8. /dashboard    → PlanWidget: usage bars + "Upgrade Starter $99 / Pro $199"
                   → Stripe Checkout (14-day trial) → webhook bumps the plan →
                   quota increases instantly
```

**Quota by tier** (see `apps/api/src/lib/plans.ts`):

| Plan | Channels | KB docs | Rate/min | Price |
|---|---|---|---|---|
| `free` | 1 | 50 | 30 | $0 |
| `starter` | 3 | 500 | 60 | $99/mo |
| `pro` | 10 | 10000 | 120 | $199/mo |
| `enterprise` | 100 | 100000 | 600 | custom (self-host) |

Exceeding a channel/KB POST limit → `402 Payment Required` with a structured
response (`{ reason, limit, current, plan, upgradeHint }`) — the UI shows an
"Upgrade" CTA.

Changes apply **live** through an in-process bus (`apps/api`) plus a
30-second polling reload (`apps/worker`). Details in
[`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md).

---

## Architecture

### Apps (deployable processes)

| App | What it is | Deploy |
|---|---|---|
| `apps/api` | HTTP server: webhook handlers (telegram/whatsapp/stripe), `/ws/:slug` (web), admin API (auth + KB + LLM config + channels + conversations + leads + funnel builder + skills + styles + experiments + audit + diagnostics + tenant pause), `/metrics`, `/healthz` | Fly app / Node hosting |
| `apps/worker` | Outbound dispatcher (`SKIP LOCKED` queue), polling channel-reload, cron jobs | Fly app process group |
| `apps/admin-ui` | React 19 + Vite SPA on **Tailwind v4 + shadcn/ui** (Linear theme, left sidebar, light/dark) — full SaaS UI: guided onboarding wizard + dashboard / channels / settings / conversations / leads / funnel builder / skills / styles / experiments / team / audit / diagnostics | Static / CDN |
| `apps/vertical-recruitment-uae` | Vertical template (KB seed + funnel stages + style prompts) — NOT deployed, loaded via `packages/verticals` | — |

### Packages (domain modules)

```
@chatman-media/storage             — Drizzle schema + migrations, integration helpers
@chatman-media/observability       — JsonLogger, Counter/Histogram, PlatformMetrics
@chatman-media/channel-core        — ChannelAdapter contract, Inbound, OutboundEnvelope
@chatman-media/channel-telegram    — BotAPI + MTProto userbot
@chatman-media/channel-whatsapp    — Meta Graph API
@chatman-media/channel-web         — WebSocket-based chat-widget channel
@chatman-media/llm-router          — LLM I/O (chat/embed/providers/router). Per-tenant config
@chatman-media/kb                  — RAG (ingest, answer, hybrid search, ABRouter, photo classification + passport OCR)
@chatman-media/sales               — sales domain (CoachAnalyzer, StageClassifier, ELO)
@chatman-media/conversation-engine — pipeline contracts + DAL + persistence
@chatman-media/verticals           — VerticalTemplate registry (recruitment_uae_v1)
```

All `packages/*` are published to npm under the `@chatman-media` scope. See
[Releasing packages](#releasing-packages).

**Dependency direction** (acyclic):

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

### Requirements

- [Bun](https://bun.sh) 1.3.14+
- Docker (for Postgres with pgvector)

### Setup

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install

cp .env.example .env
# Minimum: PLATFORM_MASTER_KEY (openssl rand -hex 32),
#          TELEGRAM_WEBHOOK_SECRET (any string),
#          PLATFORM_PUBLIC_URL=http://localhost:3000 (for auto-setWebhook)

bun db:up                                                    # postgres@5434
bun run apps/api/scripts/reset-and-migrate.ts                # apply migrations

bun run dev          # apps/api on PORT 3000
bun run dev:worker   # apps/worker (outbound + reload polling)
cd apps/admin-ui && bun run dev   # admin-ui on http://localhost:5173
```

Open `http://localhost:5173/signup` → create a tenant → guided onboarding
wizard (`/onboarding`): channel → API keys → knowledge base → done.

Server update / production runbook: [docs/SERVER_RUNBOOK.md](docs/SERVER_RUNBOOK.md).

### Bun shortcuts

```bash
bun db:up          # start the Postgres container
bun db:down        # stop it
bun db:reset       # drop + re-migrate (clean DB)
bun db:psql        # psql shell in the container
bun run typecheck  # tsc across all 15 packages
bun run test       # bun test across the whole monorepo (700+ tests)
```

---

## Multi-tenant model

Each customer is a `tenant` row with a unique `slug`. All domain data is
scoped by `tenant_id`:

```
tenants ─┬─ admins (multi-admin per tenant + invite flow) ─ admin_invites
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

`FORCE ROW LEVEL SECURITY` on 34 tenant-scoped tables with the policy:

```sql
USING (tenant_id = current_setting('app.tenant_id', true)::int)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int)
```

All production code paths wrap repo calls in `withTenant(db, tenantId, fn)`
— it opens a transaction and runs `SET LOCAL app.tenant_id = X`.

**Production critical:** `apps/api` / `apps/worker` MUST connect under a
`NOSUPERUSER NOBYPASSRLS` Postgres role. Otherwise RLS is bypassed. On
boot both processes log `info "RLS enforced"` or `warn "RLS not enforced"`
with a remediation hint.

Validated in `packages/storage/src/rls.integration.test.ts` (8 tests) and
`apps/api/src/multi-tenant.integration.test.ts` (10 E2E tests).

---

## Channels

| Channel | Inbound | Outbound | Adapter location |
|---|---|---|---|
| `telegram_bot` | webhook `POST /webhook/telegram/:slug` (X-Telegram-Bot-Api-Secret-Token) | `apps/worker` → BotAPI HTTPS | apps/api + apps/worker |
| `telegram_userbot` | `apps/api` MTProto receive loop (pinned connection) | `apps/api` in-process via `UserbotOutboundDispatcher` | apps/api only |
| `whatsapp` | webhook `POST /webhook/whatsapp/:slug` (X-Hub-Signature-256) | `apps/worker` → Meta Graph | apps/api + apps/worker |
| `web` | WebSocket `/ws/:slug?user=X&auth=Y` | `apps/api` in-process via `WebOutboundDispatcher` (pinned WS) | apps/api only |

**Auto-setWebhook**: after insert, `POST /api/admin/channels/telegram`
automatically calls Telegram `setWebhook(url=<PLATFORM_PUBLIC_URL>/webhook/telegram/<slug>,
secret_token=<TELEGRAM_WEBHOOK_SECRET>)`. The channel works immediately, with
no manual curl command.

### Signature verification

- **Telegram**: `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`
- **WhatsApp**: `X-Hub-Signature-256` HMAC-SHA256 of the raw body with `WHATSAPP_APP_SECRET`. Checked **before** tenant lookup (anti-enumeration).
- **Web**: optional shared secret via `WEB_WS_AUTH_SECRET`. JWT is the next iteration.
- **Stripe**: HMAC-SHA256 with `STRIPE_WEBHOOK_SECRET`.

---

## Pipeline (inbound → outbound)

```mermaid
flowchart LR
  W([Webhook]) --> S{Signature OK?}
  S -- ❌ --> E1([401])
  S -- ✅ --> R{Rate limit OK?}
  R -- ❌ --> E2([429])
  R -- ✅ --> TX1

  subgraph TX1 [tx1 — persist]
    C[resolveContact] --> CV[resolveConversation]
    CV --> M[persist Message]
    M --> SC[stageClassifier ~300ms]
    SC --> ME[memoryExtractor ~500ms]
  end

  TX1 --> LLM[RAG · reply.generate ~1-2s]
  LLM --> TX2[tx2 — enqueue outbound]
  TX2 --> ACK([200 ack < 100ms])

  TX2 --> W2[apps/worker]
  W2 --> Out1[Telegram Bot API]
  W2 --> Out2[WhatsApp Graph API]
  TX2 --> Out3[WebSocket / Userbot in-process]

  M -.->|async fire-forget| OCR[passport OCR · vision]
```

**Detailed steps:**

```
1. Webhook handler receives the HTTP POST                       (apps/api)
2. Validate signature → 401 if bad
3. Lookup tenant + channel via ChannelRegistry (in-memory)
4. Rate-limit check per tenant (60/min, 600/hour default) → 429 if over
5. adapter.pushUpdate(payload) → adapter inbox
6. ┌─ Phase 1 (tx1, withTenant): persist inside Postgres ──────┐
   │  - resolveContact (lookup or create Contact + ChannelIdentity)
   │  - resolveConversation (per channel)
   │  - persist Message (unique dedup by external_message_id)
   │  - vertical-template extractFields hook
   │  - stageClassifier (~300ms LLM) → applyClassifiedStage
   │  - memoryExtractor (~500ms LLM) → mergeAttributes
   └────────────────────────────────────────────────────────────┘
7. Phase 2 (NOT in tx): reply.generate(...) — ~1-2s LLM. Pool connection
   released.
8. Phase 3 (tx2, withTenant): enqueue OutboundEnvelope[] into outbound_queue.
9. Phase 4 (async, NOT in tx): if inbound has photo parts and tenant has a
   `vision` LLM configured → classifyPhoto() → if "passport" →
   extractPassportIdentity() → merge into contact.attributes_json.
   Fire-and-forget; never blocks the webhook response.
10. Webhook → 200 ack (< 100ms typical).
11. apps/worker (TG-bot / WA) or apps/api (web / TG userbot) drain
    outbound_queue via SKIP LOCKED → adapter.send → mark sent.
```


---

## Hot-reload (no app restarts)

| Change | Effect | Latency |
|---|---|---|
| `PUT /api/admin/llm-configs/:purpose` | `InMemoryLlmRouter.invalidate(tenantId)` + setConfig + mutate `LoadedRef.current` | instant |
| `POST /api/admin/channels/telegram` | `ChannelRegistry.reloadTenant(tenantId)` in `apps/api` instant; `apps/worker` picks it up via polling | instant in api, ≤30s in worker |
| `POST /api/admin/channels/whatsapp` | same; Meta webhook setup in the Meta dashboard is manual | instant in api, ≤30s in worker |
| `PUT /api/admin/tenant/status` (pause/resume) | reloadChannels — evict on pause, restore on resume | instant in api |
| `PUT /api/admin/conversations/:id/mode` | mutate `conversations.mode`, the pipeline respects it immediately | instant |
| Stripe webhook `customer.subscription.*` | `tenants.plan` mutates based on the priceId map | instant (after Stripe delivery) |
| KB upload | DrizzleKbStore reads live from the DB | instant |

Details in [`docs/ARCHITECTURE.md#hot-reload`](docs/ARCHITECTURE.md).

---

## Admin API endpoints (SaaS flow)

All under `/api/admin/*`, requiring `Authorization: Bearer <jwt>` (from `/api/auth/signup` or `/login`).

```
GET    /api/auth/me                              — admin + tenant info
POST   /api/auth/signup                          — create tenant + admin
POST   /api/auth/login                           — issue JWT
POST   /api/auth/logout                          — invalidate (client-side)
POST   /api/auth/forgot-password                 — send reset email (Resend)
POST   /api/auth/reset-password                  — consume token + set new password
POST   /api/auth/change-password                 — change password (authenticated)
POST   /api/auth/accept-invite                   — accept team invite token

GET    /api/admin/onboarding-status              — checklist (channel/llm/kb)
GET    /api/admin/tenant                         — { id, slug, plan, status, ... }
PUT    /api/admin/tenant/status                  — { paused: boolean } → pause/resume
GET    /api/admin/diagnostics                    — health check (channel + LLM + KB)

POST   /api/admin/channels/telegram              — { botToken } → auto-setWebhook
POST   /api/admin/channels/whatsapp              — { phoneNumberId, accessToken } → Meta Graph validate + webhook-setup hint
POST   /api/admin/channels/userbot/start         — { phone } → MTProto sendCode (superadmin)
POST   /api/admin/channels/userbot/verify        — { loginId, code } → signIn (or needs2fa)
POST   /api/admin/channels/userbot/2fa           — { loginId, password } → SRP → channel created
GET    /api/admin/channels                       — list (without credentials)
DELETE /api/admin/channels/:id

GET    /api/admin/admins                         — list admins
GET    /api/admin/admins/invites                 — list pending invites
POST   /api/admin/admins/invite                  — { email, role } → magic-link (superadmin)
DELETE /api/admin/admins/invites/:id             — revoke invite

PUT    /api/admin/llm-configs/:purpose           — { provider, model, apiKey?, ... }
GET    /api/admin/llm-configs                    — list (without secret values)
DELETE /api/admin/llm-configs/:purpose

POST   /api/admin/kb/documents                   — multipart file OR { title, body, topic? }
GET    /api/admin/kb/documents                   — list
DELETE /api/admin/kb/documents/:id

GET    /api/admin/conversations                  — paginated list (cursor)
GET    /api/admin/conversations/:id              — thread + messages
POST   /api/admin/conversations/:id/reply        — operator reply (mode=human)
PUT    /api/admin/conversations/:id/mode         — { mode: 'ai'|'human' } toggle takeover

GET    /api/admin/leads                          — list leads (kanban data, fill-rate stats)
POST   /api/admin/leads                          — create lead
GET    /api/admin/leads/:id                      — lead detail (stage, fields, events, notes, contact)
PATCH  /api/admin/leads/:id/stage               — move lead to a different stage
PUT    /api/admin/leads/:id/field-values         — bulk upsert stage field values
POST   /api/admin/leads/:id/notes               — add operator note

GET    /api/admin/funnel                         — funnel + stage_definitions + stage_fields
POST   /api/admin/funnel/seed                    — seed from template (visa/real_estate/modeling/recruitment)
POST   /api/admin/funnel/stages                  — create stage
PATCH  /api/admin/funnel/stages/:id              — update stage config (incl. supportMode)
DELETE /api/admin/funnel/stages/:id              — delete stage
PATCH  /api/admin/funnel/stages/reorder          — bulk position update
POST   /api/admin/funnel/stages/:id/fields       — add field to stage
PATCH  /api/admin/funnel/stages/:id/fields/:fid  — update field
DELETE /api/admin/funnel/stages/:id/fields/:fid  — delete field

GET    /api/admin/skills                         — list skills with ELO scores
GET    /api/admin/styles                         — list styles (versions, deletedAt filter)
GET    /api/admin/experiments                    — list A/B experiments

GET    /api/admin/audit-log                      — cursor-paginated audit history

GET    /api/admin/billing/plan                   — current plan + usage + status
GET    /api/admin/billing/plans                  — list 4 tiers + stripeEnabled bool
POST   /api/admin/billing/checkout               — { plan: 'starter'|'pro' } → Stripe Checkout URL
POST   /api/admin/billing/portal                 — Stripe Customer Portal URL

GET    /api/admin/message-templates              — list message templates
POST   /api/admin/message-templates              — create template { name, body }
PATCH  /api/admin/message-templates/:id          — update name and/or body
DELETE /api/admin/message-templates/:id          — delete template

POST   /api/admin/outreach                       — bulk message: { text, leadIds|stageSlug, scheduledAt? }

GET    /api/superadmin/tenants                   — list all tenants with stats (superadmin only)
PATCH  /api/superadmin/tenants/:id/plan          — change tenant plan (superadmin only)
```

---

## Testing

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

**950+ tests** across 15 packages. Highlights:

- **Multi-tenant E2E** (`apps/api/src/multi-tenant.integration.test.ts`): tenant isolation through the real webhook handler + admin API
- **RLS contract** (`packages/storage/src/rls.integration.test.ts`): non-bypass role validation
- **Auth integration** (`auth.integration.test.ts`): signup/login/me + forgot-password/reset-password + change-password (mock mailer)
- **Superadmin integration** (`superadmin.integration.test.ts`): tenant list + plan change, role guards (403 for manager)
- **Message templates** (`admin-message-templates.integration.test.ts`): CRUD + cross-tenant isolation
- **Outreach** (`admin-outreach.integration.test.ts`): by leadIds + by stageSlug, enqueued vs skipped, scheduledAt
- **RAG pipeline** (`packages/kb/test/`): 180 tests — MMR, RRF merge, dynamic threshold, multi-query expansion, reranker, semantic cache, topic classifier, rewrite-query, tool-loop, structured output
- **SaaS routes** (KB, LLM configs, channels, conversations, onboarding, audit, diagnostics, tenant pause): ~250 integration tests
- **Exchange e2e mocks**:
  - `apps/api/src/lib/exchange/tools.workflows.integration.test.ts` — 10 redacted exchange workflows over real DB/tools: quote, KYC gate, order, requisites, receipt proof, payout code
  - `apps/api/src/routes/admin-exchange.integration.test.ts` — admin rate-card approval, requisites, order CRM, operator patch, turnover and tenant isolation
- **Rate limiter**: 6 unit + 3 webhook integration tests
- **Hot-reload**: 6 tenant-reloader tests (LLM + channels)

Focused exchange check:

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun test apps/api/src/routes/admin-exchange.integration.test.ts \
           apps/api/src/lib/exchange/tools.workflows.integration.test.ts
```

Run with coverage:

```bash
bun test --coverage
```

---

## Releasing packages

The `@chatman-media/*` packages in `packages/*` are published to npm via
[semantic-release](https://semantic-release.gitbook.io/) on every push to
`main`. Versioning is independent per package and derived from
[Conventional Commits](https://www.conventionalcommits.org/) scoped to each
package's directory ([semantic-release-monorepo](https://github.com/pmowrer/semantic-release-monorepo)).

- A `feat:` commit touching `packages/kb` cuts a `minor` for `@chatman-media/kb`.
- A `fix:` cuts a `patch`; `feat!:` / `BREAKING CHANGE:` cuts a `major`.
- Each release tags `@chatman-media/<pkg>-vX.Y.Z`, updates the package
  `CHANGELOG.md`, publishes to npm, and creates a GitHub Release.
- Workspace (`workspace:*`) dependencies are resolved to concrete versions
  at publish time via `bun publish`.

CI publishes packages in dependency order so interdependent packages always
resolve. Requires an `NPM_TOKEN` repository secret with publish rights to the
`@chatman-media` scope.

---

## Deployment

### Env vars (see `.env.example`)

| Var | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection. **NOSUPERUSER NOBYPASSRLS role in prod** |
| `PLATFORM_MASTER_KEY` | ✅ | 32-byte hex for AES-256-GCM (tenant_secrets) |
| `PLATFORM_AUTH_SECRET` | opt | HMAC secret for JWT-like auth tokens (falls back to MASTER_KEY) |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | X-Telegram-Bot-Api-Secret-Token header |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | opt | MTProto app credentials (my.telegram.org). Required for userbot onboarding. Empty → Personal tab hidden, routes return 503 |
| `PLATFORM_PUBLIC_URL` | opt | Base URL of apps/api for auto-setWebhook (`https://api.example.com`) |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | opt | Meta webhook setup |
| `WEB_WS_AUTH_SECRET` | opt | Shared secret for `/ws/:slug?auth=...` |
| `STRIPE_SECRET_KEY` | opt | `sk_test_xxx` / `sk_live_xxx`. Empty → `/checkout` and `/portal` return 503 |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | opt | Price IDs from the Stripe dashboard. The webhook handler maps priceId → plan |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` | opt | Redirect URLs (support a `{TENANT}` placeholder) |
| `STRIPE_WEBHOOK_SECRET` | opt | Stripe webhook HMAC |
| `LLM_*` / `LLM_EMBED_*` | opt | Env fallback if a tenant has no DB config |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | opt | Default 60 / 600. `0` = disabled |
| `WORKER_CHANNEL_RELOAD_MS` | opt | Worker polling interval. Default 30000. `0` = disabled |

### Production checklist

- [ ] Postgres role `NOSUPERUSER NOBYPASSRLS` for the apps (NOT owner / NOT superuser)
- [ ] Migrations run under a separate BYPASSRLS role (owner / superuser)
- [ ] `WHATSAPP_APP_SECRET` set if WhatsApp is active
- [ ] `WEB_WS_AUTH_SECRET` set if web channels are active (or JWT auth)
- [ ] Rotate `PLATFORM_MASTER_KEY` via the `rotate-master-key.ts` script
- [ ] `PLATFORM_PUBLIC_URL` set for the auto-setWebhook UX (Telegram channel onboarding)
- [ ] `RATE_LIMIT_*` set (do not leave disabled in prod — runaway-cost protection)
- [ ] Stripe: `STRIPE_SECRET_KEY` + `STRIPE_PRICE_STARTER` + `STRIPE_PRICE_PRO` +
      `STRIPE_WEBHOOK_SECRET` + success/cancel URLs. In the Stripe dashboard,
      register a webhook on `<PLATFORM_PUBLIC_URL>/webhook/stripe`
- [ ] Boot log check: `"RLS enforced"` at info; `"RLS not enforced"` warn = misconfigured

---

## Positioning

| | **Lead Engine** | Intercom Fin | Chatbase | CustomGPT | Decagon |
|---|:---:|:---:|:---:|:---:|:---:|
| Telegram-native | ✅ | ❌ | ❌ | ❌ | ❌ |
| WhatsApp | ✅ | ✅ | ❌ | ❌ | ❌ |
| Web Widget | ✅ | ✅ | ✅ | ✅ | ✅ |
| BYOK LLM | ✅ | ❌ | partial | ❌ | ❌ |
| Operator takeover | ✅ | ✅ | ❌ | ❌ | ✅ |
| Lead pipeline (Kanban) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Funnel builder | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-tenant SaaS | ✅ | ✅ | ✅ | ✅ | ✅ |
| Self-host | ✅ enterprise | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ MIT | ❌ | ❌ | ❌ | ❌ |

Full competitive analysis: [`docs/COMPETITORS.md`](docs/COMPETITORS.md)

---

## Roadmap & competitors

- **Done / in progress / next** — see [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **Market analysis and positioning** — see [`docs/COMPETITORS.md`](docs/COMPETITORS.md)

TL;DR product niche: **AI-first customer service for messenger-centric
markets** (Telegram / WhatsApp). Competitors like Intercom Fin / Sierra /
Decagon are enterprise + web-chat-first. Chatbase / CustomGPT are simple
knowledge bots without operator takeover or channels-as-a-service. Our
position: open architecture + BYOK + Telegram-first + a full operator
workflow (inbox + reply + audit + diagnostics).

---

## Contributing

PRs are welcome. A few guidelines:

- **Branches**: `feat/<name>` for features, `fix/<name>` for bug fixes
- **Commits**: follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, etc. Semantic-release derives versions and changelogs from them
- **Before submitting**: run `bun run typecheck && bun test` across the monorepo. CI is the same check
- **Architecture context**: read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before touching `apps/api` or the packages — the RLS / withTenant contract and the split-tx pipeline are critical invariants
- **New packages**: add to `packages/`, export from `@chatman-media/<name>`, wire up `bun.lockb` + tsconfig paths

---

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

---

<div align="center">

🇬🇧 **English** &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>
