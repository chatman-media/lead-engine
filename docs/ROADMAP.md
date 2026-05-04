# Architecture roadmap

## What just landed

Four layers were added on top of the existing RAG+persona+funnel pipeline. All are **opt-in via env flags** — defaults are off so existing deployments are unaffected.

| Feature | Env flag | What it does | Cost per turn |
|---------|----------|--------------|---------------|
| Cross-session memory | `RAG_USER_MEMORY=true` | Extracts candidate facts (name, city, age, intent…) into `users.profile_json.memory.facts`, injects on next turn | +1 LLM call (async, after reply) |
| Query rewriting | `RAG_QUERY_REWRITE=true` | Rewrites elliptical/follow-up questions ("а там?") into self-contained search queries before vector retrieval | +1 LLM call only on flagged turns (~20–30%) |
| Reflection | `RAG_REFLECT=true` | After generation, verifies every fact in the answer is grounded in CONTEXT; ungrounded answers become `NO_CONTEXT_MARKER` (silent) | +1 LLM call on grounded turns |
| Hybrid retrieval | `RAG_HYBRID_SEARCH=true` | BM25 (FTS5) + vector + RRF fusion; catches exact-match queries (numbers, proper nouns) that pure embeddings misrank | 0 extra LLM calls (1 extra SQL FTS5 query) |

All four default OFF — turn on one at a time and watch metrics on a small slice of traffic before enabling globally.

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
- [`src/config.ts`](src/config.ts) — four new env flags
- [`src/index.ts`](src/index.ts) — passes flags into `RagDeps`

---

## Next steps, ranked by ROI

### Tier 1 — high impact, low complexity

#### ~~1. Hybrid retrieval (BM25 + vector + RRF fusion)~~ ✅ done
Migration 005 added FTS5 + sync triggers; `KbRepo.hybridSearch` does RRF fusion over vector + BM25; opt-in via `RAG_HYBRID_SEARCH=true`. Note: FTS5 prefix matching is forward-only — Russian morphology is partially covered (query "виз" hits "виза"/"визу"/"визой", but reverse direction needs a stemmer). The vector side bridges this gap end-to-end.

#### 2. Memory-aware fact extraction (don't re-extract known data)
**Why now:** the current extractor sees ALL messages each run. After 50 messages it re-confirms the same facts every turn.
**How:** the `lastExtractedFromMsgId` cursor is already in place — pass only the slice since the cursor to the extractor (already done in webhook). Add a hard cap on slice size (last 8 messages max) so the extraction call stays cheap on long chats.
**Estimated lift:** ~70% cheaper extraction on long conversations, same accuracy.

#### ~~3. Operator-visible memory pane in admin UI~~ ✅ done
`MemoryPane` component on the chat page (collapsible, top of messages area). `PATCH /admin/api/users/:id/memory` writes operator-edited facts wholesale (no merge — operator is authoritative over extractor mistakes). `GET /admin/api/conversations/:id` now includes `memory` field. Files: [`admin-ui/src/components/MemoryPane.tsx`](admin-ui/src/components/MemoryPane.tsx), [`src/admin/api.ts`](src/admin/api.ts) (`createUpdateUserMemoryHandler`), [`src/db/repos/users.ts`](src/db/repos/users.ts) (`setMemoryFacts`).

---

### Tier 2 — medium impact, medium complexity

#### 4. Per-message confidence telemetry
**Why now:** when the bot starts giving worse answers, there's no signal to localize the regression — retrieval, generation, or reflection?
**How:** persist per-turn metrics in `messages.meta_json`: top-k distances, query-rewrite delta, reflection verdict + reason, latency per stage. Expose in the admin conversation view as a debug panel.
**Estimated lift:** quality regressions become diagnosable in minutes instead of hours.

#### 5. Conversation summarization (token budget for long chats)
**Why now:** `recentForContext(conv.id, 12)` is a fixed window. Once a conversation is 50+ messages, the LLM loses context from turns 1–38. The user-memory layer covers facts but not nuance ("we discussed apartment options last week").
**How:** when conversation length crosses a threshold (e.g. 30 messages), summarize messages 1..N-12 into a single "PRIOR DISCUSSION SUMMARY" string. Store in `conversations.summary_json`. Re-summarize in background when stale.
**Estimated lift:** quality stops degrading on long chats; tokens-per-turn stays bounded.

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
