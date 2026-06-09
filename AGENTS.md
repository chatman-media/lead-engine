# AGENTS.md — AI Agent Instructions

Rules, patterns and context for AI agents working in this codebase.
For architecture and feature overview see [README.md](README.md) and [docs/strategy/ROADMAP.md](docs/strategy/ROADMAP.md).

---

## Dev environment

- **Runtime:** [Bun](https://bun.sh) 1.3.14+. Never use Node/npm directly.
- **Database:** PostgreSQL 17 + pgvector (`pgvector/pgvector:pg17`), via Docker Compose on port **5434** (not 5432 — avoids conflicts with other local Postgres instances).
- **Linter/formatter:** [Biome](https://biomejs.dev/). Run `bun run check` to lint+format. CI runs the same check.

### First-time setup

```bash
git clone git@github.com:chatman-media/lead-engine.git
cd lead-engine
bun install
cp .env.example .env               # fill in at minimum: PLATFORM_MASTER_KEY
bun db:up                          # start postgres container
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun run apps/api/scripts/reset-and-migrate.ts
```

### Daily commands

```bash
bun db:up             # start Postgres (docker compose)
bun db:down           # stop it
bun db:reset          # drop volumes + re-migrate (clean slate)
bun db:psql           # psql shell inside the container

bun run dev           # apps/api on PORT=3000
bun run dev:worker    # apps/worker (outbound queue + channel-reload polling)
bun run dev:ui        # apps/admin-ui on http://localhost:5173

bun run typecheck     # tsc across all packages (must pass before pushing)
bun run test          # full test suite (~950 tests)
bun run check         # biome lint + format check
```

---

## Dev login

After `bun db:reset` the DB is empty. **Public signup is closed by default**
(`POST /api/auth/signup` → `403 signup_disabled`) — for local dev set
`ALLOW_PUBLIC_SIGNUP=1` in `.env` first, then register via UI or curl:

```bash
# .env: ALLOW_PUBLIC_SIGNUP=1
curl -s -X POST http://localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@demo.io","password":"test1234"}' | jq .token
```

**Default dev credentials:** `bob@demo.io` / `test1234`

After signing in, the `OnboardingGate` redirects to `/onboarding` until the
mandatory wizard is complete (channel + chat-LLM; exchange also needs funnel +
rate + requisite). See [docs/engineering/ONBOARDING.md](docs/engineering/ONBOARDING.md).

The first admin of a tenant gets `role=superadmin` automatically. To test cross-tenant isolation or manager-role restrictions, sign up a second tenant or invite a manager:

```bash
# Invite a manager (as superadmin)
curl -s -X POST http://localhost:3000/api/admin/admins/invite \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"email":"carol@demo.io","role":"manager"}'
```

---

## Running tests

> Full testing guide: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

Tests require a live Postgres instance. Each integration test creates an isolated DB via `createIsolatedDb` and applies migrations before the suite runs.

```bash
# Run everything
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test

# Run a specific package
bun test packages/kb

# Run a specific test file
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun test apps/api/src/routes/auth.integration.test.ts

# Run with coverage
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test --coverage
```

### Integration test pattern

All integration tests in `apps/api/src/routes/*.integration.test.ts` follow this pattern:

```ts
const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_<feature>_${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  if (!ownerUrl) return;                          // skip if no DB
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  // Build isolated Hono app — same route wiring as apps/api/src/index.ts
  app = new Hono();
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeMyFeatureRoutes({ db }));
}, 30_000);

afterAll(async () => {
  if (sql) { await sql.end({ timeout: 0 }).catch(() => {}); sql = null; }
}, 10_000);
```

Key: each test file gets its own isolated Postgres database — no shared state between suites.

---

## Architecture invariants (critical — do not break)

### 1. RLS — Row-Level Security

Every tenant-scoped table has `FORCE ROW LEVEL SECURITY`. **All production reads/writes MUST go through `withTenant(db, tenantId, fn)`** which wraps the callback in a transaction and runs `SET LOCAL app.tenant_id = <id>` before any query.

**Never** run direct queries against tenant tables outside `withTenant`. The RLS policy will return empty results (silent data leak / corruption) instead of erroring.

In production the app connects under a **`NOSUPERUSER NOBYPASSRLS`** Postgres role. On boot both `apps/api` and `apps/worker` log either `"RLS enforced"` (info) or `"RLS not enforced"` (warn). A warn means the DB role is misconfigured — fix it before handling real traffic.

Tested in: `packages/storage/src/rls.integration.test.ts` (8 tests) and `apps/api/src/multi-tenant.integration.test.ts` (10 E2E tests).

### 2. Split-transaction pipeline

`processInbound` uses three strictly-ordered phases:

```
tx1  — persist (contact + conversation + message + stageClassifier + memoryExtractor)
       connection returned to pool after tx1
async — reply.generate() — 1-2s LLM call, NO open transaction
tx2  — enqueue outbound_queue entries
async fire-forget — photo classification (never blocks webhook response)
```

**Invariant:** the LLM call must happen BETWEEN tx1 and tx2, never inside a transaction. Validated by test: `events.indexOf("llm-call") < events.indexOf("tx-open")`.

### 3. Hot-reload (no restarts needed)

Changing LLM configs, channels, or tenant status goes live in ≤30s without restarting any process:
- `apps/api`: `InMemoryLlmRouter.invalidate(tenantId)` + `ChannelRegistry.reloadTenant(tenantId)` — instant
- `apps/worker`: polls `tenant-reloader` every 30s (configurable via `WORKER_CHANNEL_RELOAD_MS`)

Never hardcode channel configs or LLM keys — always read through the router/registry.

---

## Package map

```
packages/
  storage            — Drizzle schema, migrations, RLS helpers
  llm-router         — ChatClient / EmbeddingClient / per-tenant config (BYOK + purpose routing)
  kb                 — RAG pipeline: hybrid search, ingest, answer, reranker, MMR, multi-query
  sales              — CoachAnalyzer, StageClassifier, ELO ranking
  conversation-engine — processInbound pipeline, withTenant, DAL
  channel-core       — ChannelAdapter contract, Inbound, OutboundEnvelope
  channel-telegram   — BotAPI + MTProto userbot (GramJS)
  channel-whatsapp   — Meta Graph API
  channel-facebook   — Meta Messenger Send API
  channel-vk         — VK Callback API + messages.send
  channel-max        — MAX Bot API webhook + messages.send
  channel-web        — WebSocket chat widget
  observability      — JsonLogger, PlatformMetrics
  verticals          — VerticalTemplate registry + funnel phase backbone (phases.ts)

apps/
  api                — Hono HTTP server: webhooks + admin API + WS
  worker             — Outbound dispatcher (SKIP LOCKED) + polling reload
  admin-ui           — React 19 + Vite SPA (Tailwind v4 + shadcn/ui)
  widget             — Embed script < 50KB gzip
  landing            — Marketing site
  vertical-*         — Vertical template packages: exchange, concierge,
                       modeling, real-estate, recruitment, saas, scooter,
                       video, visa
```

**Dependency direction (acyclic):**
```
conversation-engine → llm-router, kb, sales, storage
kb                  → llm-router
sales               → kb, llm-router
channel-*           → channel-core
apps/api            → conversation-engine, channel-*, sales, kb, llm-router
apps/worker         → conversation-engine, channel-*
```

---

## Key schema tables

```sql
tenants             — slug, plan, status (active/suspended)
admins              — email, role (superadmin/manager), tenantId
admin_invites       — email, token, role, expiresAt, usedAt
password_resets     — adminId, token (64 hex), expiresAt, usedAt
channels            — tenantId, kind (telegram_bot/telegram_userbot/whatsapp/facebook/vk/max/web), status
contacts            — tenantId (channel-agnostic person)
channel_identities  — contactId, channelId, externalUserId
conversations       — tenantId, contactId, channelId, mode (ai/human)
messages            — conversationId, role (user/assistant/human), content
leads               — tenantId, userId (contactId), state, stageDefinitionId
lead_field_values   — leadId, fieldId, value
funnels             — tenantId, slug, verticalTemplateId, stagesJson
stage_definitions   — tenantId, funnelId, slug, kind (intake/active/terminal_won/terminal_lost), phase (qualify/offer/clear/fulfill — костяк)
kb_documents        — tenantId, title, contentHash (dedup)
kb_chunks           — documentId, embedding (vector), text, topic
outbound_queue      — tenantId, channelId, payloadJson, scheduledAt, sentAt (SKIP LOCKED)
tenant_secrets      — tenantId, key, value (AES-256-GCM encrypted)
llm_provider_configs — tenantId, purpose (chat/embed/vision/judge/reranker/transcribe), provider, model
audit_log           — tenantId, adminId, action, resourceType, resourceId, diff
message_templates   — tenantId, name, body
referral_codes      — tenantId, code, usageCount
exchange_rates      — tenantId, asset, network, baseRate, marginPct, feeFixedThb (обменник)
exchange_rate_tiers — tenantId, targetThb, displayRate, marketRate (approved объёмные ступени)
exchange_orders     — tenantId, leadId, status, amounts, payment rails
service_catalog_items — tenantId, slug, routeType (manual/funnel/partner_service/webhook), target refs
partners            — tenantId, provider/partner contact data, defaultCommissionPct, settlementCurrency
partner_services    — tenantId, partnerId, name, category, funnel/stage refs, commissionPct
partner_deals       — tenantId, partnerId, serviceId, leadId, status, gross/commission, handoff mode
partner_settlements — tenantId, partnerId, period, totals, status
```

**`stage_definitions.kind` enum:** only `'intake' | 'active' | 'terminal_won' | 'terminal_lost'` — CHECK constraint will reject anything else.

**`stage_definitions.phase`:** NULL for anchors (intake/terminal); for `active` stages ∈ `'qualify' | 'offer' | 'clear' | 'fulfill'` (CHECK). `validateBackbone()` in `packages/verticals` enforces phase monotonicity + mandatory `qualify`/`offer` — funnel `apply` returns `400` on violation.

**`conversations.source` enum:** only `'bot' | 'userbot' | 'self_play'` — CHECK constraint.

**`service_catalog_items.route_type` enum:** only `'manual' | 'funnel' | 'partner_service' | 'webhook'`. A curated marketplace provider install creates/links `partners`, `partner_services`, and `service_catalog_items`; custom providers follow the same path. See [docs/engineering/SERVICE_CATALOG.md](docs/engineering/SERVICE_CATALOG.md).

---

## RAG pipeline (packages/kb)

The full retrieval pipeline in `answerWithRag` / `answerWithRagStream`:

```
1. [opt] rewriteQuery        — resolves pronouns/ellipsis from history
2. [opt] expandQueries       — LLM generates N variants → embed all in one batch (multiQuery)
3. vector / hybrid search    — pgvector cosine OR RRF(vector+BM25)
4. [opt] rrfMerge            — fuse N result lists if multi-query active
5. [opt] applyDynamicThreshold — drop hits with distance > threshold (autoTrimDistance)
6. [opt] mmrDiversify        — Maximal Marginal Relevance (mmr)
7. [opt] reranker.rerank     — cross-encoder second pass, Jina or Cohere (reranker)
8. prompt composition        — style + persona + skills + hooks + context
9. LLM generation
10.[opt] fact-checker        — hallucination guard (reflect)
```

All stages are opt-in via `AnswerInput` fields. See `packages/kb/README.md` for usage.

---

## Common pitfalls

| Mistake | Why it fails | Fix |
|---|---|---|
| Query outside `withTenant` | RLS returns empty (silent) | Always wrap in `withTenant(db, tenantId, fn)` |
| `stage_definitions` with `kind='regular'` | CHECK constraint violation | Use `'active'` |
| `conversations.source='web'` | CHECK constraint violation | Use `'bot'` for web/whatsapp/facebook/vk/max channel-initiated convos |
| Missing `funnelId` in `stage_definitions` | NOT NULL violation | Insert funnel first, use returned id |
| `constructor.name` checks in tests | Returns `"Object"` in CI (minification) | Use `instanceof` after matching import |
| Direct `postgres()` without `onnotice` | Noisy test output | Pass `{ onnotice: () => {} }` in test setups |
| LLM key not encrypted | Stored in plaintext in `tenant_secrets` | Use `setEncryptedSecret` / `getDecryptedSecret` |
| Provider/channel credential in notes/metadata | Leaks secrets through API/audit/logs | Store credentials in `tenant_secrets`; metadata may contain only marker/config data |
| `service_catalog_items.route_type='partner_service'` without `partnerServiceId` | Runtime cannot create provider handoff/deal | Create/link `partner_services` first, or use `manual`/`funnel` |
| Reranker without extra candidates | Reranker sees only topK → no improvement | Set candidateK=topK×3 before reranker call |

---

## Adding a new API route

1. Create `apps/api/src/routes/my-feature.ts` — export `makeMyFeatureRoutes({ db })`
2. Register in `apps/api/src/index.ts`
3. Add auth middleware: `app.use("/api/admin/my-feature/*", makeRequireAuth(...))`
4. Create integration test `apps/api/src/routes/my-feature.integration.test.ts` following the pattern above
5. Add endpoint to the API table in `README.md`

### Route conventions

```ts
export function makeMyFeatureRoutes({ db }: { db: PostgresJsDatabase<typeof schema> }) {
  const app = new Hono();

  app.get("/api/admin/my-feature", async (c) => {
    const admin = c.get("admin");           // set by makeRequireAuth middleware
    // Always scope by tenantId:
    const rows = await withTenant(db, admin.tenantId, (tx) =>
      tx.select().from(myTable).where(eq(myTable.tenantId, admin.tenantId))
    );
    return c.json({ items: rows });
  });

  return app;
}
```

---

## Commits and PRs

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(scope):` — new feature (cuts minor version)
- `fix(scope):` — bug fix (cuts patch)
- `test(scope):` — tests only
- `docs:` — documentation
- `chore:` — tooling, deps, refactor

Scope = package or app name: `feat(kb):`, `fix(api):`, `test(auth):`, etc.

Before pushing: `bun run typecheck && DATABASE_URL=... bun test`.

---

## Env vars (minimum for local dev)

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine
PLATFORM_MASTER_KEY=<openssl rand -hex 32>    # required — AES-256-GCM for secrets
TELEGRAM_WEBHOOK_SECRET=dev-tg-secret         # any string for local dev
```

Everything else is optional for local dev. WhatsApp, Facebook, and MAX can use
global fallback webhook envs (`WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET`,
`FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET`, `MAX_WEBHOOK_SECRET`) but SaaS
channel credentials should be saved per tenant through `/channels`. VK
credentials are per-tenant only. For production see the full table in
[README.md#deployment](README.md#deployment).
