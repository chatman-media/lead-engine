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

## Channels

| Var | Req | Description |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | opt | Meta webhook verify token + App Secret (HMAC-SHA256 of `X-Hub-Signature-256`). **Fallback** — also per-tenant in `tenant_secrets`. Empty app secret → signature check off (boot warning). |
| `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET` | opt | Meta Messenger webhook verify token + App Secret. **Fallback** — also per-tenant in `tenant_secrets`; empty app secret disables signature verification with a boot warning. |
| VK channel credentials | n/a | VK access token / confirmation code / optional secret key are saved per-tenant through `/channels`; there is no global env fallback for the SaaS path. |
| `MAX_WEBHOOK_SECRET` | opt | Fallback secret for MAX `X-Max-Bot-Api-Secret`. Prefer per-channel secret saved through `/channels`. |
| `WEB_WS_AUTH_SECRET` | opt | Shared secret for `/ws/:slug?auth=...` (web widget, pilot stage). |
| `WEB_DISPATCHER_POLL_MS` / `WEB_DISPATCHER_BATCH` | opt | In-process web outbound dispatcher tuning (default `200` / `32`). |
| `WEB_WIDGET_SCRIPT_URL` | opt | CDN URL of `/widget.js`. If set, `POST /api/admin/channels/web` returns a production `<script>` snippet; else falls back to `<PLATFORM_PUBLIC_URL>/widget.js`. |
| `BOT_TOKEN` / `BOT_TOKEN_<SLUG>` | opt | Legacy single-tenant Telegram bot bootstrap. Real tokens go through `tenant_secrets` (encrypted). |
| `WA_ACCESS_TOKEN` / `WA_ACCESS_TOKEN_<SLUG>` | opt | Same, for WhatsApp. |
| `MAX_BOT_TOKEN` / `MAX_BOT_TOKEN_<SLUG>` | opt | Same, for MAX. Real SaaS tokens should be encrypted per-channel as `channel_max_<botId>`. |

## Worker

| Var | Req | Description |
|---|---|---|
| `DISPATCHER_POLL_MS` / `DISPATCHER_BATCH` | opt | Outbound queue poll interval / batch (default `1000` / `32`). |
| `WORKER_CHANNEL_RELOAD_MS` | opt | How often the worker reloads channels from DB to pick up UI-onboarded channels without restart (default `30000`; `0` = boot only). |
| `WORKER_METRICS_PORT` | opt | Prometheus port for apps/worker (default `9100`). |

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

## Landing

| Var | Req | Description |
|---|---|---|
| `VITE_DEMO_URL` | opt | "Book a demo" link on the landing page (default Calendly placeholder). |

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
