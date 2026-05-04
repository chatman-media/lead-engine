# Architecture roadmap

## What just landed

Five layers were added on top of the existing RAG+persona+funnel pipeline. All are **opt-in via env flags** — defaults are off so existing deployments are unaffected.

| Feature | Env flag | What it does | Cost per turn |
|---------|----------|--------------|---------------|
| Cross-session memory | `RAG_USER_MEMORY=true` | Extracts candidate facts (name, city, age, intent…) into `users.profile_json.memory.facts`, injects on next turn | +1 LLM call (async, after reply) |
| Query rewriting | `RAG_QUERY_REWRITE=true` | Rewrites elliptical/follow-up questions ("а там?") into self-contained search queries before vector retrieval | +1 LLM call only on flagged turns (~20–30%) |
| Reflection | `RAG_REFLECT=true` | After generation, verifies every fact in the answer is grounded in CONTEXT; ungrounded answers become `NO_CONTEXT_MARKER` (silent) | +1 LLM call on grounded turns |
| Hybrid retrieval | `RAG_HYBRID_SEARCH=true` | BM25 (FTS5) + vector + RRF fusion; catches exact-match queries (numbers, proper nouns) that pure embeddings misrank | 0 extra LLM calls (1 extra SQL FTS5 query) |
| Conversation summarization | `RAG_CONVERSATION_SUMMARY=true` | Compresses old turns of long chats into a paragraph stored in `conversations.summary_json`, injected as "ИЗ РАННЕЙ ПЕРЕПИСКИ" | +1 LLM call only when summary is stale (every ~8 messages on long chats) |

All five default OFF — turn on one at a time and watch metrics on a small slice of traffic before enabling globally.

### Files added
- [`src/rag/extract-user-facts.ts`](src/rag/extract-user-facts.ts) — fact-extraction LLM wrapper
- [`src/rag/rewrite-query.ts`](src/rag/rewrite-query.ts) — query-rewriting LLM wrapper + heuristic gate
- [`src/rag/reflect.ts`](src/rag/reflect.ts) — post-generation verifier
- [`migrations/005_kb_fts.sql`](migrations/005_kb_fts.sql) — FTS5 virtual table + sync triggers + backfill

### Files extended
- [`src/db/repos/users.ts`](src/db/repos/users.ts) — `getMemory` / `mergeMemoryFacts` on `profile_json.memory`
- [`src/db/repos/kb.ts`](src/db/repos/kb.ts) — `searchBm25` / `hybridSearch` + `sanitizeFtsQuery` + `reciprocalRankFusion`
- [`src/rag/answer.ts`](src/rag/answer.ts) — `userFacts`, `rewriteQueryBeforeRetrieval`, `reflect`, `hybridSearch` flags + `renderUserFactsBlock` helper
- [`src/sales/prompt.ts`](src/sales/prompt.ts) — reuses `renderUserFactsBlock` for the sales-style path
- [`src/telegram/webhook.ts`](src/telegram/webhook.ts) — wires memory before RAG, runs extraction after reply
- [`src/config.ts`](src/config.ts) — five new env flags
- [`src/index.ts`](src/index.ts) — passes flags into `RagDeps`

---

## Next steps, ranked by ROI

### Tier 1 — high impact, low complexity

#### ~~1. Hybrid retrieval (BM25 + vector + RRF fusion)~~ ✅ done
Migration 005 added FTS5 + sync triggers; `KbRepo.hybridSearch` does RRF fusion over vector + BM25; opt-in via `RAG_HYBRID_SEARCH=true`. Note: FTS5 prefix matching is forward-only — Russian morphology is partially covered (query "виз" hits "виза"/"визу"/"визой", but reverse direction needs a stemmer). The vector side bridges this gap end-to-end.

#### ~~2. Memory-aware fact extraction (don't re-extract known data)~~ ✅ done
[`runMemoryExtraction`](src/telegram/webhook.ts) hard-caps the slice at 16 messages tail (constant `MAX_EXTRACTION_SLICE`). The cursor still advances to the last RAW fresh message id (not the slice end) so skipped older messages don't re-enter on the next turn. Combined with the `existingFacts` parameter the LLM already sees, extraction cost is now O(1) per turn regardless of chat length.

#### ~~3. Operator-visible memory pane in admin UI~~ ✅ done
`MemoryPane` component on the chat page (collapsible, top of messages area). `PATCH /admin/api/users/:id/memory` writes operator-edited facts wholesale (no merge — operator is authoritative over extractor mistakes). `GET /admin/api/conversations/:id` now includes `memory` field. Files: [`admin-ui/src/components/MemoryPane.tsx`](admin-ui/src/components/MemoryPane.tsx), [`src/admin/api.ts`](src/admin/api.ts) (`createUpdateUserMemoryHandler`), [`src/db/repos/users.ts`](src/db/repos/users.ts) (`setMemoryFacts`).

