# Bot → packages migration plan

Migrate `apps/bot` to consume `@chatman-media/rag` and `@chatman-media/sales`
as workspace packages, deleting the bot's duplicated RAG/sales-engine code.
This is the final step that removes the rag/sales duplication for good.

## Context

The monorepo `lead-engine` holds `apps/bot`, `apps/admin-ui`, and
`packages/{rag,sales,storage}`. The three packages were vendored from the
standalone repos; `apps/bot` kept its **own** `src/rag` and `src/sales`,
which had diverged from the packages.

The packages have already been **reconciled to the bot's canonical logic**
(commits `cdffdcb..e597b37` on `lead-engine` main): fail-closed fact-checker,
hoisted sanitize helpers, ingest `source/title` overrides, support mode,
grounding-exempt stages, `generateSoftFallback`, the `vision` module, etc.

So the packages are now correct. What remains: point the bot at them and
delete its copies. **The bot is production code (1258 unit tests, 17 e2e).**

## Verified facts (don't re-investigate)

- **`KbRepo` structurally satisfies `IKbStore`** — no adapter needed.
  `apps/bot/src/db/repos/kb.ts` already has `search`, `hybridSearch`,
  `prioritySearch`, `getDocumentBySource`, `countChunksForDocument`,
  `deleteDocument`, `upsertDocument`, `insertChunkWithEmbedding`.
- The bot's `KbSearchHit` (`db/repos/kb.ts`) is **byte-identical** to the
  package's `KbSearchHit`. `KbDocumentRow` is assignable to the package's
  `{ id, content_hash }` return shape.
- Every rag/sales symbol the bot imports **is exported** from the package
  index (`answerWithRag`, `generateSoftFallback`, `OpenAIChatClient`,
  `OllamaChatClient`, `OpenRouterChatClient`, `NullEmbeddingClient`,
  `OpenAIEmbeddingClient`, `ingestText/File/Directory`, `gradeSkills`,
  `extractUserFacts`, `summarizeConversation`, `classifyPhoto`,
  `extractPassportIdentity`, `PHOTO_CLASSES`, `Persona`, `ChatClient`,
  `ChatMessage`, `EmbeddingClient`, `sanitizeLlmOutput`, `buildSystemPrompt`,
  `NO_CONTEXT_MARKER`; from sales: `composeSystemPrompt`, `Style`,
  `FunnelStage`, `elo`, `ab-router`, `stage-router`, `stage-classifier`,
  `coach`, `shadow-eval`, `skill-recommendations`, `self-play/*`,
  `skills/catalogue`).
- `apps/bot/src/rag/vacancy-guard.ts` is **dead code** (not imported
  anywhere). Delete it; do not migrate.
- Imports are both relative (`../rag/x.ts`, `./sales/x.ts` in `src/`) and
  `@/` alias (`@/rag/...`, `@/sales/...` in `tests/`). The `@/*` → `src/*`
  alias in `tsconfig.json` stays (still used for `@/db`, `@/admin`, …).

## Prerequisite

Add the workspace deps to `apps/bot/package.json`:

```json
"dependencies": {
  "@chatman-media/rag": "workspace:*",
  "@chatman-media/sales": "workspace:*",
  ...
}
```

Then `bun install` at the monorepo root so the symlinks resolve.

---

## Phase 1 — RAG

### 1.1 Rewrite rag imports → `@chatman-media/rag`

42 import lines across these `src/` files (relative paths):
`src/sales/{stage-classifier,prompt,coach,shadow-eval}.ts`,
`src/sales/self-play/{judge,pairwise,orchestrator}.ts`,
`src/leads/{intake,visa-docs}.ts`, `src/admin/shared.ts`,
`src/admin/routes/{status,kb-documents,styles,ops,kb-suggestions,library}.ts`,
`src/telegram/{photo-hooks,process-inbound,userbot-process,userbot,webhook-types,memory-extraction,lead-hooks,summary-refresh}.ts`,
`src/db/repos/messages.ts`.

Transform: any `from "<…>/rag/<file>.ts"` (including `rag/providers/*`) →
`from "@chatman-media/rag"`. Multiple imports from the same package in one
file are fine — run `biome check --write` afterwards to merge/sort them.

(The `src/sales/*` engine files here get deleted in Phase 2; rewriting their
rag imports first just keeps typecheck green between phases.)

Also rewrite `@/rag/*` imports in any **surviving** test files (see triage).

### 1.2 Delete the bot's RAG copy

- `rm -rf apps/bot/src/rag/` (21 files).
- Delete RAG-engine unit tests from `apps/bot/tests/unit/` — these are now
  covered by `packages/rag/test/` (148 tests). Candidates (verify each only
  imports rag-engine modules, not bot wiring):
  `answer.test.ts`, `chunk.test.ts`, `chat-client.test.ts`,
  `embeddings.test.ts`, `extract-user-facts.test.ts`, `ollama-chat.test.ts`,
  `ollama-embed.test.ts`, `openrouter-chat.test.ts`,
  `persona-shortcuts.test.ts`, `reflect.test.ts`, `rewrite-query.test.ts`,
  `sanitize.test.ts`, `summarize-conversation.test.ts`,
  `system-prompt.test.ts`, `text-style-rules.test.ts`,
  `topic-classifier.test.ts`, `vision.test.ts`, `ingest.test.ts`,
  `vacancy-guard.test.ts` (dead code).
