---
name: local-stack
description: Bring up the full local lead-engine dev stack (Postgres + API + admin-ui + worker) and create a dev login. Use when the user wants to run the app locally, start the dev environment, or reproduce something on a local stack.
disable-model-invocation: true
---

# /local-stack — local dev environment

Brings up Postgres, applies migrations, starts the services, and gives you a
working login. All commands use **Bun** (never npm/pnpm); Postgres is on **5434**.

## 1. Database
```bash
bun db:up        # start Postgres 17 + pgvector (docker compose)
bun db:reset     # OR: drop volumes + re-apply all migrations (clean slate)
```
`db:reset` runs `apps/api/scripts/reset-and-migrate.ts` against
`postgres://lead:lead@localhost:5434/lead_engine`.

## 2. Services (separate terminals)
```bash
bun run dev          # API on :3000
bun run dev:ui       # admin-ui (Vite) on :5173
bun run dev:worker   # outbound queue + channel-reload polling
```

## 3. Dev login
Public signup is closed (`403 signup_disabled`). For local dev set
`ALLOW_PUBLIC_SIGNUP=1` in `.env`, then:
```bash
curl -s -X POST http://localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@demo.io","password":"test1234"}' | jq .token
```
Credentials: **`bob@demo.io` / `test1234`**. First admin of a tenant becomes
`superadmin`. After login the OnboardingGate forces `/onboarding` (channel +
chat-LLM; exchange also needs funnel + rate + requisite).

## Gotchas
- Postgres is on **5434**, not 5432.
- Never point a **prod** Telegram bot at a local/dev instance — it steals the webhook.
- `db:reset` wipes data; use `bun db:up` alone to keep existing data.