---

### Tier 2 — medium impact, medium complexity

#### ~~4. Per-message confidence telemetry~~ ✅ done
`AnswerResult.telemetry` ([src/rag/answer.ts](src/rag/answer.ts)) — every turn captures `path` (smalltalk / persona_fact / no_context / ungrounded / ok), `total_ms` / `retrieval_ms` / `generation_ms`, `top_distances` (top-k KB hit distances rounded to 4dp), `hybrid` flag, `original_query` + `rewritten_query` when rewrite changed the search query, `reflect` verdict + reason. Webhook persists this in `messages.meta_json.telemetry` alongside `used_chunk_ids`. Admin UI: DEBUG toggle in chat header reveals a one-line `TelemetryStrip` under each assistant message — color-coded by path (green=ok, amber=no_context, red=ungrounded).

#### ~~5. Conversation summarization (token budget for long chats)~~ ✅ done
Migration 006 adds `conversations.summary_json`. [`summarizeConversation`](src/rag/summarize-conversation.ts) compresses old turns into a paragraph; webhook reads stored summary into the system prompt as "ИЗ РАННЕЙ ПЕРЕПИСКИ:" and refreshes lazily after each reply (fire-and-forget). Thresholds: kicks in past 30 total messages, refreshes when 8 messages drift past the last summarized id, refines existing summary instead of regenerating from scratch. Opt-in via `RAG_CONVERSATION_SUMMARY=true`.

#### 6. Multi-vector retrieval (separate KB indexes per topic)
**Why now:** one global KB for visa info + payment info + city info means embeddings are crowded. Topic-specific routing reduces noise.
**How:** tag KB documents at ingest time (`source: "visa"`, `source: "payment"`). At query time, classify the question (regex or small LLM) and search only the relevant index.
**Estimated lift:** +5–15% precision; faster too (smaller indexes).

---

### Tier 3 — high impact, high complexity (revisit later)

#### 7. Tool calling for live data (rates, schedules, slot availability)
**Why now:** the KB is static — exchange rates, flight prices, current openings drift. The bot lies confidently with stale data.
**How:** define typed tools (JSON Schema) for `get_current_rate(from, to)`, `list_open_slots(country, date)`, etc. Use OpenRouter / OpenAI function-calling protocol. Gate behind `BOT_TOOLS=true`.
**Estimated lift:** opens the door to real-time data without re-ingesting KB.

#### 8. Specialized sub-agents (researcher, qualifier, closer)
**Why now:** when the conversation forks (qualify a candidate AND answer a visa question AND propose a slot), one monolithic LLM call has to do all of it. Specialized agents handle each concern with sharper system prompts.
**How:** introduce a thin LangGraph-style state machine: an orchestrator routes to one of N sub-prompts based on intent. Each sub-prompt is short and focused. State is shared via the existing `messages` table.
**Estimated lift:** cleaner separation of concerns; per-agent A/B testing becomes possible.

#### 9. Online evaluation harness
**Why now:** there's no automated quality dashboard. Regressions land silently.
**How:** capture a small "golden set" of (question, expected-fact) pairs from past good conversations. Replay them nightly on the current build. Alert on regressions in retrieval recall, fact groundedness, persona consistency.
**Estimated lift:** the difference between "I think it got worse?" and "groundedness dropped from 92% to 78% on commit X."

---

## Recommended turn-on order in production

1. **Day 1:** turn on `RAG_HYBRID_SEARCH=true`. No LLM cost, no extraction quality risk — pure retrieval upgrade. Compare top-3 hit quality on a sample of past conversations vs vector-only.
2. **Week 1:** turn on `RAG_USER_MEMORY=true`. Watch `users.profile_json.memory.facts` for a week — sanity check that extraction is sane on your traffic.
3. **Week 2:** add admin UI for memory (Tier 1 #3) so operators can correct extraction errors.
4. **Week 3:** turn on `RAG_QUERY_REWRITE=true`. Compare reply quality on follow-up questions before/after.
5. **Week 4:** turn on `RAG_REFLECT=true`. Expect a small uptick in NO_CONTEXT (silent) turns — that's the feature working. Adjust prompt or model if too aggressive.
6. **Month 2+:** Tier 2 items as quality plateaus (telemetry first, then summarization, then multi-vector).

Avoid Tier 3 until Tier 1+2 are exhausted — they're what production sales platforms have, but at 10× the maintenance cost. Your current scale (one Telegram bot, single funnel) doesn't need them yet.
