# Changelog

Notable feature work that has shipped. New items at the top.

## Reliability and operations

- **Audit log** for destructive admin endpoints (`kb.wipe`, `conversation.delete`, `lead.delete`, `user.gdpr_erase`, webhook delete, `purgeOutcomes`). Backed by `audit_log` table.
- **GDPR right-to-erasure** — `DELETE /admin/api/users/:id/data` cascades to conversations + leads, tombstones the user row, writes an audit entry.
- **Admin route helpers** (`withAdmin`, `parseIdParam`, `parseJsonBody`) — collapsed ~75 handlers across 19 route files.
- **Backup sidecar** + DEPLOY.md docs ([scripts/backup.sh](scripts/backup.sh)).
- **Rate limiting** — token bucket on `/telegram/<secret>` (60 burst, 30/sec) and `/admin/api/login` (10 burst, 0.5/sec).
- **`/metrics` endpoint** with Prometheus-style counters (`rag_kb_hits_total`, `admin_requests_total`, `tg_replies_total`, etc.).
- **`/health`** pings the DB before reporting OK.
- **Structured timeouts** — `AbortSignal.timeout` on every LLM client call.
- **PostgreSQL hardening** — `ON CONFLICT` on idempotent inserts, `FOR UPDATE SKIP LOCKED` in userbot queue claim, `FOR UPDATE` in lead state transitions.
- **Fact-checker fails closed** on LLM errors (was: returned ungrounded).

## RAG layers — 8 opt-in flags

All eight default OFF. Detail in [docs/RAG_LAYERS.md](docs/RAG_LAYERS.md).

| Feature | Env flag | What it does |
|---|---|---|
| Cross-session memory | `RAG_USER_MEMORY=true` | Extracts candidate facts into `users.profile_json.memory.facts`, injects on next turn |
| Query rewriting | `RAG_QUERY_REWRITE=true` | Rewrites elliptical follow-ups ("а там?") into self-contained search queries |
| Reflection | `RAG_REFLECT=true` | Post-generation grounding check; ungrounded answers become NO_CONTEXT |
| Hybrid retrieval | `RAG_HYBRID_SEARCH=true` | BM25 + vector + RRF fusion |
| Conversation summarization | `RAG_CONVERSATION_SUMMARY=true` | Compresses old turns into a paragraph stored in `conversations.summary_json` |
| Topic-routed retrieval | `RAG_TOPIC_ROUTING=true` | Regex topic classifier filters KB search by `kb_documents.topic` |
| Books priority | `RAG_BOOKS_PRIORITY=true` | Searches `topic=books` first; falls back to global KB on 0 hits |
| Skill grading | `RAG_SKILL_GRADING=true` | LLM identifies which skills were used in each reply (fire-and-forget; feeds ELO leaderboard) |

## Observability

- Per-message telemetry in `messages.meta_json.telemetry` (path, ms, top_distances, hybrid, rewrite, reflect verdict, topic).
- Admin UI `TelemetryStrip` per assistant message — color-coded by path.
- Coach proposals + skill A/B router + pairwise self-play with judge.

## Lead pipeline — 6 phases

The end-to-end lead workflow (intake → approval → docs collection → consulate handoff). Detail in [docs/LEADS.md](docs/LEADS.md).

| Phase | What landed |
|---|---|
| 1 | Lead state machine + approval gate (inline buttons in TG) + visa-anketa templates + admin Leads page |
| 2 | Auto-intake detection (LLM for text fields + SQL for media counts) → auto-promote · submit-to-visa with `application_id` |
| 3 | Visa-docs auto-extraction (32-field schema, 18 required) + admin inline editor |
| 4 | Operator relay via reply-to-card (text / photo / video / document → candidate DM) |
| 5 | Docker / docker-compose / DEPLOY.md |
| 6 | Reachable `submitted` stage — `mark-submitted` endpoint + "✅ подал" button (DMs the candidate her application id) · **support mode**: while a lead waits on the visa process (`docs_pending` / `submitted`) the bot answers questions calmly without selling and never auto-escalates · `docs_pending` stale-sweep cutoff extended to 30 days |

## Userbot (MTProto)

- **Photo handling**: incoming candidate photos downloaded via gramjs `downloadMedia`, saved to `config.media.dir`, recorded as `meta_json.media` with `source: "userbot"`. Vision classification fires in parallel — intake counters work identically to Bot API mode. (Fixes the gap where userbot mode silently dropped photos.)
- **MTProto proxy** (`USERBOT_MTPROXY_LIST`): newline-separated proxy list with auto-rotate on timeout. First working proxy wins; on full-list failure the subprocess restarts and re-reads env (hot-swap without redeploy). Accepted formats: `host:port:secret`, `tg://proxy?...`, `https://t.me/proxy?...`. Single-entry shorthand: `USERBOT_MTPROXY`.
- **Conversation source tag**: userbot conversations tagged `source=userbot` so funnel analytics distinguish userbot DMs from Bot API traffic.

## Admin UI

- `/admin/status` dashboard
- `/admin/vacancies` CRUD (RAG-prepended)
- `/admin/analytics` — per-message RAG telemetry aggregates (path breakdown, latency p50/p95/p99, topic distribution, no_context rate) over rolling windows 1h / 24h / 7d / 30d.
- `/admin/settings` — runtime settings editor: LLM model, temperature, all 8 RAG flags. Changes apply to next inbound message — no redeploy needed. Backed by `ADMIN_SETTINGS_ENV_FILE` or in-memory override.
- `/admin/users` — user list + detail: message count, last seen, lead state, memory editing, GDPR erasure (`DELETE /admin/api/users/:id/data`).
- `MemoryPane` / `SummaryPane` / `TelemetryStrip` on chat page
- `/admin/kb` browser + editor (topic filter, retag, cascade-delete)
- Persona personal-facts (city/age/status/phone) deterministic short-circuit
- Smalltalk-tail variation
