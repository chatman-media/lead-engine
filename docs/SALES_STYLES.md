# Sales-style engine

Pluggable conversational personas with sales frameworks, Cialdini hooks, per-stage guidance, and few-shot anchoring. Composed into a system prompt at runtime, with KB-grounded RAG for facts.

Originally prototyped in the sister `sales-guru` repo, ported into this codebase under `src/sales/`. Two activation modes:

| Mode | What | When |
|---|---|---|
| **Single forced style** | `BOT_SALES_STYLE=<slug>` env → all conversations use that style | demo, QA, single-persona deploy |
| **Per-conversation A/B** | running row in `experiments` table → each conversation gets a deterministic variant | actually testing which persona converts best |
| **Off (legacy)** | neither set → bot uses the env-based `BOT_PERSONA_*` persona prompt | default for back-compat |

## TL;DR — turn it on

**Quick (single style for everyone):**

```bash
# .env
BOT_SALES_STYLE=flirty-belfort-v1
```

**Real A/B (different users get different styles):**

```sql
-- one row, one query, restart not needed
INSERT INTO experiments (slug, status, allocation_json, started_at)
VALUES (
  'april-2026-recruit',
  'running',
  '{"flirty-belfort-v1": 50, "empathetic-nepq-v1": 25, "cold-direct-pas-v1": 25}',
  unixepoch()
);
```

In both modes you can revert by unsetting the env var or `UPDATE experiments SET status='paused'`. Existing conversations keep their assigned style — no mid-flight reshuffles.

## Built-in styles

| slug | persona | framework | tone |
|---|---|---|---|
| `flirty-belfort-v1` | Алина — флирт-рекрутер | Belfort Straight Line | тёплый, дерзкий, короткие реплики, комплименты |
| `empathetic-nepq-v1` | Маша — эмпатичный консультант | NEPQ | спокойный, low-pressure, neuro-emotional questions |
| `cold-direct-pas-v1` | Игорь — прямой PAS | PAS (Problem-Agitate-Solve) | сухой, без воды, без эмодзи |

Source: [`src/sales/styles/`](../src/sales/styles/). Each file is a Zod-validated TypeScript object — type-safe by construction, easy to read, easy to copy when authoring new styles.

## Mental model

A `Style` is the unit of A/B testing. Four orthogonal concerns get bundled together:

1. **Persona** — who speaks (name, role, company, voice).
2. **Sales framework** — what conversation structure (AIDA / PAS / SPIN / NEPQ / Belfort Straight Line).
3. **Hooks** — which Cialdini levers are deployed (social proof, scarcity, authority, liking, reciprocity, commitment).
4. **Stage** — where in the funnel we are (opener → qualify → pitch → objection → close).

Holding three constant and rotating one is what makes the A/B comparable.

## How a turn flows

1. Telegram POST → [`src/telegram/webhook.ts`](../src/telegram/webhook.ts) `createWebhookHandler`.
2. Persist user message, dedupe by `tg_message_id`, load conversation row.
3. **Resolve style** via `resolveStyle()` — priority:
   - `BOT_SALES_STYLE` env override (forces a single style)
   - existing `conversations.style_id` (sticky per-conversation assignment)
   - running experiment + `pickVariant()` → assigns and persists `style_id`
   - none → legacy `BOT_PERSONA_*` path
4. **Compute stage** via [`src/sales/stage-router.ts`](../src/sales/stage-router.ts) — Cyrillic-aware regex on user message + turn count + previous stage from `conversations.current_stage`. Persist new stage on conversation.
5. Call `answerWithRag({ question, ..., style, stage, includeFewShot })`.
6. [`src/rag/answer.ts`](../src/rag/answer.ts) embeds the question, runs vector search, formats `KB CONTEXT`.
7. **Branch:** if `style` was passed → [`composeSystemPrompt(style, stage, kbContext)`](../src/sales/prompt.ts). Else legacy `buildSystemPrompt(persona, context)`.
8. LLM call via existing `ChatClient` (Ollama or OpenAI) at the style's pinned `temperature`.
9. Reply sanitized (`<think>` blocks stripped, prefixes trimmed) and sent. Assistant message persisted with `stage` tag for funnel analytics.

## What gets composed into the system prompt

Up to 9 sections, separated by blank lines. Sections marked **conditional** are omitted when their input is empty:

