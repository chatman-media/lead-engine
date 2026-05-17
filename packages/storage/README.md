# @chatman-media/storage

[![npm](https://img.shields.io/npm/v/@chatman-media/storage)](https://www.npmjs.com/package/@chatman-media/storage)
[![CI](https://github.com/chatman-media/storage/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/storage/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![used by @chatman-media/sales](https://img.shields.io/badge/used%20by-@chatman--media%2Fsales-6366f1)](https://github.com/chatman-media/sales)

**PostgreSQL storage adapters for [@chatman-media/sales](https://github.com/chatman-media/sales).** Drizzle ORM implementations of all engine repository interfaces — users, conversations, leads, skills, ELO ratings, self-play matches, pairwise comparisons, and shadow evaluations.

Built from the production persistence layer of [sales-guru](https://github.com/chatman-media/sales-guru) — a Telegram recruitment bot that runs 24/7 qualifying inbound candidates for foreign work contracts.

---

## What's inside

| Repo class | Interface | What it does |
|------------|-----------|-------------|
| `PgUsersRepo` | `IUsersRepo` | Upsert Telegram user accounts by `telegramId` |
| `PgConversationsRepo` | `IConversationsRepo` | Create conversations linked to a user + style slug |
| `PgLeadsRepo` | `ILeadsRepo` | Create sales leads within a conversation |
| `PgSkillsRepo` | `ISkillsRepo` | Fetch all skill definitions for a given style |
| `PgSkillOutcomesRepo` | `ISkillOutcomesRepo` | Record per-lead skill outcomes; aggregate win/loss/draw counts |
| `PgStyleRatingsRepo` | `IStyleRatingsRepo` | Get/set ELO ratings per style (default 1500, upserted on change) |
| `PgSelfPlayMatchesRepo` | `ISelfPlayMatchesRepo` | Insert & query self-play match records with full transcripts |
| `PgPairwiseMatchesRepo` | `IPairwiseMatchesRepo` | Record head-to-head comparisons between two self-play matches |
| `PgShadowEvaluationsRepo` | `IShadowEvaluationsRepo` | Track evaluation run state (status, decision, pair counts, error) |

---

## Install

```bash
bun add @chatman-media/storage     # Bun
npm install @chatman-media/storage # npm / pnpm / yarn
```

Peer dependencies:

```bash
bun add drizzle-orm postgres @chatman-media/sales
```

---

## Quick start

```typescript
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgRepos, schema } from "@chatman-media/storage";

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client, { schema });

const { users, conversations, leads, skills, outcomes, ratings, matches, pairwise, shadowEvals } =
  createPgRepos(db);

// upsert a Telegram user
const { id: userId } = await users.upsert({ telegramId: 123456789, username: "alice" });

// start a conversation and a lead
const { id: convId } = await conversations.create({ userId, styleSlug: "marina-prime-v1" });
const { id: leadId } = await leads.create({ conversationId: convId });

// record a skill outcome
await outcomes.record({ skillSlug: "mirroring", styleSlug: "marina-prime-v1", leadId, outcome: "won", source: "judge" });

// read ELO rating
const elo = await ratings.getRating(42); // → 1500 (default)
```

## Storage interfaces

All classes implement interfaces from `@chatman-media/sales` — swap the implementation without touching engine code:

```typescript
import type { ISelfPlayMatchesRepo } from "@chatman-media/sales";

// Implement for any backend (SQLite, in-memory, …):
class MyMatchesRepo implements ISelfPlayMatchesRepo {
  async insert(match) { /* ... */ }
  async byId(id) { /* ... */ }
  async list(opts) { /* ... */ }
}
```

---

## Database schema

| Table | Description |
|-------|-------------|
| `users` | Telegram user accounts (`telegram_id` unique) |
| `conversations` | Conversations linked to a user and a style slug |
| `leads` | Sales leads within a conversation |
| `skill_outcomes` | Per-lead skill performance records (`won` / `lost` / `draw`) |
| `style_ratings` | ELO ratings per style (default 1500), upserted on change |
| `skills` | Skill definitions — slug, family, prompt fragment, applicable stages (JSONB) |
| `self_play_matches` | Single-style match records with full transcript (JSONB) |
| `pairwise_matches` | Head-to-head comparisons between two self-play matches |
| `shadow_evaluations` | Evaluation run state — status, decision, pair counts, error |

---

## Architecture

```
@chatman-media/storage
├── schema.ts          9 Drizzle table definitions (pgTable)
├── pg/
│   └── index.ts       All repo classes + createPgRepos()
└── index.ts           Public exports
```

Depends on [`@chatman-media/sales`](https://github.com/chatman-media/sales) for repo interfaces and domain types (`SelfPlayMatchRecord`, `SkillAggregate`, `SkillRow`, …).

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string — used by drizzle-kit CLI commands |

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle `src/index.ts` → `dist/` with type declarations |
| `npm run typecheck` | TypeScript type check without emitting |
| `npm run check` | Lint source with Biome |
| `npm run format` | Auto-format source with Biome |
| `npm run db:generate` | Generate Drizzle migration files from schema changes |
| `npm run db:migrate` | Apply pending migrations to the database |
| `npm test` | Run tests with bun |

## Migrations

```bash
# After changing src/schema.ts, generate a new migration:
npm run db:generate

# Apply all pending migrations:
DATABASE_URL=postgres://... npm run db:migrate
```

Migration files are written to `./migrations/` and tracked in version control.

---

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)
