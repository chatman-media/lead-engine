# Configuration (environment variables)

Single, authoritative reference for every env var. The copy-paste template is
[`../../.env.example`](../../.env.example) (RU inline comments); this doc is the
English explanation grouped by concern, with **required/optional** and
fallback/per-tenant behaviour.

**Local dev minimum:** `DATABASE_URL` + `PLATFORM_MASTER_KEY` +
`TELEGRAM_WEBHOOK_SECRET` (+ `ALLOW_PUBLIC_SIGNUP=1` to register, see
[ONBOARDING.md](ONBOARDING.md)). Almost everything else is prod-only.

> Plan quotas (channels / KB docs / rate limits / prices) are **code**, not env —
> source of truth is `apps/api/src/lib/plans.ts` (see [README plan table](../../README.md)).

## Postgres

| Var | Req | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string. **In prod the apps must connect under a `NOSUPERUSER NOBYPASSRLS` role** (RLS enforcement). Matches `docker-compose.yml` on `:5434` for local dev. |

## Crypto / auth

| Var | Req | Description |
|---|---|---|
| `PLATFORM_MASTER_KEY` | ✅ | 32-byte hex (`openssl rand -hex 32`) for AES-256-GCM encryption of `tenant_secrets`. |
| `PLATFORM_AUTH_SECRET` | opt | HMAC secret for JWT-like auth tokens (`signAuthToken`). Falls back to `PLATFORM_MASTER_KEY`. Use a separate value so rotating the master key doesn't invalidate active sessions. |
| `PARTNER_CALLBACK_SECRET` | opt | HMAC secret for partner webhook callbacks (`partner-ping`). Falls back to `PLATFORM_AUTH_SECRET`, then `PLATFORM_MASTER_KEY`. |
| `ALLOW_PUBLIC_SIGNUP` | opt | `1` opens public `POST /api/auth/signup`; **closed by default** (→ `403 signup_disabled`). Needed for local dev and any self-serve signup. (Not present in `.env.example` — add manually.) |
| `PLATFORM_SUPERADMIN_TOKEN` | opt | Bearer token for platform `/api/superadmin/*` endpoints (`openssl rand -hex 32`). |

## Telegram

| Var | Req | Description |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | Value of the `X-Telegram-Bot-Api-Secret-Token` header set on `setWebhook` and verified on inbound. |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | opt | MTProto app credentials (my.telegram.org). **Fallback only** — userbot creds are per-tenant in `tenant_secrets`. If absent both per-tenant and in env, `/userbot/start` returns `400`. |
| `USERBOT_DISPATCHER_POLL_MS` / `USERBOT_DISPATCHER_BATCH` | opt | In-process userbot outbound dispatcher tuning (default `300` / `16`). |

## HTTP server

| Var | Req | Description |
|---|---|---|
| `PORT` | opt | apps/api port (default `3000`). |
| `PLATFORM_PUBLIC_URL` | opt | Externally-reachable base URL of apps/api for **auto-setWebhook** on Telegram channel create. Empty → set webhooks manually. Local dev: use ngrok / cloudflared. |
| `PLATFORM_BASE_DOMAIN` | opt | Tenant subdomain → `tenantSlug` for the legacy `/admin/*` routes. Empty → those routes off (SaaS `/api/admin/*` always on). |
| `HEALTH_CHECK_TIMEOUT_MS` | opt | `/healthz` dependency-check timeout (default `2000`). |
| `DRIP_DISPATCH_MS` | opt | Outreach drip dispatcher tick in apps/api (default `10000`; `0` = off — the send pace itself is per campaign). |

## LLM (env fallback)

Per-tenant LLM config lives in the DB (BYOK); these are boot fallbacks when a
tenant has no row. Without any LLM the pipeline persists but does not reply.
The admin UI/API support provider slots for `chat`, `embed`, `vision`, `judge`,
`reranker`, and `transcribe`; env fallback is intentionally minimal and covers
the legacy chat/embed path.