| section | always | content |
|---|---|---|
| persona | ✓ | name, human/assistant role, bot-disclosure rule |
| voice | ✓ | tone, language, banned phrases |
| framework | ✓ | one-line blurb for AIDA / PAS / SPIN / NEPQ / Belfort |
| hooks | conditional | Cialdini modifiers as ammunition (social_proof, scarcity, …) |
| stage | ✓ | current stage uppercase, goal, guidance, grounding requirement |
| KB grounding reminder | conditional | only when `groundingRequired: true` AND no KB hits found |
| guardrails | ✓ | no minors, forbidden topics, length limit |
| few-shot examples | conditional | first turn only — drops on follow-ups to save 200-500 tokens |
| KB context | conditional | top vector hits formatted as `[#1] Title\nText` blocks |

## Stage routing

Rule-based, zero LLM calls, predictable. Decision priority:

1. Message matches `objection` regex (`но`, `сомнев`, `боюсь`, `развод`, …) → `objection`.
2. Else matches `pricing` regex (`сколько`, `гонорар`, `виза`, `комисси`, …) → `pitch`.
3. Else matches `agreement` regex AND we're in `qualify`/`pitch`/`objection` → `close`.
4. Else turn 1 → `opener`. Else opener → `qualify`. Else stay in `currentStage`.

⚠️ Cyrillic regex caveat: JS `\b` is ASCII-only, so the routes use explicit Unicode delimiters `[^\p{L}\p{N}]` with the `u` flag. Reverting to `\b` silently breaks every Russian regex. There's a regression test in [`tests/unit/sales/stage-router.test.ts`](../tests/unit/sales/stage-router.test.ts) for this.

## A/B routing (Phase 2a — shipped)

[`src/sales/ab-router.ts`](../src/sales/ab-router.ts) ships a deterministic `pickVariant(experiment, userId)`:

- Same `(experiment.slug, userId)` always returns the same `styleSlug` — sticky across restarts, sticky if the prospect comes back tomorrow.
- Distribution proportional to integer weights.

Wired into the webhook: when an experiment is in `status='running'`, every NEW conversation gets allocated on its first inbound message. The `style_id` and `experiment_id` are persisted on the conversation row, so subsequent turns are deterministic — no chance of a prospect seeing a different persona because of a process restart or load-balancer hop.

### DB schema (migration `003_sales_styles_and_experiments.sql`)

```sql
CREATE TABLE styles (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL,        -- full Style as JSON, validated by Zod
  is_active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  parent_id INTEGER REFERENCES styles(id),  -- version chain
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE experiments (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,              -- 'draft'|'running'|'paused'|'done'
  allocation_json TEXT NOT NULL,     -- {"flirty-v1": 50, "empathetic-v1": 50}
  success_metric TEXT NOT NULL,      -- 'qualified'|'won'|'replied_3+'
  started_at INTEGER, ended_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE conversations ADD COLUMN style_id INTEGER REFERENCES styles(id);
ALTER TABLE conversations ADD COLUMN experiment_id INTEGER REFERENCES experiments(id);
ALTER TABLE conversations ADD COLUMN current_stage TEXT;
ALTER TABLE messages ADD COLUMN stage TEXT;
```

### Boot-time seed

[`seedBuiltinStyles`](../src/db/repos/styles.ts) inserts each source-defined style into the DB on every server start, **idempotent on slug** — admin's edits in the table always win. Newly added builtins (added in source code after a deploy) get inserted on next boot.

### Style versioning

The `version` + `parent_id` chain lets the admin UI edit a live style by inserting a new row (version+1, parent_id = old.id) and marking the old one inactive. Conversations already running keep their `style_id` pointer to the old row, so the prompt they were assigned remains pinned for the lifetime of that chat. (UI for this is Phase 2b.)

### Failure modes — graceful degradation

- Malformed `experiments.allocation_json` → bot logs warning, falls back to legacy persona.
- Experiment references unknown style slug → same.
- `styles.config_json` fails Zod schema → throws with field-level error pointing at the offending row.

All three covered by [`tests/unit/sales/webhook-ab.test.ts`](../tests/unit/sales/webhook-ab.test.ts).

## Authoring a new style

Drop a new file into [`src/sales/styles/`](../src/sales/styles/):

