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
[![License: PolyForm NC 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-bot%20%2B%20userbot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Stripe](https://img.shields.io/badge/Stripe-billing-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

Multi-tenant SaaS · BYOK LLM · per-tenant RAG · sales methodologies (SPIN / NEPQ / AIDA) · operator takeover

🌐 🇬🇧 **English** &nbsp;·&nbsp; [🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md)

</div>

---

A **multi-tenant SaaS** that replies to inbound leads in ~30 seconds across
Telegram, WhatsApp, and a web widget — it walks a person from "just curious"
to a submitted application/order and hands hot leads off to an operator.
Driven by sales methodologies (SPIN, NEPQ, AIDA), not a FAQ bot.

Each customer is an isolated `tenant` with its own channels, LLM config, and
knowledge base — data isolation is enforced at the **Postgres RLS** level.
**BYOK**: bring your own OpenAI / Anthropic key.

**Phase 1 ICP:** recruitment agencies (RU / CIS / MENA, Telegram-first,
ARPU $99–199/mo). The engine itself is vertical-agnostic — multi-vertical
templates ship and `exchange` is live. *(Phase 2: real estate · Phase 3: horizontal.)*

📖 **Docs:** [index](docs/README.md) · [Architecture](docs/engineering/ARCHITECTURE.md) · [Onboarding](docs/engineering/ONBOARDING.md) · [Exchange](docs/engineering/EXCHANGE.md) · [Configuration](docs/engineering/CONFIGURATION.md) · [Roadmap](docs/strategy/ROADMAP.md) · [Competitors](docs/strategy/COMPETITORS.md)

---

## Features at a glance

| Channels | AI Engine | Operator Tools |
|---|---|---|
| Telegram Bot + Userbot | RAG: pgvector + BM25 + RRF fusion | Inbox + conversation takeover |
| WhatsApp Cloud API | Multi-query expansion + MMR + reranking | Lead pipeline (Kanban) |
| Web Widget (WebSocket) | BYOK LLM (OpenAI / Anthropic / Ollama) | Drag-and-drop funnel builder |
| Auto-setWebhook (60s) | SPIN / NEPQ / AIDA methodologies | A/B experiments + ELO ranking |
| Per-tenant RLS isolation | Passport OCR + photo vision | Outreach broadcasts + templates |
| Universal funnel phase backbone | Hallucination guard + semantic cache | Superadmin panel · invites · audit |
| Multi-vertical templates (exchange live) | Per-purpose LLM routing | Admin copilot (page-aware, BYOK) |

---

## Onboarding & quota

Self-service — **no env vars, no restarts**. Public signup is closed by
default (`ALLOW_PUBLIC_SIGNUP=1` to open); the first admin is `superadmin`.
A mandatory, vertical-aware wizard gates the cabinet:

```
/onboarding → vertical → channel → LLM → (exchange: rates → requisites) → KB → done
```

Connect a Telegram bot (auto-`setWebhook` in 60s), WhatsApp, or a web widget;
save a BYOK LLM key (encrypted AES-256-GCM); upload KB docs. Channels accept
inbound immediately, and operators can take over any conversation from the
inbox. Everything applies **live** via an in-process bus + ≤30s worker poll.
Full walkthrough: [docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md).

**Quota by tier** (`apps/api/src/lib/plans.ts`):

| Plan | Channels | KB docs | Rate/min | Price |
|---|---|---|---|---|
| `free` | 100 | 100000 | 120 | $0 |
| `starter` | 3 | 500 | 60 | $99/mo |
| `pro` | 10 | 10000 | 120 | $199/mo |
| `enterprise` | 100 | 100000 | 600 | custom |

> In the current exchange-focused / self-host config the `free` plan is
> effectively **unlimited** (no SaaS billing); `starter`/`pro` exist in code
> for the Stripe billing path. Exceeding a limit → `402` with
> `{ reason, limit, current, plan, upgradeHint }`.

---

## Architecture

| App | What it is |
|---|---|
| `apps/api` | HTTP server: webhook handlers (telegram / whatsapp / stripe), `/ws/:slug` (web), the full admin API, `/metrics`, `/healthz` |
| `apps/worker` | Outbound dispatcher (`SKIP LOCKED` queue), channel-reload polling, cron jobs |
| `apps/admin-ui` | React 19 + Vite SPA (Tailwind v4 + shadcn/ui) — onboarding wizard, dashboard, channels, conversations, leads, funnel builder, audit, … |
| `apps/vertical-*` | Vertical templates (`exchange` live, plus real-estate / recruitment / saas / video) — loaded via `packages/verticals`, not deployed |

Domain logic lives in `packages/*` (published to npm under `@chatman-media`):
`storage` (Drizzle schema + migrations), `channel-{core,telegram,whatsapp,web}`,
`llm-router`, `kb` (RAG), `sales`, `conversation-engine`, `verticals`,
`observability`. Dependency graph and the split-tx pipeline are documented in
[docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Quick start (local dev)

Requires [Bun](https://bun.sh) 1.3.14+ and Docker (Postgres + pgvector).

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine && bun install

cp .env.example .env
# Minimum: PLATFORM_MASTER_KEY (openssl rand -hex 32),
#          TELEGRAM_WEBHOOK_SECRET (any string),
#          PLATFORM_PUBLIC_URL=http://localhost:3000 (for auto-setWebhook)

bun db:up                                       # postgres @ 5434
bun run apps/api/scripts/reset-and-migrate.ts   # apply migrations

bun run dev          # apps/api  → PORT 3000
bun run dev:worker   # apps/worker (outbound + reload polling)
cd apps/admin-ui && bun run dev   # admin-ui → http://localhost:5173
```

For local dev set `ALLOW_PUBLIC_SIGNUP=1`, open the admin UI, create a tenant,
and follow the guided wizard.

```bash
bun db:up / db:down / db:reset / db:psql   # Postgres container helpers
bun run typecheck                          # tsc across all packages
bun run test                               # bun test across the monorepo
```

---

## Multi-tenant & security

Every customer is a `tenant` row; all domain data is scoped by `tenant_id`.
`FORCE ROW LEVEL SECURITY` is applied to the tenant-scoped tables, and all
production paths wrap repo calls in `withTenant(db, tenantId, fn)` (which sets
`app.tenant_id` per transaction). Secrets (LLM keys, userbot sessions) are
stored AES-256-GCM encrypted in `tenant_secrets`.

> **Production:** `apps/api` / `apps/worker` MUST connect under a
> `NOSUPERUSER NOBYPASSRLS` Postgres role, or RLS is bypassed. Both log
> `"RLS enforced"` / `"RLS not enforced"` on boot. Migrations run under a
> separate owner role. Validated by RLS + multi-tenant integration tests.

---

## Channels & pipeline

| Channel | Inbound | Outbound |
|---|---|---|
| `telegram_bot` | webhook + secret-token header | `apps/worker` → Bot API |
| `telegram_userbot` | MTProto receive loop (apps/api) | in-process |
| `whatsapp` | webhook + `X-Hub-Signature-256` | `apps/worker` → Meta Graph |
| `web` | WebSocket `/ws/:slug` | in-process |

Inbound is validated (per-channel signature → rate limit), persisted in tx1,
classified + RAG-answered, then the outbound is enqueued in tx2 and the
webhook acks in <100ms; `apps/worker` drains `outbound_queue` via `SKIP LOCKED`.
Diagram and step-by-step detail: [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

---

## Admin API

~120 REST endpoints under `/api/admin/*` (Bearer JWT from `/api/auth/login`):
auth & invites, onboarding status, channels, LLM configs, KB, conversations,
leads + funnel builder, styles, experiments, billing (Stripe), outreach, and
superadmin. Browse [`apps/api/src/routes/`](apps/api/src/routes); the
end-to-end tenant flow is in [docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md).

---

## Testing

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test
```

950+ tests across 15 packages — multi-tenant E2E through the real webhook
handler, the RLS non-bypass contract, the RAG pipeline (~180), SaaS route
integration, and exchange workflow mocks. Coverage: `bun test --coverage`.
More: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

---

## Deployment

Key env vars (full reference in [docs/engineering/CONFIGURATION.md](docs/engineering/CONFIGURATION.md);
ops in [docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md)):

| Var | Description |
|---|---|
| `DATABASE_URL` ✅ | Postgres — **NOSUPERUSER NOBYPASSRLS role in prod** |
| `PLATFORM_MASTER_KEY` ✅ | 32-byte hex for AES-256-GCM (`tenant_secrets`) |
| `TELEGRAM_WEBHOOK_SECRET` ✅ | `X-Telegram-Bot-Api-Secret-Token` header |
| `PLATFORM_PUBLIC_URL` | base URL of apps/api for auto-`setWebhook` |
| `STRIPE_*` | secret key + price IDs + webhook secret (empty → billing disabled) |
| `RATE_LIMIT_PER_MIN` / `_PER_HOUR` | default 60 / 600 (`0` = off — do not in prod) |

Run migrations under an owner / BYPASSRLS role; the apps under the restricted
role. Full production checklist: [docs/operations/SERVER_RUNBOOK.md](docs/operations/SERVER_RUNBOOK.md).

---

## Positioning

| | **Lead Engine** | Intercom Fin | Chatbase | Decagon |
|---|:---:|:---:|:---:|:---:|
| Telegram-native | ✅ | ❌ | ❌ | ❌ |
| WhatsApp / Web | ✅ | ✅ | web | web |
| BYOK LLM | ✅ | ❌ | partial | ❌ |
| Operator takeover | ✅ | ✅ | ❌ | ✅ |
| Lead pipeline + funnel builder | ✅ | ❌ | ❌ | ❌ |
| Self-host / source-available | ✅ | ❌ | ❌ | ❌ |

Niche: AI-first customer service for messenger-centric markets (Telegram /
WhatsApp) with BYOK and a full operator workflow. Full analysis and roadmap:
[docs/strategy/COMPETITORS.md](docs/strategy/COMPETITORS.md) · [docs/strategy/ROADMAP.md](docs/strategy/ROADMAP.md).

---

## Contributing & License

PRs welcome. Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:` / `fix:` / …) — semantic-release derives versions and publishes
`@chatman-media/*` to npm on push to `main`. Run `bun run typecheck && bun test`
before submitting, and read [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md)
before touching `apps/api` or the packages (the RLS / `withTenant` and split-tx
contracts are critical invariants).

**License:** the product is [PolyForm Noncommercial 1.0.0](LICENSE) — free for any noncommercial use; **commercial use requires a paid license** (contact [chatman-media](https://github.com/chatman-media)). The reusable libraries in `packages/*` stay **MIT**. © Alexander Kireev / chatman-media.

<div align="center">

[🇷🇺 Русский](README.ru.md) &nbsp;·&nbsp; [🇨🇳 中文](README.zh.md) &nbsp;·&nbsp; [⬆ top](#top)

</div>