| Var | Req | Description |
|---|---|---|
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_BASE_URL` | opt | Chat LLM fallback (`openai` / `openrouter` / `ollama`; use DB config for Anthropic/OpenRouter model marketplace setups). |
| `LLM_EMBED_PROVIDER` / `LLM_EMBED_MODEL` / `LLM_EMBED_API_KEY` / `LLM_EMBED_BASE_URL` / `LLM_EMBED_DIM` | opt | Embedder fallback for RAG. `LLM_EMBED_DIM` default `1536` (KB column); any model is auto-fitted. |
| `STYLE_SLUG` / `EXPERIMENT_SLUG` / `STAGE_CLASSIFIER` | opt | Sales-engine knobs (default style, A/B experiment, `""`/`regex`/`llm` classifier). |

## Knowledge base files

| Var | Req | Description |
|---|---|---|
| `KB_UPLOAD_DIR` | opt | Directory where apps/api stores original KB uploads (`.pdf`, `.md`, `.txt`, `.json`). Default: `data/kb-files` under the API working directory. In production this should be a persistent volume. |
| `KB_MAX_UPLOAD_BYTES` | opt | Maximum original upload file size. Default: `26214400` (25 MiB). |
| `RAG_FACT_CHECKER_FAIL_OPEN` | opt | `1` restores the legacy fail-open behaviour when the RAG fact-checker errors (default: fail-closed). |

## Channels

| Var | Req | Description |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | opt | Meta webhook verify token + App Secret (HMAC-SHA256 of `X-Hub-Signature-256`). **Fallback** — also per-tenant in `tenant_secrets`. Empty app secret → signature check off (boot warning). |
| `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET` | opt | Meta Messenger webhook verify token + App Secret. **Fallback** — also per-tenant in `tenant_secrets`; empty app secret disables signature verification with a boot warning. |
| `VK_ACCESS_TOKEN` / `VK_ACCESS_TOKEN_<SLUG>` / `VK_CONFIRMATION_CODE` / `VK_SECRET_KEY` | opt | VK fallbacks (lookup order: per-tenant `tenant_secrets` → `VK_ACCESS_TOKEN_<SLUG>` → `VK_ACCESS_TOKEN`). SaaS tenants should save credentials through `/channels` instead. |
| `MAX_WEBHOOK_SECRET` | opt | Fallback secret for MAX `X-Max-Bot-Api-Secret`. Prefer per-channel secret saved through `/channels`. |
| `WEB_WS_AUTH_SECRET` | opt | Shared secret for `/ws/:slug?auth=...` (web widget, pilot stage). |
| `WEB_DISPATCHER_POLL_MS` / `WEB_DISPATCHER_BATCH` | opt | In-process web outbound dispatcher tuning (default `200` / `32`). |
| `WEB_WIDGET_SCRIPT_URL` | opt | CDN URL of `/widget.js`. If set, `POST /api/admin/channels/web` returns a production `<script>` snippet; else falls back to `<PLATFORM_PUBLIC_URL>/widget.js`. |
| `BOT_TOKEN` / `BOT_TOKEN_<SLUG>` | opt | Legacy single-tenant Telegram bot bootstrap. Real tokens go through `tenant_secrets` (encrypted). |
| `WA_ACCESS_TOKEN` / `WA_ACCESS_TOKEN_<SLUG>` | opt | Same, for WhatsApp. |
| `FB_PAGE_TOKEN` / `FB_PAGE_TOKEN_<SLUG>` | opt | Same, for the Facebook Messenger page token. |
| `MAX_BOT_TOKEN` / `MAX_BOT_TOKEN_<SLUG>` | opt | Same, for MAX. Real SaaS tokens should be encrypted per-channel as `channel_max_<botId>`. |

## Worker

| Var | Req | Description |
|---|---|---|
| `DISPATCHER_POLL_MS` / `DISPATCHER_BATCH_SIZE` | opt | Outbound queue poll interval / batch (default `1000` / `16`). |
| `DISPATCHER_MAX_LAG_SEC` | opt | Reclaim threshold for rows stuck in `processing` (default `60`). |
| `WORKER_CHANNEL_RELOAD_MS` | opt | How often the worker reloads channels from DB to pick up UI-onboarded channels without restart (default `30000`; `0` = boot only). |
| `METRICS_PORT` | opt | Prometheus port for apps/worker (default `0` = off; conventionally `9100`). |
| `WORKER_STALE_SWEEP_MS` / `WORKER_CHECKIN_SWEEP_MS` | opt | Stale-lead and check-in sweep ticks (default `3600000` each). |
| `WORKER_EXCHANGE_PAYMENT_SWEEP_MS` | opt | Exchange payment sweep tick (default `60000`). |
| `WORKER_INFORMER_DIGEST_MS` | opt | Admin informer digest tick (default `900000`; `0` = off). |
| `WORKER_OPS_WATCH_MS` | opt | Ops-watch sweep tick (default `300000`). |
| `OPS_FEED_STALE_MIN` / `OPS_STUCK_ORDER_MIN` / `OPS_VOLUME_SPIKE_THB` / `OPS_ALERT_COOLDOWN_MIN` | opt | Ops-watch alert thresholds: stale rate feed (min, default `20`), stuck order age (min, `45`), volume spike (THB, `0` = off), alert cooldown (min, `60`). |

## Exchange (apps/api)

| Var | Req | Description |
|---|---|---|
| `RATE_FEED_MS` | opt | Market rate-feed refresh default interval (default `180000` = 3 min; `0` = off). Per-tenant interval can override via exchange settings; the loop ticks at `min(RATE_FEED_MS, 60s)`. |
| `EXCHANGE_FEED_MAX_DEVIATION` | opt | Rate-feed sanity guard: max allowed deviation as a fraction (default `0.5`). |
| `EXCHANGE_TX_MAX_AGE_SECONDS` | opt | Max accepted on-chain tx age for payment verification (default `86400` = 24 h). |

## Email / operator notifications

| Var | Req | Description |
|---|---|---|
| `RESEND_API_KEY` | opt | Resend API key for transactional email (invites, password reset, informer digest). Empty → mailer runs in dry-run (log only). |
| `PLATFORM_FROM_EMAIL` | opt | From address (default `lead-engine <noreply@leadengine.app>`). |
| `PLATFORM_APP_URL` | opt | Base URL for links in emails/notifications (default `PLATFORM_PUBLIC_URL`, then `https://app.leadengine.app`). |
| `PLATFORM_OPERATOR_BOT_TOKEN` / `PLATFORM_OPERATOR_BOT_USERNAME` | opt | Platform-wide Telegram operator/informer bot. Empty token → Telegram notifications off. |

