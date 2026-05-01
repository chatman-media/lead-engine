# Sales-style engine

Pluggable conversational personas with sales frameworks, Cialdini hooks, per-stage guidance, and few-shot anchoring. Composed into a system prompt at runtime, with KB-grounded RAG for facts.

Originally prototyped in the sister `sales-guru` repo, ported into this codebase under `src/sales/`. The Phase-1 integration is **opt-in via env flag** — the existing `BOT_PERSONA_*` path keeps working as the default.

## TL;DR — turn it on

```bash
# .env
BOT_SALES_STYLE=flirty-belfort-v1
```

That's it. Restart the server. The bot now uses the sales engine for every conversation. To revert: unset the variable.

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

1. Telegram POST → [`src/telegram/webhook.ts:62`](../src/telegram/webhook.ts) `createWebhookHandler`.
2. Persist user message, dedupe by `tg_message_id`, load conversation row.
3. Compute funnel **stage** via [`src/sales/stage-router.ts`](../src/sales/stage-router.ts) — Cyrillic-aware regex on user message + turn count.
4. Call `answerWithRag({ question, ..., style, stage, includeFewShot })`.
5. [`src/rag/answer.ts:106`](../src/rag/answer.ts) embeds the question, runs vector search, formats `KB CONTEXT`.
6. **Branch:** if `style` was passed → [`composeSystemPrompt(style, stage, kbContext)`](../src/sales/prompt.ts). Else legacy `buildSystemPrompt(persona, context)`.
7. LLM call via existing `ChatClient` (Ollama or OpenAI) at the style's pinned `temperature`.
8. Reply sanitized (`<think>` blocks stripped, prefixes trimmed) and sent.

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

## A/B routing (Phase 2 — not yet enabled)

[`src/sales/ab-router.ts`](../src/sales/ab-router.ts) ships with a deterministic `pickVariant(experiment, userId)`:

- Same `(experiment.slug, userId)` always returns the same `styleSlug`.
- Stable across process restarts.
- Distribution proportional to integer weights.

Not wired into `webhook.ts` yet — Phase 1 forces a single style for everyone via `BOT_SALES_STYLE`. To enable A/B in Phase 2 you'll need:

1. New tables `styles` and `experiments` (migration `003_*.sql`).
2. Column `conversations.style_id` set on first message.
3. Webhook calls `pickVariant(activeExperiment, user.tg_user_id)` and persists the assignment.
4. Admin UI to edit styles and experiments.

The shape is documented in `sales-guru/docs/ARCHITECTURE.md § tg-chatbot integration` (sister repo) — keep that around for reference until Phase 2 is shipped.

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

Plus four integration tests in [`tests/unit/answer.test.ts`](../tests/unit/answer.test.ts) verifying that `answerWithRag` correctly branches between the legacy persona prompt and the sales-engine composed prompt.

Run: `bun test tests/unit`. The full unit suite is hermetic — no network, no live Ollama, no real DB beyond `:memory:`.

## Future work

- **Phase 2** — DB-backed `styles` table + per-conversation A/B via `pickVariant`. Admin UI for CRUD + experiment dashboard.
- **Stage classifier upgrade** — replace regex stage router with a haiku-class LLM classifier (`{stage, confidence}`). Keep regex as fallback at low confidence.
- **OpenRouter provider** — add `OpenRouterChatClient` for cheap Claude/GPT/Gemini access alongside the existing Ollama path.
- **Streaming replies** — switch the Ollama `/api/chat` call to SSE so partial replies show up as they're generated (helps UX on slow CPU inference).
- **Per-style memory** — `conversations.style_memory_json` for persona-specific facts (e.g. "this prospect's name is Anya, lives in Yekaterinburg") that survive across turns.
