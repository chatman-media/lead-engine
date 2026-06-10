<div align="center">

<a name="top"></a>

# Lead Engine

**AI front office for messenger-first businesses**

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

Telegram Bot + Userbot · WhatsApp · Facebook Messenger · VK · MAX · Web Widget · BYOK LLM · RAG · operator handoff · provider marketplace

**🟢 Live: [exchanges.agency](https://exchanges.agency)** &nbsp;·&nbsp; [admin](https://client.exchanges.agency) &nbsp;·&nbsp; [dev](https://dev.exchanges.agency)

🌐 🇬🇧 **English** &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>

---

Lead Engine is a **multi-tenant AI operations platform** for businesses that
close and fulfill work in messengers: Telegram, WhatsApp, Messenger, VK, MAX,
and a web widget. It is not a FAQ bot. It turns a messy inbound chat into
structured requests, lead stages, knowledge-grounded replies, operator
decisions, partner handoffs, and audit trails.

The current product has two marketplaces:

- **AI provider routing** — per-tenant BYOK configs for `chat`, `embed`,
  `vision`, `judge`, `reranker`, and `transcribe` purposes.
- **Service provider marketplace** — curated and custom providers that can be
  installed into the tenant's service catalog, then routed to funnels, partner
  services, webhooks, or manual operators.

Every tenant has isolated channels, LLM configs, knowledge base, funnels,
service catalog, partner ledger, and encrypted secrets. Isolation is enforced
with **Postgres Row-Level Security**, not only application filters.

📖 **Docs:** [index](docs/README.md) · [Architecture](docs/engineering/ARCHITECTURE.md) · [Onboarding](docs/engineering/ONBOARDING.md) · [Service catalog](docs/engineering/SERVICE_CATALOG.md) · [Exchange](docs/engineering/EXCHANGE.md) · [Configuration](docs/engineering/CONFIGURATION.md) · [Roadmap](docs/strategy/ROADMAP.md)

---

## What Ships

| Layer | What is live |
|---|---|
| Messenger channels | Telegram bot, Telegram userbot (MTProto), WhatsApp Cloud API, Facebook Messenger, VK community messages, MAX Bot API, WebSocket web widget |
| AI routing | Per-tenant provider configs, encrypted BYOK keys, hot reload in API, separate purposes for chat / embeddings / vision / judge / reranker / voice transcription |
| Retrieval | Hybrid RAG with pgvector, BM25, RRF, multi-query expansion, dynamic trimming, MMR, Jina/Cohere reranker, hallucination guard |
| Workflows | Universal funnel backbone, AI funnel builder, drag-drop stages/fields, multi-request concierge flows, exchange rates/orders, operator-awaiting stages |
| Service marketplace | Curated Phuket providers, custom providers, service catalog routes, partner services, partner deals, commission tracking, handoff modes |
| Operator UI | Inbox, AI/human takeover, leads board, service catalog, partners, notifications, outreach, templates, audit log, diagnostics, admin copilot |
| Security | Tenant RLS, AES-256-GCM secrets, webhook signature checks, rate limiting, audit records without raw secrets |

---

## Product Shape

### Messenger layer

| Kind | Inbound | Outbound | Notes |
|---|---|---|---|
| `telegram_bot` | Bot API webhook + `X-Telegram-Bot-Api-Secret-Token` | worker -> Bot API | Auto-`setWebhook` when `PLATFORM_PUBLIC_URL` is set |
| `telegram_userbot` | MTProto receive loop in `apps/api` | in-process userbot dispatcher | Per-tenant `api_id` / `api_hash`, fallback env supported |
| `whatsapp` | Meta webhook + `X-Hub-Signature-256` | worker -> Meta Graph | Per-tenant access token, verify token, app secret |
| `facebook` | Messenger webhook + `X-Hub-Signature-256` | worker -> Messenger Send API | Page Access Token, 24h response window rules apply |
| `vk` | VK Callback API | worker -> VK `messages.send` | Community messages, text-first MVP |
| `max` | MAX Bot API webhook + `X-Max-Bot-Api-Secret` | worker -> MAX `POST /messages` | Per-channel bot token and webhook secret; text-first MVP |
| `web` | WebSocket `/ws/:slug` | in-process web dispatcher | Embed script + standalone demo client |

Inbound messages are validated, rate-limited, persisted in `tx1`, answered by
LLM/RAG outside any DB transaction, then enqueued in `tx2`. The worker drains
`outbound_queue` with `FOR UPDATE SKIP LOCKED`; web and userbot dispatchers stay
in-process where the live connection lives.

### AI provider routing

Each tenant can configure a different model stack:

| Purpose | Typical providers | Used for |
|---|---|---|
| `chat` | OpenAI, OpenRouter, Ollama; DB/UI also carries Anthropic slots | Replies, extraction, sales reasoning, tools |
| `embed` | OpenAI / OpenAI-compatible endpoints, Ollama | KB ingestion and retrieval vectors |
| `vision` | OpenAI, OpenRouter-compatible vision models | Image/document analysis, KYC/photo flows |
| `judge` | OpenAI, OpenRouter, Anthropic | Quality lab, self-play, evaluation |
| `reranker` | Jina, Cohere | Cross-encoder reranking after hybrid retrieval |
| `transcribe` | OpenRouter, OpenAI-compatible APIs | Voice note transcription, including Groq via custom base URL |

Keys live in `tenant_secrets` under AES-256-GCM. A key can be reused across
purposes for the same provider, and changes apply without restarting `apps/api`.

### Service provider marketplace

The catalog is the product surface for businesses that sell many services:
transfer, cleaning, massage, beauty, housing, exchange, custom offers, and
anything a tenant adds.

Service catalog items route to one of four executors:

| Route type | Meaning |
|---|---|
| `funnel` | Lead Engine owns the process: stages, fields, AI behavior, operator steps |
| `partner_service` | A partner/provider executes the service; the platform tracks handoff and commission |
| `webhook` | A request is sent to an external system |
| `manual` | Operator handles it without automation |

Curated marketplace providers install into three tables at once:
`partners`, `partner_services`, and `service_catalog_items`. Custom providers
can be created from the UI when the curated shelf does not cover the tenant's
real executor network. See [SERVICE_CATALOG.md](docs/engineering/SERVICE_CATALOG.md).

---

## Vertical Packs

Lead Engine is vertical-agnostic at runtime, but ships with production-ready
starting points. Each pack seeds funnels, fields, prompts, and stage behavior.

| Template | Business | Status |
|---|---|---|
| `exchange_v1` | Crypto/RUB -> THB exchange desk | live, most active |
| `concierge_v1` | Multi-service desk for villas, expats, hospitality | multi-request, provider handoff |
| `recruitment_v1` | Recruitment and relocation agencies | GTM ICP |
| `modeling_v1` | Modeling agencies | implemented |
| `real_estate_v1` | Real estate sales | implemented |
| `saas_v1` | SaaS sales pipeline | implemented |
| `video_v1` | Video production | implemented |
| `visa_v1` | Visa and immigration services | implemented |
| `scooter_v1` | Scooter and bike rental | implemented |

The universal funnel backbone is:

```text
capture -> qualify -> offer -> [clear] -> [fulfill] -> won / lost
```

Active stages store `phase`; intake and terminal stages are anchors. The AI
builder and `/api/admin/workflows/apply` validate monotonicity and required
`qualify` / `offer` phases before saving a funnel.

---

## Demos

| Demo | What it shows |
|---|---|
| `apps/landing` | Public product demos: exchange, concierge/service desk, provider marketplace, visa, vertical library |
| `apps/api/demo/web-chat.html` | Standalone web-channel client for `/ws/:slug` |
| `apps/api/scripts/seed-modeling-demo.ts` | Modeling vertical seed/demo data |
| `docs/gtm/sales-bot/SETUP.md` | Meta-demo: a bot that sells Lead Engine itself |
| `packages/kb/examples/*` | RAG examples with OpenAI or local Ollama |

Run the landing demo with:

```bash
bun run dev:landing
```

Run the API/admin stack locally with the quick start below, then open the admin
UI and install verticals/providers from the cabinet.

---

## Architecture

| App / package | Responsibility |
|---|---|
| `apps/api` | Hono HTTP server: auth, admin API, webhooks, web widget WS, hot reload, metrics |
| `apps/worker` | Outbound queue dispatcher, channel reload polling, cron jobs |
| `apps/admin-ui` | React 19 + Vite cabinet: onboarding, channels, settings, catalog, leads, conversations, quality lab |
| `apps/landing` | Public demo/marketing site |
| `apps/widget` | Embeddable web chat widget for customer sites: vanilla TS, builds to a single IIFE `/widget.js` |
| `apps/vertical-*` | Vertical template packages loaded through `packages/verticals` |
| `packages/storage` | Drizzle schema, migrations, RLS helpers |
| `packages/channel-*` | Channel adapters behind `ChannelAdapter` |
| `packages/llm-router` | Provider clients and per-tenant routing |
| `packages/kb` | RAG, ingestion, reranking, tools, vision helpers |
| `packages/sales` | Styles, skills, stage classifier, coach/evaluation logic |
| `packages/conversation-engine` | Inbound pipeline, DAL, `withTenant`, reply dispatch |
| `packages/observability` | JSON logger and Prometheus metrics |

Dependency direction is intentionally acyclic; `conversation-engine` depends on
domain packages and channel contracts, while concrete apps wire adapters and
routes. Details: [ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Quick Start

Requires [Bun](https://bun.sh) 1.3.14+ and Docker.

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install

cp .env.example .env
# Minimum:
#   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine
#   PLATFORM_MASTER_KEY=<openssl rand -hex 32>
#   TELEGRAM_WEBHOOK_SECRET=dev-tg-secret
#   ALLOW_PUBLIC_SIGNUP=1   # local dev only

bun db:up
bun run apps/api/scripts/reset-and-migrate.ts

bun run dev          # apps/api -> http://localhost:3000
bun run dev:worker   # outbound worker
bun run dev:ui       # admin UI -> http://localhost:5173
```

Default local login after signup/reset flow: `bob@demo.io` / `test1234`.
Public signup is closed unless `ALLOW_PUBLIC_SIGNUP=1` is set.

Useful commands:

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

## Invariants

- **RLS is mandatory.** Tenant-scoped production reads/writes must go through
  `withTenant(db, tenantId, fn)`. In production the app DB role must be
  `NOSUPERUSER NOBYPASSRLS`.
- **No LLM call inside the long transaction.** `processInbound` persists first,
  releases the DB connection, calls the LLM/RAG layer, then opens a second
  transaction to enqueue outbound work.
- **Hot reload is part of the product.** LLM configs, channels, and tenant
  status changes apply immediately in `apps/api`; `apps/worker` reloads
  channels by polling.
- **Secrets never enter audit logs.** LLM keys, channel tokens, userbot
  sessions, exchange requisites, and provider credentials stay encrypted in
  `tenant_secrets`.

---

## Admin API

Authenticated endpoints live under `/api/admin/*`:

- auth, invites, password reset
- onboarding status
- channel CRUD
- LLM provider configs
- KB documents
- conversations and operator takeover
- funnels, AI workflow builder, leads
- service catalog, provider marketplace, partners, partner deals
- exchange rates, requisites, orders
- notifications, outreach, templates
- audit log list and CSV export
- billing, audit, diagnostics, quality lab, superadmin

Browse [`apps/api/src/routes/`](apps/api/src/routes) for route factories and
integration tests.

---

## Testing

Tests require Postgres on port `5434`.

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

The suite covers RLS enforcement, multi-tenant route isolation, webhook flows,
channel adapters, RAG, exchange workflows, service catalog/provider marketplace,
quality lab, and the split-transaction pipeline. More:
[TESTING.md](docs/engineering/TESTING.md).

---

## Deployment

Current hosted environments:

| Environment | URL | Notes |
|---|---|---|
| Production | `https://exchanges.agency` | landing, API/webhooks, `/healthz`, `/widget.js` |
| Production admin | `https://client.exchanges.agency` | admin-ui on the subdomain root; `https://exchanges.agency/admin` redirects here |
| Development | `https://dev.exchanges.agency` | separate dev instance; admin-ui remains under `/admin/` |

Core env vars:

| Var | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string; app role must be `NOSUPERUSER NOBYPASSRLS` in prod |
| `PLATFORM_MASTER_KEY` | 32-byte hex key for AES-256-GCM secrets |
| `PLATFORM_PUBLIC_URL` | Public API URL for webhooks and snippets |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret-token header |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | Meta WhatsApp webhook fallback credentials |
| `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET` | Meta Messenger webhook fallback credentials |
| `MAX_WEBHOOK_SECRET` | Optional MAX webhook secret fallback; per-channel secret is preferred |
| `WEB_WS_AUTH_SECRET` | Optional web widget shared secret |
| `KB_UPLOAD_DIR` / `KB_MAX_UPLOAD_BYTES` | Original KB upload storage path and per-file limit; use persistent storage in prod |
| `STRIPE_*` | Optional billing |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | Inbound tenant rate limits |

Run migrations under an owner/BYPASSRLS role; run apps under the restricted app
role. Full references: [CONFIGURATION.md](docs/engineering/CONFIGURATION.md)
and [SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md).

---

## Positioning

| Capability | Lead Engine | Intercom Fin | Chatbase | ManyChat |
|---|:---:|:---:|:---:|:---:|
| Telegram bot + personal account | yes | no | no | partial |
| WhatsApp / Messenger / VK / MAX / Web | yes | partial | web | yes |
| BYOK LLM per tenant | yes | no | partial | no |
| RAG + workflow stages | yes | partial | RAG only | flow-builder |
| Operator takeover | yes | yes | no | yes |
| Service provider marketplace | yes | no | no | no |
| Self-host / source-available | yes | no | no | no |

The niche is messenger-native AI operations for RU/CIS/MENA and service-heavy
businesses: not "chatbot answers FAQ", but "messenger conversation becomes
revenue workflow".

---

## Contributing & License

Use [Conventional Commits](https://www.conventionalcommits.org/). Before
shipping code, run:

```bash
bun run typecheck
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

**License:** the product is [PolyForm Noncommercial 1.0.0](LICENSE). Commercial
use requires a paid license from [chatman-media](https://github.com/chatman-media).
Reusable libraries in `packages/*` remain MIT. © Alexander Kireev / chatman-media.

<div align="center">

[🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md) &nbsp;·&nbsp; [⬆ top](#top)

</div>