```ts
// src/sales/styles/cold-empathy-v1.ts
import { StyleSchema, type Style } from "../types.ts";

export const coldEmpathy: Style = StyleSchema.parse({
  slug: "cold-empathy-v1",
  displayName: "Sasha — холодный эмпат",
  persona: { name: "Саша", role: "human", company: "ALINA Models" },
  voice: { tone: "...", language: "ru", forbid: [...] },
  framework: "SPIN",
  hooks: [{ kind: "authority", text: "..." }],
  stages: { opener: { goal: "..." }, /* ... */ },
  fewShot: [{ stage: "opener", user: "—", assistant: "..." }],
  guardrails: { noMinors: true, botDisclosureOnDirectQuestion: true, forbiddenTopics: [] },
  model: { id: "qwen3:latest", temperature: 0.6, maxTokens: 200 },
});
```

Then register in [`src/sales/styles/index.ts`](../src/sales/styles/index.ts):

```ts
import { coldEmpathy } from "./cold-empathy-v1.ts";
export const STYLES = [flirtyBelfort, empatheticNepq, coldDirectPas, coldEmpathy];
```

The Zod schema validates at module load — malformed styles fail fast with a helpful error rather than blowing up at request time.

## Models

[`src/sales/models.ts`](../src/sales/models.ts) is a registry of known-good models with metadata (provider, size, Russian quality, ~tok/s, recommendation). It's NOT a constraint on what you can run (the runtime accepts any string) — it's source data for a future admin UI dropdown.

Three provider categories represented:

- **Local Ollama** — `qwen3:latest`, `qwen3:14b`, `qwen2.5:7b`, `llama3.2:latest`, `gemma2:9b`, `moondream:v2`.
- **Ollama Cloud** — `qwen3.5:cloud`, `glm-4.6:cloud`. Same `OllamaChatClient` (HTTP API is identical), runs on Ollama's hosted GPUs. Solves CPU bottlenecks. Needs a paid Ollama subscription.
- **OpenRouter** — `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-4.6`, `openai/gpt-4o-mini`, `google/gemini-2.5-flash`. **Provider not yet wired into tg-chatbot** — would need a new `OpenRouterChatClient` implementing `ChatClient` (~80 LOC). Tracked in `sales-guru` repo as a reference implementation.

## Testing

`tests/unit/sales/` mirrors the source structure:

| file | what's tested | tests |
|---|---|---|
| `ab-router.test.ts` | Determinism, distribution, edge cases | 11 |
| `stage-router.test.ts` | Cyrillic regex regression, all transitions, precedence | 19 |
| `prompt.test.ts` | All sections, persona-role branching, few-shot toggle, KB block, grounding | 20 |
| `styles.test.ts` | All 3 sample styles + invariants + Zod rejection of bad input | 25 |
| `styles-repo.test.ts` | StylesRepo CRUD, parseRow with Zod validation, soft-delete, idempotent seed | 14 |
| `experiments-repo.test.ts` | ExperimentsRepo CRUD, getRunning, status transitions, allocation parsing | 17 |
| `webhook-ab.test.ts` | End-to-end A/B: assignment, stickiness, two users, malformed experiment graceful fallback | 6 |

Plus four integration tests in [`tests/unit/answer.test.ts`](../tests/unit/answer.test.ts) verifying that `answerWithRag` correctly branches between the legacy persona prompt and the sales-engine composed prompt.

Run: `bun test tests/unit`. The full unit suite is hermetic — no network, no live Ollama, no real DB beyond `:memory:`.

## Future work

- **Phase 2b — Admin UI** for `styles` and `experiments` tables: list, create, edit (with versioning via parent_id chain), playground (test a single message against a style without persisting), funnel-conversion dashboard. SQL aggregation already works against the existing schema; UI wraps it.
- **Phase 2c — OpenRouter provider** — add `OpenRouterChatClient` implementing the existing `ChatClient` interface. The model registry in `src/sales/models.ts` already lists Claude/GPT/Gemini entries; provider just needs wiring (~80 LOC). Enables per-style backbone choice.
- **Stage classifier upgrade** — replace regex `nextStage` with a haiku-class LLM classifier returning `{stage, confidence}`. Keep regex as fallback at confidence < 0.6.
- **Streaming replies** — switch the Ollama `/api/chat` call to SSE so partial replies show up as they're generated (helps UX on slow CPU inference).
- **Per-style memory** — `conversations.style_memory_json` for persona-specific facts (e.g. "this prospect's name is Anya, lives in Yekaterinburg") that survive across turns.
