# CLAUDE.md

Lean always-loaded context for Claude Code. The full agent contract lives in
[AGENTS.md](AGENTS.md) — read it (and `docs/`) when a task needs deeper detail.
Keep this file short: it is loaded on every session and never evicted from context.

## Non-negotiables
- **Runtime: Bun 1.3.14+. Never use Node, npm, or pnpm directly.**
- **DB:** PostgreSQL 17 + pgvector via Docker Compose on port **5434** (not 5432).
- **Lint/format:** Biome. `bun run check` = lint + format; CI runs the same.
- **Before pushing:** `bun run typecheck` and `bun run test` must pass.

## Daily commands
- `bun db:up` / `bun db:down` / `bun db:reset` — Postgres container
- `bun run dev` — apps/api on :3000
- `bun run dev:ui` — apps/admin-ui on :5173
- `bun run dev:worker` — outbound queue + channel-reload polling
- `bun run typecheck` · `bun run test` · `bun run check`

## Layout
Bun monorepo: `apps/*` (api, admin-ui, landing, worker, widget, vertical-*) +
`packages/*` (conversation-engine, channel-*, llm-router, kb, storage, sales, …).

## Dev login
Public signup is closed (`403 signup_disabled`). For local dev set
`ALLOW_PUBLIC_SIGNUP=1`, then use `bob@demo.io` / `test1234`. The first admin of a
tenant becomes `superadmin`. After login the OnboardingGate forces `/onboarding`.

## Deploy & gotchas
- Push `main` → prod; push `dev` → dev instance (SSH deploy via `deploy.sh`).
- **Never connect the prod Telegram bot to dev** — it steals the webhook and prod
  stops receiving messages. Dev uses separate channels only.
- `ADMIN_UI_BASE=/` belongs only in the prod `.env`; it must be absent on dev.

For environments, migrations, RLS, verticals and everything else see [AGENTS.md](AGENTS.md).
