# Roadmap

This file lists work that is *not yet started*. For shipped work, see [CHANGELOG.md](../CHANGELOG.md).

---

## Tier 3 — high impact, high complexity

### Tool calling for live data (rates, schedules, slot availability)

**Why:** the KB is static — exchange rates, flight prices, current openings drift. The bot lies confidently with stale data.

**How:** define typed tools (JSON Schema) for `get_current_rate(from, to)`, `list_open_slots(country, date)`, etc. Use OpenRouter / OpenAI function-calling protocol. Gate behind `BOT_TOOLS=true`.

**Estimated lift:** opens the door to real-time data without re-ingesting KB.

### Specialized sub-agents (researcher, qualifier, closer)

**Why:** when the conversation forks (qualify a candidate AND answer a visa question AND propose a slot), one monolithic LLM call has to do all of it.

**How:** introduce a thin orchestrator that routes to one of N sub-prompts based on intent. Each sub-prompt is short and focused. State is shared via the existing `messages` table.

**Estimated lift:** cleaner separation of concerns; per-agent A/B testing becomes possible.

### Online evaluation harness

**Why:** there's no automated quality dashboard. Regressions land silently.

**How:** capture a small golden set of (question, expected-fact) pairs from past good conversations. Replay them nightly on the current build. Alert on regressions in retrieval recall, fact groundedness, persona consistency.

**Estimated lift:** the difference between "I think it got worse?" and "groundedness dropped from 92% to 78% on commit X."

---

## Recommended turn-on order in production

Applies to the six [RAG layers](RAG_LAYERS.md) (all default OFF).

1. **Day 1:** turn on `RAG_HYBRID_SEARCH=true`. No LLM cost, no extraction quality risk — pure retrieval upgrade.
2. **Week 1:** turn on `RAG_USER_MEMORY=true`. Watch `users.profile_json.memory.facts` for a week.
3. **Week 2:** turn on `RAG_QUERY_REWRITE=true`. Compare reply quality on follow-up questions before/after.
4. **Week 3:** turn on `RAG_REFLECT=true`. Expect a small uptick in NO_CONTEXT (silent) turns — that's the feature working.
5. **Month 2+:** `RAG_CONVERSATION_SUMMARY` once conversations get long enough to need it; `RAG_TOPIC_ROUTING` once the KB is large enough to need partitioning.

Avoid Tier 3 until the RAG layers above are exhausted — they're what production sales platforms have, but at 10× the maintenance cost.
