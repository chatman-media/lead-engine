# @chatman-media/kb

[![npm version](https://img.shields.io/npm/v/@chatman-media/kb?logo=npm&color=22c55e)](https://www.npmjs.com/package/@chatman-media/kb)
[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Tenant-scoped Knowledge Base for the Lead Engine platform. Provides a full
retrieval-augmented generation (RAG) pipeline: hybrid search (pgvector cosine +
BM25 with RRF fusion), multi-query expansion, cross-encoder reranking, MMR
diversification, dynamic distance threshold, semantic caching, persona/skill
composition, photo classification and passport OCR.

LLM I/O lives in `@chatman-media/llm-router`.

## Key modules

| Module | What it does |
|---|---|
| `answer.ts` | Full RAG answer pipeline: retrieve → filter → diversify → rerank → generate |
| `ingest.ts` | Document ingest: parse → chunk → embed → upsert |
| `hybrid-search.ts` | pgvector cosine + BM25 keyword fusion via RRF |
| `retrieval-utils.ts` | `rrfMerge`, `applyDynamicThreshold`, `mmrDiversify` — post-retrieval transforms |
| `multi-query.ts` | `expandQueries` — LLM-generated query variants for parallel search |
| `reranker.ts` | `JinaReranker`, `CohereReranker` — cross-encoder second-pass reranking |
| `rewrite-query.ts` | Context-aware query rewriting (resolves pronouns / ellipsis via history) |
| `semantic-cache.ts` | Vector-similarity cache for identical/near-identical questions |
| `vision.ts` | `classifyPhoto()` + `extractPassportIdentity()` — passport OCR via vision LLM |
| `ab-router.ts` | A/B experiment allocation for styles/personas |
| `grade-skills.ts` | ELO-based skill grading via judge LLM |
| `prompt.ts` | `composeSystemPrompt()` — assemble sales persona + KB context + style |

## RAG pipeline

Each call to `answerWithRag` / `answerWithRagStream` goes through these stages:

```
1. [opt] Query rewrite     — resolves pronouns, expands ellipsis (rewriteQueryBeforeRetrieval)
2. [opt] Multi-query       — generate N variants → embed all in parallel (multiQuery)
3. Vector / hybrid search  — pgvector cosine or RRF(vector+BM25)
4. [opt] RRF merge         — fuse N result lists if multi-query was used (rrfMerge)
5. [opt] Distance filter   — drop hits > threshold (autoTrimDistance)
6. [opt] MMR diversify     — reduce duplicate chunks (mmr)
7. [opt] Cross-encoder     — reranker.rerank(query, candidates, topK) (reranker)
8. Prompt composition      — style + persona + context + skills + hooks
9. LLM generation          — stream or single response
10.[opt] Fact-checker      — hallucination guard (reflect)
```

All stages are optional and controlled per-request via `AnswerInput` fields.

## API

### `answerWithRag(input: AnswerInput): Promise<AnswerResult>`

```ts
import { answerWithRag, JinaReranker } from "@chatman-media/kb";

const result = await answerWithRag({
  question: "сколько стоит квартира в ЖК Марина?",
  kb,           // IKbStore implementation
  embedder,     // EmbeddingClient
  chat,         // ChatClient

  // ── Retrieval tuning ──────────────────────────────
  topK: 5,                        // final chunks to pass to the LLM
  hybridSearch: true,             // vector + BM25 fusion
  rewriteQueryBeforeRetrieval: true, // resolve "там" / "он" via history

  // Multi-query expansion (generate 2 rephrases, search 3 in parallel)
  multiQuery: true,
  multiQueryCount: 2,

  // Drop chunks with cosine distance > 0.45 (reduce hallucinations)
  autoTrimDistance: true,
  autoTrimThreshold: 0.45,

  // Maximal Marginal Relevance — diversify results
  mmr: true,
  mmrLambda: 0.6,               // 1.0 = pure relevance, 0.0 = pure diversity

  // Cross-encoder reranker (retrieves topK×3 candidates, returns topK)
  reranker: new JinaReranker({ apiKey: process.env.JINA_API_KEY! }),

  // ── Generation ────────────────────────────────────
  history,        // ChatMessage[] — conversation context
  persona,        // Persona — bot identity
  style,          // Style — sales methodology (SPIN / NEPQ / AIDA)
  stage,          // FunnelStage — current funnel stage
  skills,         // SkillForPrompt[] — active persuasion skills
  reflect: true,  // hallucination guard (LLM judge)

  onTelemetry: (t) => console.log(t), // retrieval_ms, top_distances, path, ...
});

console.log(result.text);         // generated reply
console.log(result.hits);         // KbSearchHit[] — chunks used
console.log(result.usedChunkIds); // chunk IDs referenced in the reply
```

### Rerankers

```ts
import { JinaReranker, CohereReranker } from "@chatman-media/kb";

// Jina — multilingual, good for Russian (jina-reranker-v2-base-multilingual)
const reranker = new JinaReranker({
  apiKey: process.env.JINA_API_KEY!,
  model: "jina-reranker-v2-base-multilingual", // default
});

// Cohere — also multilingual (rerank-v3.5)
const reranker = new CohereReranker({
  apiKey: process.env.COHERE_API_KEY!,
  model: "rerank-v3.5", // default
});
```

### Post-retrieval utilities

```ts
import { rrfMerge, applyDynamicThreshold, mmrDiversify } from "@chatman-media/kb";

// Merge results from multiple queries via Reciprocal Rank Fusion
const merged = rrfMerge([hitsFromQuery1, hitsFromQuery2, hitsFromQuery3], { topN: 15 });

// Drop hits with cosine distance > 0.4 (keep at least 1)
const trimmed = applyDynamicThreshold(hits, { threshold: 0.4, minHits: 1 });

// Maximal Marginal Relevance — diversify, reduce duplicates
const diverse = mmrDiversify(hits, { lambda: 0.6, topK: 5 });
```

### Vision

```ts
import { classifyPhoto, extractPassportIdentity } from "@chatman-media/kb";

const cls = await classifyPhoto({
  bytes: await res.arrayBuffer(),
  model: "gpt-4o",
  apiKey: "sk-...",
  provider: "openai",
});
// cls → "passport" | "full_body" | "portrait" | "other"

if (cls === "passport") {
  const identity = await extractPassportIdentity({ bytes, model, apiKey, provider });
  // identity → { family_name?, given_name?, passport_number?, passport_expiry? }
}
```

In `apps/api`, photo classification is wired automatically via `photo-processor.ts`:
when a tenant has a `vision` LLM config, every incoming photo is classified
and passport data is merged into `contact.attributes_json`.

## Install

```bash
bun add @chatman-media/kb     # Bun
npm install @chatman-media/kb # npm / pnpm / yarn
```

Part of the [**lead-engine**](https://github.com/chatman-media/lead-engine) monorepo — a multi-tenant SaaS platform for AI sales bots on Telegram / WhatsApp.

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)