## Rate limit (anti runaway-cost)

| Var | Req | Description |
|---|---|---|
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` | opt | Per-tenant inbound sliding window (default `60` / `600`). Over → `429` + `Retry-After`. `0`/`0` = disabled (boot warning). **Do not leave disabled in prod.** |

## Stripe billing (optional — checkout/portal return 503 without)

| Var | Req | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | opt | `sk_test_xxx` / `sk_live_xxx`. |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | opt | Stripe Price IDs; the webhook maps `priceId → plan`. |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` | opt | Redirect URLs (support a `{TENANT}` placeholder). |
| `STRIPE_WEBHOOK_SECRET` | opt | Stripe webhook HMAC; register a webhook on `<PLATFORM_PUBLIC_URL>/webhook/stripe`. |

## Frontend builds (Vite)

| Var | Req | Description |
|---|---|---|
| `VITE_DEMO_URL` | opt | "Book a demo" link on the landing page (default Calendly placeholder). |
| `ADMIN_UI_BASE` | opt | Build-time base path for `apps/admin-ui` (default `/admin/`; set `/` when serving from its own subdomain, e.g. `client.exchanges.agency`). |

## Observability

| Var | Req | Description |
|---|---|---|
| `LOG_LEVEL` | opt | JSON logger level: `debug` / `info` / `warn` / `error` (default `info`). |

## Production checklist

- [ ] Postgres role `NOSUPERUSER NOBYPASSRLS` for the apps; migrations under a separate BYPASSRLS (owner) role.
- [ ] `PLATFORM_MASTER_KEY` set; rotate via `apps/api/scripts/rotate-master-key.ts`.
- [ ] `PLATFORM_PUBLIC_URL` set (auto-setWebhook UX).
- [ ] `WHATSAPP_APP_SECRET`, `FACEBOOK_APP_SECRET`, `MAX_WEBHOOK_SECRET`, `WEB_WS_AUTH_SECRET` set if those channels are active and not supplied per-tenant.
- [ ] VK channel tenants have per-tenant access token, confirmation code and optional secret key saved through `/channels`.
- [ ] MAX tenants have per-channel bot token and webhook secret saved through `/channels`; `MAX_BOT_TOKEN*` fallback is only for local/legacy bootstrap.
- [ ] `RATE_LIMIT_*` set (not disabled).
- [ ] Stripe: secret + price IDs + webhook secret + success/cancel URLs (if billing on).
- [ ] Boot log shows `"RLS enforced"` (info), not `"RLS not enforced"` (warn).

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [SERVER_RUNBOOK](../operations/SERVER_RUNBOOK.md) · [ONBOARDING.md](ONBOARDING.md).
