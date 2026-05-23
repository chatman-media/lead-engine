# @chatman-media/kb

[![npm version](https://img.shields.io/npm/v/@chatman-media/kb?logo=npm&color=22c55e)](https://www.npmjs.com/package/@chatman-media/kb)
[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Tenant-scoped Knowledge Base: hybrid retrieval (pgvector + BM25), ingest, answer pipeline, persona/skill composition, photo classification and passport OCR. LLM I/O lives in `@chatman-media/llm-router`.

## Key modules

| Module | What it does |
|---|---|
| `answer.ts` | RAG answer pipeline: retrieve → compose → stream |
| `ingest.ts` | Document ingest: parse → chunk → embed → upsert |
| `hybrid-search.ts` | pgvector cosine + BM25 keyword fusion |
| `vision.ts` | `classifyPhoto()` — photo → `"passport" \| "full_body" \| "portrait" \| "other"` via vision LLM; `extractPassportIdentity()` — OCR MRZ off a passport photo → `{ family_name, given_name, passport_number, passport_expiry }` |
| `ab-router.ts` | A/B experiment allocation for styles/personas |
| `grade-skills.ts` | ELO-based skill grading via judge LLM |
| `prompt.ts` | `composeSystemPrompt()` — assemble sales persona + KB context + style |

### Vision

```ts
import { classifyPhoto, extractPassportIdentity } from "@chatman-media/kb";

// Classify a photo from Telegram
const cls = await classifyPhoto({
  bytes: await res.arrayBuffer(),   // raw bytes from downloadMedia()
  model: "gpt-4o",
  apiKey: "sk-...",
  provider: "openai",               // "openai" | "openrouter"
});
// cls → "passport" | "full_body" | "portrait" | "other"

// If passport — OCR the MRZ
if (cls === "passport") {
  const identity = await extractPassportIdentity({ bytes, model, apiKey, provider });
  // identity → { family_name?, given_name?, passport_number?, passport_expiry? }
}
```

In `apps/api`, photo classification is wired automatically via `photo-processor.ts`:
when a tenant has a `vision` LLM config, every incoming photo is classified
and passport data is merged into `contact.attributes_json`.

Part of the [**lead-engine**](https://github.com/chatman-media/lead-engine) monorepo — a multi-tenant SaaS platform for AI sales bots on Telegram / WhatsApp.

## Install

```bash
bun add @chatman-media/kb     # Bun
npm install @chatman-media/kb # npm / pnpm / yarn
```

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)
