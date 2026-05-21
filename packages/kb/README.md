<div align="center">

<a name="top"></a>

# @chatman-media/rag

**Production-grade RAG engine for conversational bots**

[![npm version](https://img.shields.io/npm/v/@chatman-media/rag?logo=npm&color=22c55e)](https://www.npmjs.com/package/@chatman-media/rag)
[![CI](https://github.com/chatman-media/rag/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/rag/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![used by @chatman-media/sales](https://img.shields.io/badge/used%20by-@chatman--media%2Fsales-6366f1)](https://github.com/chatman-media/sales)
[![pgvector](https://img.shields.io/badge/pgvector-hybrid%20search-336791?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)
[![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama)](https://ollama.com/)

Hybrid retrieval · Sales-style personas · Hallucination guard · Zero framework dependencies

---

🌐 **Language / Язык / 语言**

[🇬🇧 English](#english) &nbsp;·&nbsp; [🇷🇺 Русский](#russian) &nbsp;·&nbsp; [🇨🇳 中文](#chinese)

</div>

---

<a name="english"></a>

## 🇬🇧 English

### Why @chatman-media/rag?

Most RAG demos stop at "embed → search → prompt". This package ships what **production** looks like:

| Feature | Details |
|---------|---------|
| 🔍 **Hybrid retrieval** | pgvector cosine + BM25 full-text, fused via Reciprocal Rank Fusion |
| 🧠 **Hallucination guard** | Single LLM call checks KB grounding _and_ domain-specific facts |
| ✏️ **Query rewriting** | Resolves pronouns & elliptical follow-ups before retrieval |
| 🎭 **Sales personas** | NEPQ / AIDA / PAS / SPIN frameworks, A/B-ready style configs |
| 🏷️ **Topic routing** | Deterministic regex classifier, zero latency, zero cost |
| 🔌 **Pluggable backends** | Any storage via `IKbStore`; any LLM via `ChatClient` |
| 📄 **Ingest pipeline** | `.md` / `.txt` / `.pdf` with overlap chunking and SHA-256 dedup |
| 💬 **Memory** | Cross-session user-facts extraction + conversation summarization |

### Install

```bash
bun add @chatman-media/rag     # Bun
npm install @chatman-media/rag # npm / pnpm / yarn
```

**Peer requirements:** Node 18+ or Bun 1.x. No native modules — pure TypeScript.

### Quick start

```ts
import { answerWithRag, OpenAIChatClient, OpenAIEmbeddingClient } from "@chatman-media/rag";

const chat = new OpenAIChatClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

const embedder = new OpenAIEmbeddingClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
});

const result = await answerWithRag({
  question: "What are the working conditions in Dubai?",
  kb: myKbStore,       // your IKbStore implementation — see below
  chat,
  embedder,
  hybridSearch: true,  // vector + BM25 fusion
  topicRouting: true,  // free topic-scoped retrieval
  reflect: true,       // hallucination guard
});

console.log(result.text);       // bot reply
console.log(result.telemetry);  // retrieval_ms, generation_ms, path, factCheck, ...
```

### Architecture

```
answerWithRag(question, kb, chat, embedder, options?)
│
├─ 🚀 Persona shortcuts (regex, no LLM call)
│     smalltalk · bot-presence · personal-facts
│
├─ ✏️  [optional] rewriteQuery
│     LLM resolves "а там?" / "это сколько?" into full question
│
├─ 🔢 embedder.embed(question) → float32[]
│
├─ 🔍 Retrieval
│     ├─ vector: kb.search(embedding, k, topic?)
│     ├─ BM25:   kb.searchBm25(query, k, topic?)      ← hybrid mode
│     └─ RRF fusion → KbSearchHit[]
│
├─ 📝 Prompt composition
│     composeSystemPrompt(style, stage, kbContext)     ← sales mode
│     buildSystemPrompt(persona, context)              ← legacy mode
│
├─ 🤖 chat.complete(messages) → raw string
│
├─ 🧹 sanitizeLlmOutput
│     strips <think> · markdown · em-dashes · AI lead-ins
│
└─ 🛡️  [optional] checkFacts
      KB grounding + domain-specific fact verification
      → grounded=false → return NO_CONTEXT_MARKER
```

### Implement IKbStore

The engine is storage-agnostic. Implement `IKbStore` for your backend:

```ts
import type { IKbStore, KbSearchHit } from "@chatman-media/rag";

class MyKbStore implements IKbStore {
  async search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]> {
    return db.query(`
      SELECT chunk_id, text, source, title,
             (embedding <=> $1::vector) AS distance
      FROM kb_chunks
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $2
    `, [JSON.stringify(embedding), k]);
  }

  async hybridSearch(input: {
    embedding: number[]; query: string; k?: number; topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const vec = await this.search(input.embedding, (input.k ?? 5) * 2, input.topic);
    const bm25 = await this.searchBm25(input.query, (input.k ?? 5) * 2, input.topic);
    return reciprocalRankFusion(vec, bm25, input.k ?? 5);
  }

  async prioritySearch(input: {
    embedding: number[]; query: string; k?: number; vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const books = await this.searchTopic(input.embedding, "books", input.k ?? 5);
    if (books.length > 0) return books;
    return input.vectorOnly
      ? this.search(input.embedding, input.k ?? 5)
      : this.hybridSearch(input);
  }

  async getDocumentBySource(source: string) { ... }
  async countChunksForDocument(documentId: number) { ... }
  async deleteDocument(id: number) { ... }
  async upsertDocument(input: { source; title; contentHash; topic? }) { ... }
  async insertChunkWithEmbedding(input: { documentId; chunkIndex; text; tokenCount; embedding }) { ... }
}
```

### LLM providers

```ts
import {
  OpenAIChatClient,          // OpenAI, Together, Groq, any OpenAI-compatible
  OllamaChatClient,          // local models via Ollama
  OpenRouterChatClient,      // 100+ models behind one API key
  OpenAIEmbeddingClient,
  OllamaEmbeddingClient,
} from "@chatman-media/rag";

// Local Ollama (qwen3, llama3, mistral, …)
const chat = new OllamaChatClient({
  host: "http://localhost:11434",
  model: "qwen3:latest",
  disableThinking: true,  // strip <think>…</think> blocks
  timeoutMs: 5 * 60_000,
});

// OpenRouter — swap models without changing code
const chat = new OpenRouterChatClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-haiku-4-5",
});

// Custom endpoint (Together, Groq, Azure, local vLLM…)
const chat = new OpenAIChatClient({
  apiKey: process.env.TOGETHER_API_KEY!,
  baseUrl: "https://api.together.xyz/v1",
  model: "meta-llama/Llama-3-8b-chat-hf",
});
```

### Ingest documents

```ts
import { ingestFile, ingestDirectory, ingestText } from "@chatman-media/rag";

// Single file
await ingestFile("./docs/faq.md", { kb, embedder });

// Directory — auto-derives topic tag from subdirectory name
await ingestDirectory("./knowledge-base", { kb, embedder });
// knowledge-base/visa/requirements.md    → topic: "visa"
// knowledge-base/payment/salaries.md    → topic: "payment"
// knowledge-base/intro.md               → topic: null (global)

// Raw text (admin paste, API upload, …)
await ingestText(
  { title: "Product FAQ", body: markdownString },
  { kb, embedder, topic: "faq" }
);
```

Content is SHA-256 deduped — re-ingesting unchanged files is a no-op.

### Sales personas

For bots that need to convert, not just answer:

```ts
import { answerWithRag } from "@chatman-media/rag";
import type { Style } from "@chatman-media/rag";

const style: Style = {
  slug: "alina-nepq",
  displayName: "Alina NEPQ",
  persona: {
    name: "Alina",
    role: "human",          // poses as a real person, never admits to being AI
    company: "My Agency",
    facts: { city: "Istanbul", age: "26" },
  },
  voice: {
    tone: "warm, curious, brief — like a real WhatsApp conversation",
    language: "ru",
    forbid: ["certainly!", "of course!", "as an AI"],
  },
  framework: "NEPQ",        // AIDA | PAS | SPIN | NEPQ | straight_line
  hooks: [
    { kind: "social_proof", text: "Most of our girls hit their income target within 2 weeks" },
    { kind: "scarcity",     text: "Only 3–5 spots left on the next flight" },
  ],
  stages: {
    qualify: { goal: "Understand motivation and readiness", groundingRequired: false },
    pitch:   { goal: "Present specific vacancy conditions",  groundingRequired: true },
  },
  fewShot: [
    { stage: "qualify", user: "how much do they pay?", assistant: "Depends on the city — where are you thinking?" },
  ],
  guardrails: {
    noMinors: true,
    botDisclosureOnDirectQuestion: true,
    forbiddenTopics: [],
  },
  model: { id: "qwen3:latest", temperature: 0.8, maxTokens: 256 },
};

const result = await answerWithRag({
  question, kb, chat, embedder,
  style,
  stage: "qualify",         // opener | qualify | pitch | objection | close
  hybridSearch: true,
  skills: activeSkills,     // persuasion techniques loaded from your DB
});
```

### AnswerInput options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `topK` | `number` | `5` | KB chunks to retrieve |
| `maxDistance` | `number` | — | Drop vector hits above this cosine distance |
| `hybridSearch` | `boolean` | `false` | Fuse vector + BM25 via RRF |
| `topicRouting` | `boolean` | `false` | Route retrieval to a topic slice first |
| `booksPriority` | `boolean` | `false` | Search "books" topic first, global fallback |
| `rewriteQueryBeforeRetrieval` | `boolean` | `false` | Resolve pronouns/ellipsis with LLM |
| `reflect` | `boolean` | `false` | Hallucination guard (1 extra LLM call) |
| `vacanciesBlock` | `string` | — | Pre-rendered vacancies prepended to context |
| `vacancyGuard` | `boolean` | `true` | Check vacancy accuracy when `vacanciesBlock` is set |
| `includeFewShot` | `boolean` | `true` | Include style few-shot examples |
| `numPredict` | `number` | — | Hard cap on output tokens |
| `userFacts` | `Record<string,string>` | — | Cross-session user memory injected into prompt |
| `conversationSummary` | `string` | — | Compressed older turns injected into prompt |
| `skills` | `SkillForPrompt[]` | — | Persuasion techniques attached to the active style |

### Telemetry

Every call returns structured telemetry — no setup required:

```ts
const { text, telemetry } = await answerWithRag({ ... });

// telemetry shape:
{
  path: "ok",              // ok | smalltalk | persona_fact | no_context | ungrounded
  retrieval_ms: 38,
  generation_ms: 1240,
  top_distances: [0.18, 0.22, 0.31, 0.35, 0.42],
  hybrid: true,
  topic: "visa",           // null when classifier was inconclusive
  original_query: "а там?",
  rewritten_query: "what are the visa requirements in Dubai?",
  factCheck: {
    grounded: true,
    vacancyOk: true,
  }
}
```

Store it in your messages table for later analysis: retrieval quality trends, hallucination rate by model, A/B experiment outcomes.

### Roadmap

#### ✅ Done
- [x] Hybrid retrieval — pgvector + BM25 + Reciprocal Rank Fusion
- [x] Hallucination guard (`reflect`, `vacancyGuard`)
- [x] Query rewriting before retrieval
- [x] Sales personas — NEPQ / AIDA / PAS / SPIN
- [x] Topic routing — zero-latency regex classifier
- [x] Document ingestion — `.md` / `.txt` / `.pdf` with SHA-256 dedup
- [x] Cross-session memory — user-facts extraction + conversation summarization
- [x] Streaming — `answerWithRagStream()`, `ChatClient.stream()`
- [x] `onTelemetry` callback — zero-setup metrics on every call
- [x] `InMemoryKbStore` — database-free store for tests and prototypes
- [x] Retry + exponential backoff — `withRetryChatClient()`, `withRetryEmbeddingClient()`
- [x] Semantic cache — `SemanticCache` with cosine similarity threshold
- [x] Section-aware chunking — `chunkBySections()` splits by Markdown headings

#### ✅ Also Done
- [x] **Reranker** — optional cross-encoder stage after RRF (`CohereReranker`, `JinaReranker`)
- [x] **Evaluation utilities** — `evalRetrieval()` → recall@k, MRR, NDCG
- [x] **`IConversationStore`** — unified interface for session history + summary persistence
- [x] **A/B test router** — randomise styles by `userId`, log conversion via `onTelemetry`
- [x] **SSE server** — `createRagServer()` on Bun.serve() with token streaming

#### 🚧 Planned
- [ ] **Multi-cycle tool calling** — agentic tool loop instead of the current single-cycle execution
- [ ] **`PgVectorKbStore`** — ready-made pgvector `IKbStore` adapter shipped out of the box
- [ ] **More store adapters** — Qdrant and Pinecone backends
- [ ] **OpenTelemetry exporter** — bridge `onTelemetry` events to OTel spans and metrics
- [ ] **Token usage & cost tracking** — per-call token counts and cost in telemetry
- [ ] **Contextual retrieval** — prepend chunk-level context before embedding for higher recall
- [ ] **Embedding cache** — cache embeddings keyed by text hash to cut redundant API calls

### Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

### License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

<div align="right"><a href="#top">🔝 Switch language</a></div>

---

<a name="russian"></a>

## 🇷🇺 Русский

### Зачем @chatman-media/rag?

Большинство RAG-демо останавливаются на схеме «embed → search → prompt». Этот пакет показывает, как выглядит **продакшн**:

| Возможность | Описание |
|-------------|----------|
| 🔍 **Гибридный поиск** | pgvector cosine + BM25 full-text, слияние через Reciprocal Rank Fusion |
| 🧠 **Защита от галлюцинаций** | Один вызов LLM проверяет и заземлённость на базе знаний, и доменные факты |
| ✏️ **Переформулировка запросов** | Разрешает местоимения и эллиптические уточнения до поиска |
| 🎭 **Продажные персоны** | Фреймворки NEPQ / AIDA / PAS / SPIN, конфиги стилей готовы к A/B |
| 🏷️ **Маршрутизация по теме** | Детерминированный regex-классификатор, нулевая задержка и стоимость |
| 🔌 **Сменные бэкенды** | Любое хранилище через `IKbStore`; любой LLM через `ChatClient` |
| 📄 **Пайплайн загрузки** | `.md` / `.txt` / `.pdf` с перекрывающейся нарезкой и SHA-256 дедупликацией |
| 💬 **Память** | Извлечение фактов о пользователе между сессиями + сжатие диалога |

### Установка

```bash
bun add @chatman-media/rag     # Bun
npm install @chatman-media/rag # npm / pnpm / yarn
```

**Требования:** Node 18+ или Bun 1.x. Нет нативных модулей — чистый TypeScript.

### Быстрый старт

```ts
import { answerWithRag, OpenAIChatClient, OpenAIEmbeddingClient } from "@chatman-media/rag";

const chat = new OpenAIChatClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

const embedder = new OpenAIEmbeddingClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
});

const result = await answerWithRag({
  question: "Какие условия работы в Дубае?",
  kb: myKbStore,       // ваша реализация IKbStore — см. ниже
  chat,
  embedder,
  hybridSearch: true,  // слияние vector + BM25
  topicRouting: true,  // поиск с фильтром по теме
  reflect: true,       // защита от галлюцинаций
});

console.log(result.text);       // ответ бота
console.log(result.telemetry);  // retrieval_ms, generation_ms, path, factCheck, ...
```

### Архитектура

```
answerWithRag(question, kb, chat, embedder, options?)
│
├─ 🚀 Быстрые ответы персоны (regex, без вызова LLM)
│     small-talk · присутствие бота · личные факты
│
├─ ✏️  [опционально] rewriteQuery
│     LLM разворачивает «а там?» / «это сколько?» в полный вопрос
│
├─ 🔢 embedder.embed(question) → float32[]
│
├─ 🔍 Поиск
│     ├─ vector: kb.search(embedding, k, topic?)
│     ├─ BM25:   kb.searchBm25(query, k, topic?)      ← гибридный режим
│     └─ RRF-слияние → KbSearchHit[]
│
├─ 📝 Составление промпта
│     composeSystemPrompt(style, stage, kbContext)     ← режим продаж
│     buildSystemPrompt(persona, context)              ← устаревший режим
│
├─ 🤖 chat.complete(messages) → сырая строка
│
├─ 🧹 sanitizeLlmOutput
│     удаляет <think> · markdown · тире · AI-зачины
│
└─ 🛡️  [опционально] checkFacts
      проверка заземлённости на KB + доменные факты
      → grounded=false → возвращает NO_CONTEXT_MARKER
```

### Реализация IKbStore

Движок не зависит от хранилища. Реализуйте `IKbStore` для вашего бэкенда:

```ts
import type { IKbStore, KbSearchHit } from "@chatman-media/rag";

class MyKbStore implements IKbStore {
  async search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]> {
    // Чистый векторный поиск — косинусное расстояние, меньше = ближе
    return db.query(`
      SELECT chunk_id, text, source, title,
             (embedding <=> $1::vector) AS distance
      FROM kb_chunks
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $2
    `, [JSON.stringify(embedding), k]);
  }

  async hybridSearch(input: {
    embedding: number[]; query: string; k?: number; topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const vec = await this.search(input.embedding, (input.k ?? 5) * 2, input.topic);
    const bm25 = await this.searchBm25(input.query, (input.k ?? 5) * 2, input.topic);
    return reciprocalRankFusion(vec, bm25, input.k ?? 5);
  }

  async prioritySearch(input: {
    embedding: number[]; query: string; k?: number; vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const books = await this.searchTopic(input.embedding, "books", input.k ?? 5);
    if (books.length > 0) return books;
    return input.vectorOnly
      ? this.search(input.embedding, input.k ?? 5)
      : this.hybridSearch(input);
  }

  async getDocumentBySource(source: string) { ... }
  async countChunksForDocument(documentId: number) { ... }
  async deleteDocument(id: number) { ... }
  async upsertDocument(input: { source; title; contentHash; topic? }) { ... }
  async insertChunkWithEmbedding(input: { documentId; chunkIndex; text; tokenCount; embedding }) { ... }
}
```

### LLM-провайдеры

```ts
import {
  OpenAIChatClient,          // OpenAI, Together, Groq, любой OpenAI-совместимый
  OllamaChatClient,          // локальные модели через Ollama
  OpenRouterChatClient,      // 100+ моделей по одному API-ключу
  OpenAIEmbeddingClient,
  OllamaEmbeddingClient,
} from "@chatman-media/rag";

// Локальный Ollama (qwen3, llama3, mistral, …)
const chat = new OllamaChatClient({
  host: "http://localhost:11434",
  model: "qwen3:latest",
  disableThinking: true,  // убирать блоки <think>…</think>
  timeoutMs: 5 * 60_000,
});

// OpenRouter — менять модели без правки кода
const chat = new OpenRouterChatClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-haiku-4-5",
});

// Кастомный эндпоинт (Together, Groq, Azure, локальный vLLM…)
const chat = new OpenAIChatClient({
  apiKey: process.env.TOGETHER_API_KEY!,
  baseUrl: "https://api.together.xyz/v1",
  model: "meta-llama/Llama-3-8b-chat-hf",
});
```

### Загрузка документов

```ts
import { ingestFile, ingestDirectory, ingestText } from "@chatman-media/rag";

// Один файл
await ingestFile("./docs/faq.md", { kb, embedder });

// Директория — тема берётся из названия поддиректории
await ingestDirectory("./knowledge-base", { kb, embedder });
// knowledge-base/visa/requirements.md    → topic: "visa"
// knowledge-base/payment/salaries.md    → topic: "payment"
// knowledge-base/intro.md               → topic: null (глобальный)

// Сырой текст (вставка в админке, загрузка через API, …)
await ingestText(
  { title: "Product FAQ", body: markdownString },
  { kb, embedder, topic: "faq" }
);
```

Контент дедуплицируется по SHA-256 — повторная загрузка неизменённых файлов ничего не делает.

### Продажные персоны

Для ботов, которые должны конвертировать, а не просто отвечать:

```ts
import { answerWithRag } from "@chatman-media/rag";
import type { Style } from "@chatman-media/rag";

const style: Style = {
  slug: "alina-nepq",
  displayName: "Alina NEPQ",
  persona: {
    name: "Alina",
    role: "human",          // притворяется реальным человеком, никогда не признаётся что AI
    company: "My Agency",
    facts: { city: "Istanbul", age: "26" },
  },
  voice: {
    tone: "тёплый, любопытный, краткий — как настоящий WhatsApp-диалог",
    language: "ru",
    forbid: ["конечно!", "разумеется!", "как ИИ"],
  },
  framework: "NEPQ",        // AIDA | PAS | SPIN | NEPQ | straight_line
  hooks: [
    { kind: "social_proof", text: "Большинство наших девочек выходят на целевой доход за 2 недели" },
    { kind: "scarcity",     text: "На следующий рейс осталось 3–5 мест" },
  ],
  stages: {
    qualify: { goal: "Понять мотивацию и готовность", groundingRequired: false },
    pitch:   { goal: "Представить условия конкретной вакансии", groundingRequired: true },
  },
  fewShot: [
    { stage: "qualify", user: "сколько там платят?", assistant: "Зависит от города — куда смотришь?" },
  ],
  guardrails: {
    noMinors: true,
    botDisclosureOnDirectQuestion: true,
    forbiddenTopics: [],
  },
  model: { id: "qwen3:latest", temperature: 0.8, maxTokens: 256 },
};

const result = await answerWithRag({
  question, kb, chat, embedder,
  style,
  stage: "qualify",         // opener | qualify | pitch | objection | close
  hybridSearch: true,
  skills: activeSkills,     // техники убеждения из вашей БД
});
```

### Параметры AnswerInput

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `topK` | `number` | `5` | Количество чанков из базы знаний |
| `maxDistance` | `number` | — | Отбросить векторные результаты выше этого косинусного расстояния |
| `hybridSearch` | `boolean` | `false` | Слияние vector + BM25 через RRF |
| `topicRouting` | `boolean` | `false` | Ограничить поиск срезом по теме |
| `booksPriority` | `boolean` | `false` | Сначала искать в теме "books", затем глобально |
| `rewriteQueryBeforeRetrieval` | `boolean` | `false` | Разрешить местоимения/эллипсис через LLM |
| `reflect` | `boolean` | `false` | Защита от галлюцинаций (1 доп. вызов LLM) |
| `vacanciesBlock` | `string` | — | Готовый блок вакансий, добавляемый в контекст |
| `vacancyGuard` | `boolean` | `true` | Проверять точность вакансий при наличии `vacanciesBlock` |
| `includeFewShot` | `boolean` | `true` | Включать few-shot примеры из стиля |
| `numPredict` | `number` | — | Жёсткий лимит токенов на вывод |
| `userFacts` | `Record<string,string>` | — | Факты о пользователе из других сессий, вставляются в промпт |
| `conversationSummary` | `string` | — | Сжатые старые витки диалога, вставляются в промпт |
| `skills` | `SkillForPrompt[]` | — | Техники убеждения, привязанные к активному стилю |

### Телеметрия

Каждый вызов возвращает структурированную телеметрию — настройка не нужна:

```ts
const { text, telemetry } = await answerWithRag({ ... });

// структура telemetry:
{
  path: "ok",              // ok | smalltalk | persona_fact | no_context | ungrounded
  retrieval_ms: 38,
  generation_ms: 1240,
  top_distances: [0.18, 0.22, 0.31, 0.35, 0.42],
  hybrid: true,
  topic: "visa",           // null если классификатор не дал результата
  original_query: "а там?",
  rewritten_query: "какие требования по визе в Дубае?",
  factCheck: {
    grounded: true,
    vacancyOk: true,
  }
}
```

Сохраняйте телеметрию в таблице сообщений для анализа: тренды качества поиска, уровень галлюцинаций по модели, результаты A/B-экспериментов.

### Роадмап

#### ✅ Реализовано
- [x] Гибридный поиск — pgvector + BM25 + Reciprocal Rank Fusion
- [x] Защита от галлюцинаций (`reflect`, `vacancyGuard`)
- [x] Переформулировка запросов перед поиском
- [x] Продажные персоны — NEPQ / AIDA / PAS / SPIN
- [x] Маршрутизация по теме — regex-классификатор с нулевой задержкой
- [x] Загрузка документов — `.md` / `.txt` / `.pdf` с SHA-256 дедупликацией
- [x] Память между сессиями — извлечение фактов + сжатие диалога
- [x] Стриминг — `answerWithRagStream()`, `ChatClient.stream()`
- [x] Колбэк `onTelemetry` — метрики без настройки на каждый вызов
- [x] `InMemoryKbStore` — хранилище без базы данных для тестов и прототипов
- [x] Retry + экспоненциальный backoff — `withRetryChatClient()`, `withRetryEmbeddingClient()`
- [x] Семантический кэш — `SemanticCache` с порогом косинусного сходства
- [x] Семантическая нарезка — `chunkBySections()` по заголовкам Markdown

#### ✅ Также реализовано
- [x] **Reranker** — опциональный cross-encoder после RRF (`CohereReranker`, `JinaReranker`)
- [x] **Утилиты оценки качества** — `evalRetrieval()` → recall@k, MRR, NDCG
- [x] **`IConversationStore`** — единый интерфейс для хранения истории и summary сессий
- [x] **A/B-роутер** — рандомизация стилей по `userId`, логирование конверсии через `onTelemetry`
- [x] **SSE сервер** — `createRagServer()` на Bun.serve() со стримингом токенов

#### 🚧 В планах
- [ ] **Multi-cycle tool calling** — агентный цикл вызова инструментов вместо текущего single-cycle
- [ ] **`PgVectorKbStore`** — готовый адаптер `IKbStore` для pgvector из коробки
- [ ] **Доп. адаптеры хранилищ** — бэкенды Qdrant и Pinecone
- [ ] **OpenTelemetry exporter** — экспорт событий `onTelemetry` в спаны и метрики OTel
- [ ] **Учёт токенов и стоимости** — количество токенов и стоимость каждого вызова в телеметрии
- [ ] **Contextual retrieval** — добавление контекста к чанкам перед эмбеддингом для роста recall
- [ ] **Кеш эмбеддингов** — кеширование эмбеддингов по хешу текста для экономии запросов

### Участие в разработке

PR и issues приветствуются. Смотрите [CONTRIBUTING.md](CONTRIBUTING.md).

### Лицензия

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

<div align="right"><a href="#top">🔝 Сменить язык</a></div>

---

<a name="chinese"></a>

## 🇨🇳 中文

### 为什么选择 @chatman-media/rag？

大多数 RAG 演示止步于「embed → search → prompt」。本包展示的是**生产环境**应有的样子：

| 特性 | 说明 |
|------|------|
| 🔍 **混合检索** | pgvector 余弦距离 + BM25 全文检索，通过互惠排名融合（RRF）合并结果 |
| 🧠 **幻觉防护** | 单次 LLM 调用同时检查知识库接地性和领域特定事实 |
| ✏️ **查询改写** | 在检索前解析代词和省略式追问 |
| 🎭 **销售人格** | NEPQ / AIDA / PAS / SPIN 框架，风格配置支持 A/B 测试 |
| 🏷️ **主题路由** | 确定性正则分类器，零延迟、零成本 |
| 🔌 **可插拔后端** | 通过 `IKbStore` 支持任意存储；通过 `ChatClient` 支持任意 LLM |
| 📄 **摄取流水线** | `.md` / `.txt` / `.pdf` 带重叠分块和 SHA-256 去重 |
| 💬 **记忆** | 跨会话用户事实提取 + 对话摘要压缩 |

### 安装

```bash
bun add @chatman-media/rag     # Bun
npm install @chatman-media/rag # npm / pnpm / yarn
```

**环境要求：** Node 18+ 或 Bun 1.x。无原生模块——纯 TypeScript。

### 快速开始

```ts
import { answerWithRag, OpenAIChatClient, OpenAIEmbeddingClient } from "@chatman-media/rag";

const chat = new OpenAIChatClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

const embedder = new OpenAIEmbeddingClient({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
});

const result = await answerWithRag({
  question: "迪拜的工作条件是什么？",
  kb: myKbStore,       // 您的 IKbStore 实现——见下文
  chat,
  embedder,
  hybridSearch: true,  // 向量 + BM25 融合
  topicRouting: true,  // 按主题范围检索
  reflect: true,       // 幻觉防护
});

console.log(result.text);       // 机器人回复
console.log(result.telemetry);  // retrieval_ms, generation_ms, path, factCheck, ...
```

### 架构

```
answerWithRag(question, kb, chat, embedder, options?)
│
├─ 🚀 人格快捷回复（正则，无 LLM 调用）
│     闲聊 · 机器人身份 · 个人事实
│
├─ ✏️  [可选] rewriteQuery
│     LLM 将「那边呢？」「多少钱？」展开为完整问题
│
├─ 🔢 embedder.embed(question) → float32[]
│
├─ 🔍 检索
│     ├─ 向量: kb.search(embedding, k, topic?)
│     ├─ BM25: kb.searchBm25(query, k, topic?)       ← 混合模式
│     └─ RRF 融合 → KbSearchHit[]
│
├─ 📝 提示词组合
│     composeSystemPrompt(style, stage, kbContext)    ← 销售模式
│     buildSystemPrompt(persona, context)             ← 旧版模式
│
├─ 🤖 chat.complete(messages) → 原始字符串
│
├─ 🧹 sanitizeLlmOutput
│     去除 <think> · Markdown · 破折号 · AI 开场白
│
└─ 🛡️  [可选] checkFacts
      知识库接地性 + 领域事实验证
      → grounded=false → 返回 NO_CONTEXT_MARKER
```

### 实现 IKbStore

引擎与存储无关。为您的后端实现 `IKbStore`：

```ts
import type { IKbStore, KbSearchHit } from "@chatman-media/rag";

class MyKbStore implements IKbStore {
  async search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]> {
    // 纯向量搜索——余弦距离，值越小越近
    return db.query(`
      SELECT chunk_id, text, source, title,
             (embedding <=> $1::vector) AS distance
      FROM kb_chunks
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $2
    `, [JSON.stringify(embedding), k]);
  }

  async hybridSearch(input: {
    embedding: number[]; query: string; k?: number; topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const vec = await this.search(input.embedding, (input.k ?? 5) * 2, input.topic);
    const bm25 = await this.searchBm25(input.query, (input.k ?? 5) * 2, input.topic);
    return reciprocalRankFusion(vec, bm25, input.k ?? 5);
  }

  async prioritySearch(input: {
    embedding: number[]; query: string; k?: number; vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const books = await this.searchTopic(input.embedding, "books", input.k ?? 5);
    if (books.length > 0) return books;
    return input.vectorOnly
      ? this.search(input.embedding, input.k ?? 5)
      : this.hybridSearch(input);
  }

  async getDocumentBySource(source: string) { ... }
  async countChunksForDocument(documentId: number) { ... }
  async deleteDocument(id: number) { ... }
  async upsertDocument(input: { source; title; contentHash; topic? }) { ... }
  async insertChunkWithEmbedding(input: { documentId; chunkIndex; text; tokenCount; embedding }) { ... }
}
```

### LLM 提供商

```ts
import {
  OpenAIChatClient,          // OpenAI、Together、Groq 及任何 OpenAI 兼容接口
  OllamaChatClient,          // 通过 Ollama 运行本地模型
  OpenRouterChatClient,      // 单个 API 密钥访问 100+ 模型
  OpenAIEmbeddingClient,
  OllamaEmbeddingClient,
} from "@chatman-media/rag";

// 本地 Ollama（qwen3、llama3、mistral……）
const chat = new OllamaChatClient({
  host: "http://localhost:11434",
  model: "qwen3:latest",
  disableThinking: true,  // 去除 <think>…</think> 块
  timeoutMs: 5 * 60_000,
});

// OpenRouter——无需改代码即可切换模型
const chat = new OpenRouterChatClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-haiku-4-5",
});

// 自定义端点（Together、Groq、Azure、本地 vLLM……）
const chat = new OpenAIChatClient({
  apiKey: process.env.TOGETHER_API_KEY!,
  baseUrl: "https://api.together.xyz/v1",
  model: "meta-llama/Llama-3-8b-chat-hf",
});
```

### 摄取文档

```ts
import { ingestFile, ingestDirectory, ingestText } from "@chatman-media/rag";

// 单个文件
await ingestFile("./docs/faq.md", { kb, embedder });

// 目录——自动从子目录名称派生主题标签
await ingestDirectory("./knowledge-base", { kb, embedder });
// knowledge-base/visa/requirements.md    → topic: "visa"
// knowledge-base/payment/salaries.md    → topic: "payment"
// knowledge-base/intro.md               → topic: null（全局）

// 原始文本（管理员粘贴、API 上传……）
await ingestText(
  { title: "Product FAQ", body: markdownString },
  { kb, embedder, topic: "faq" }
);
```

内容按 SHA-256 去重——重复摄取未变更文件不产生任何操作。

### 销售人格

适用于需要转化而不仅仅是回答的机器人：

```ts
import { answerWithRag } from "@chatman-media/rag";
import type { Style } from "@chatman-media/rag";

const style: Style = {
  slug: "alina-nepq",
  displayName: "Alina NEPQ",
  persona: {
    name: "Alina",
    role: "human",          // 扮演真实人物，永不承认是 AI
    company: "My Agency",
    facts: { city: "Istanbul", age: "26" },
  },
  voice: {
    tone: "温暖、好奇、简短——像真实的 WhatsApp 对话",
    language: "ru",
    forbid: ["当然！", "没问题！", "作为 AI"],
  },
  framework: "NEPQ",        // AIDA | PAS | SPIN | NEPQ | straight_line
  hooks: [
    { kind: "social_proof", text: "我们大多数女孩在 2 周内就达到了收入目标" },
    { kind: "scarcity",     text: "下一班航班只剩 3–5 个名额" },
  ],
  stages: {
    qualify: { goal: "了解动机和准备情况", groundingRequired: false },
    pitch:   { goal: "介绍具体职位条件",    groundingRequired: true },
  },
  fewShot: [
    { stage: "qualify", user: "那边给多少钱？", assistant: "要看城市——你在考虑哪里？" },
  ],
  guardrails: {
    noMinors: true,
    botDisclosureOnDirectQuestion: true,
    forbiddenTopics: [],
  },
  model: { id: "qwen3:latest", temperature: 0.8, maxTokens: 256 },
};

const result = await answerWithRag({
  question, kb, chat, embedder,
  style,
  stage: "qualify",         // opener | qualify | pitch | objection | close
  hybridSearch: true,
  skills: activeSkills,     // 从数据库加载的说服技巧
});
```

### AnswerInput 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `topK` | `number` | `5` | 检索的知识库分块数量 |
| `maxDistance` | `number` | — | 丢弃余弦距离超过此值的向量结果 |
| `hybridSearch` | `boolean` | `false` | 通过 RRF 融合向量 + BM25 |
| `topicRouting` | `boolean` | `false` | 先按主题切片路由检索 |
| `booksPriority` | `boolean` | `false` | 优先搜索"books"主题，全局兜底 |
| `rewriteQueryBeforeRetrieval` | `boolean` | `false` | 通过 LLM 解析代词/省略 |
| `reflect` | `boolean` | `false` | 幻觉防护（额外 1 次 LLM 调用） |
| `vacanciesBlock` | `string` | — | 预渲染的职位信息，前置到上下文 |
| `vacancyGuard` | `boolean` | `true` | 设置 `vacanciesBlock` 时验证职位准确性 |
| `includeFewShot` | `boolean` | `true` | 包含风格中的 few-shot 示例 |
| `numPredict` | `number` | — | 输出 token 硬上限 |
| `userFacts` | `Record<string,string>` | — | 注入提示词的跨会话用户记忆 |
| `conversationSummary` | `string` | — | 注入提示词的压缩历史对话 |
| `skills` | `SkillForPrompt[]` | — | 绑定到当前风格的说服技巧 |

### 遥测

每次调用均返回结构化遥测数据——无需任何配置：

```ts
const { text, telemetry } = await answerWithRag({ ... });

// telemetry 结构：
{
  path: "ok",              // ok | smalltalk | persona_fact | no_context | ungrounded
  retrieval_ms: 38,
  generation_ms: 1240,
  top_distances: [0.18, 0.22, 0.31, 0.35, 0.42],
  hybrid: true,
  topic: "visa",           // 分类器无结论时为 null
  original_query: "那边呢？",
  rewritten_query: "迪拜的签证要求是什么？",
  factCheck: {
    grounded: true,
    vacancyOk: true,
  }
}
```

将遥测数据存入消息表，用于后续分析：检索质量趋势、各模型幻觉率、A/B 实验结果。

### 路线图

#### ✅ 已完成
- [x] 混合检索 — pgvector + BM25 + 互惠排名融合（RRF）
- [x] 幻觉防护（`reflect`、`vacancyGuard`）
- [x] 检索前查询改写
- [x] 销售人格 — NEPQ / AIDA / PAS / SPIN
- [x] 主题路由 — 零延迟正则分类器
- [x] 文档摄取 — `.md` / `.txt` / `.pdf` 含 SHA-256 去重
- [x] 跨会话记忆 — 用户事实提取 + 对话摘要压缩
- [x] 流式输出 — `answerWithRagStream()`、`ChatClient.stream()`
- [x] `onTelemetry` 回调 — 每次调用零配置指标
- [x] `InMemoryKbStore` — 无需数据库的测试与原型存储
- [x] Retry + 指数退避 — `withRetryChatClient()`、`withRetryEmbeddingClient()`
- [x] 语义缓存 — 带余弦相似度阈值的 `SemanticCache`
- [x] 按章节分块 — `chunkBySections()` 按 Markdown 标题分割

#### ✅ 也已完成
- [x] **Reranker** — RRF 后可选的交叉编码器阶段（`CohereReranker`、`JinaReranker`）
- [x] **评估工具** — `evalRetrieval()` → recall@k、MRR、NDCG
- [x] **`IConversationStore`** — 会话历史与摘要持久化的统一接口
- [x] **A/B 测试路由器** — 按 `userId` 随机化风格，通过 `onTelemetry` 记录转化
- [x] **SSE 服务器** — 基于 Bun.serve() 的 `createRagServer()` 含令牌流式输出

#### 🚧 计划中
- [ ] **多轮工具调用** — 用智能体式工具循环替代当前的单轮执行
- [ ] **`PgVectorKbStore`** — 开箱即用的 pgvector `IKbStore` 适配器
- [ ] **更多存储适配器** — Qdrant 与 Pinecone 后端
- [ ] **OpenTelemetry 导出器** — 将 `onTelemetry` 事件桥接到 OTel 跨度与指标
- [ ] **令牌用量与成本跟踪** — 在遥测中记录每次调用的令牌数与成本
- [ ] **上下文检索** — 在嵌入前为分块添加上下文以提升召回率
- [ ] **嵌入缓存** — 按文本哈希缓存嵌入，减少冗余 API 调用

### 贡献

欢迎提交 PR 和 Issue。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 许可证

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)

<div align="right"><a href="#top">🔝 切换语言</a></div>
