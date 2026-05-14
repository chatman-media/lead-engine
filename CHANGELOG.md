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

## RAG layers — 6 opt-in flags

All six default OFF. Detail in [docs/RAG_LAYERS.md](docs/RAG_LAYERS.md).

| Feature | Env flag | What it does |
|---|---|---|
| Cross-session memory | `RAG_USER_MEMORY=true` | Extracts candidate facts into `users.profile_json.memory.facts`, injects on next turn |
| Query rewriting | `RAG_QUERY_REWRITE=true` | Rewrites elliptical follow-ups ("а там?") into self-contained search queries |
| Reflection | `RAG_REFLECT=true` | Post-generation grounding check; ungrounded answers become NO_CONTEXT |
| Hybrid retrieval | `RAG_HYBRID_SEARCH=true` | BM25 + vector + RRF fusion |
| Conversation summarization | `RAG_CONVERSATION_SUMMARY=true` | Compresses old turns into a paragraph stored in `conversations.summary_json` |
| Topic-routed retrieval | `RAG_TOPIC_ROUTING=true` | Regex topic classifier filters KB search by `kb_documents.topic` |

## Observability

- Per-message telemetry in `messages.meta_json.telemetry` (path, ms, top_distances, hybrid, rewrite, reflect verdict, topic).
- Admin UI `TelemetryStrip` per assistant message — color-coded by path.
- Coach proposals + skill A/B router + pairwise self-play with judge.

## Lead pipeline — 5 phases

The end-to-end lead workflow (intake → approval → docs collection → consulate handoff). Detail in [docs/LEADS.md](docs/LEADS.md).

| Phase | What landed |
|---|---|
| 1 | Lead state machine + approval gate (inline buttons in TG) + visa-anketa templates + admin Leads page |
| 2 | Auto-intake detection (LLM for text fields + SQL for media counts) → auto-promote · submit-to-visa with `application_id` |
| 3 | Visa-docs auto-extraction (27-field schema) + admin inline editor |
| 4 | Operator relay via reply-to-card (text / photo / video / document → candidate DM) |
| 5 | Docker / docker-compose / DEPLOY.md |

## Admin UI

- `/admin/status` dashboard
- `/admin/vacancies` CRUD (RAG-prepended)
- `MemoryPane` / `SummaryPane` / `TelemetryStrip` on chat page
- `/admin/kb` browser + editor (topic filter, retag, cascade-delete)
- Persona personal-facts (city/age/status/phone) deterministic short-circuit
- Smalltalk-tail variation