- **Keep** (bot wiring / DB layer, retarget their imports): `hybrid-search.test.ts`
  (tests `KbRepo`), `kb-management.test.ts`, `webhook-rag.test.ts`,
  `webhook*.test.ts`, `summary-refresh.test.ts`, `memory-extraction.test.ts`,
  `media-turn.test.ts`, and anything importing `@/db`, `@/admin`, `@/telegram`.
  Rule of thumb: **delete** a test only if it imports *exclusively* rag-engine
  modules; **keep + retarget** if it touches bot modules.

### 1.3 Typecheck + fix fallout

`bun run --cwd apps/bot typecheck`. Expected fallout to fix:
- Call sites passing `kbRepo` to `answerWithRag` — should just work
  (`KbRepo`→`IKbStore`).
- `KbSearchHit` — keep importing from `db/repos/kb.ts` (identical shape) or
  switch to the package; pick one consistently.
- Any config value the bot's old rag read from `config` directly is now a
  param on the package API — pass it at the call site.
- `ChatClient` / `OpenAIChatClient` constructor option shapes — the package's
  `chat.ts` is a superset; verify constructor args still match.

### 1.4 Verify

`bun run --cwd apps/bot typecheck && check && test`, then e2e
(`docker run pgvector`, see prior session). Commit:
`refactor(bot): consume @chatman-media/rag, drop src/rag`.

---

## Phase 2 — SALES

### 2.1 What stays vs goes

`apps/bot/src/sales/` splits in two:

- **DELETE (engine — now in `@chatman-media/sales`):** `ab-router.ts`,
  `coach.ts`, `elo.ts`, `models.ts`, `prompt.ts`, `shadow-eval.ts`,
  `skill-recommendations.ts`, `stage-classifier.ts`, `stage-router.ts`,
  `types.ts`, `self-play/` (judge, orchestrator, pairwise, personas),
  `skills/catalogue.ts`.
- **KEEP (bot-specific style DATA, not in the package):**
  `src/sales/styles/` — `alina-infinity.ts` is the bot's production style;
  the package only ships the generic `marina-prime`. Keep `styles/` and its
  index. Retarget their `Style`/`StyleSchema`/`FunnelStage` imports from
  `../types.ts` → `@chatman-media/sales`.

  > Decision needed: confirm `marina-prime` (package) is fine to leave as a
  > generic example and `alina-infinity` stays bot-side, OR consolidate.

### 2.2 Rewrite sales imports → `@chatman-media/sales`

~32 import lines. Symbols: `composeSystemPrompt`, `ComposeOptions`,
`SkillForPrompt`, `Style`, `FunnelStage`, `elo`, `ab-router`, `stage-router`,
`stage-classifier`, `coach`, `shadow-eval`, `skill-recommendations`,
`self-play/personas`, `self-play/pairwise`, `skills/catalogue`. All exported
from `@chatman-media/sales`. Affected: `src/db/repos/{styles,skills,
self-play-matches,pairwise-matches,shadow-evaluations,skill-outcomes,
coach-proposals,experiments,messages}.ts`, `src/admin/routes/{coach,pairwise,
self-play,shadow-eval,skills,styles}.ts`, `src/index.ts`,
`src/telegram/process-inbound.ts`, `src/leads/outcome-attribution.ts`, etc.

### 2.3 store.ts interface bridge

`@chatman-media/sales` self-play / shadow-eval / coach take **DI store
interfaces** (`ISelfPlayMatchesRepo`, `IPairwiseMatchesRepo`,
`IShadowEvaluationsRepo`, `ISkillsRepo`, `IStyleRatingsRepo`, …). The bot's
concrete `src/db/repos/*` must satisfy them. Per the earlier audit the
package interfaces are **narrower** than the bot's repos in places
(`insert` signatures missing `turns`/`fabricationsCaught`/`leadId`/
`eloAAfter/After`; shadow-eval method surface differs). Two options:
1. Widen the package's `store.ts` interfaces (and the package self-play that
   calls them) to carry the bot's columns — then the bot's repos satisfy
   them directly. Republish-equivalent change inside the monorepo.
2. Write thin adapters in the bot mapping concrete repos → package interfaces.

Recommend **(1)** — keeps one source of truth — but it edits package code,
so re-verify `packages/sales` tests (115) after.

### 2.4 Delete sales engine + tests

- Delete the engine files listed in 2.1.
- Delete `apps/bot/tests/unit/sales/` engine tests (`ab-router`, `prompt`,
  `stage-router`, …) — covered by `packages/sales/src/__tests__/` (115
  tests). **Keep** `styles.test.ts` if it tests the bot's `alina-infinity`
  data — retarget it.

### 2.5 Verify

`typecheck && check && test`, e2e, `bun run build:packages`. Commit:
`refactor(bot): consume @chatman-media/sales, drop src/sales engine`.

---

## Final verification

1. `bun install` at root — clean.
2. `bun run --cwd apps/bot typecheck` / `check` / `test` — green
   (test count drops: rag/sales-engine tests moved to packages).
3. `bun run build:packages` — rag → sales → storage build.
4. e2e: `docker run pgvector`, `bun run --cwd apps/bot test:e2e` — 17 pass.
5. `docker compose -f apps/bot/docker-compose.yml build app` — image builds.
6. `grep -rE 'from "(\.\./|\./|@/)+(rag|sales)/' apps/bot/src apps/bot/tests`
   returns nothing — no stale internal imports.

## Risk notes

- Production bot — keep changes reviewable; commit Phase 1 and Phase 2
  separately so each is independently test-verified.
- The `src/sales/styles/` keep-list is the subtle part — don't delete the
  bot's `alina-infinity` style data.
- `store.ts` interface widening (2.3) edits package code — re-run the
  package test suites after.
- Watch for config values the old in-bot rag/sales read from `config`
  directly: the package APIs are decoupled and expect them as params.
