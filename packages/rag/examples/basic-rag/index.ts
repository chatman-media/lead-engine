/**
 * Minimal @chatman-media/rag example — in-memory knowledge base, no database.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run index.ts
 *
 * For Ollama (local, no API key):
 *   bun run index.ts --ollama
 */
import {
  type ChatClient,
  type EmbeddingClient,
  type IKbStore,
  type KbSearchHit,
  NullEmbeddingClient,
  OllamaChatClient,
  OllamaEmbeddingClient,
  OpenAIChatClient,
  OpenAIEmbeddingClient,
  answerWithRag,
  ingestText,
} from "@chatman-media/rag";

// ── In-memory KB store ──────────────────────────────────────────────────────

interface StoredChunk {
  id: number;
  docId: number;
  index: number;
  text: string;
  tokenCount: number;
  embedding: number[];
  source: string;
  title: string;
}

class InMemoryKbStore implements IKbStore {
  private docs: Map<number, { id: number; source: string; title: string; contentHash: string; topic: string | null }> = new Map();
  private chunks: StoredChunk[] = [];
  private nextDocId = 1;
  private nextChunkId = 1;

  async search(embedding: number[], k: number): Promise<KbSearchHit[]> {
    return this.chunks
      .map((c) => ({
        chunk_id: c.id,
        distance: cosineDist(embedding, c.embedding),
        text: c.text,
        document_id: c.docId,
        source: c.source,
        title: c.title,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  async hybridSearch(input: { embedding: number[]; query: string; k?: number }): Promise<KbSearchHit[]> {
    return this.search(input.embedding, input.k ?? 5);
  }

  async prioritySearch(input: { embedding: number[]; query: string; k?: number }): Promise<KbSearchHit[]> {
    return this.search(input.embedding, input.k ?? 5);
  }

  async getDocumentBySource(source: string) {
    for (const doc of this.docs.values()) {
      if (doc.source === source) return doc;
    }
    return null;
  }

  async countChunksForDocument(documentId: number) {
    return this.chunks.filter((c) => c.docId === documentId).length;
  }

  async deleteDocument(id: number) {
    this.docs.delete(id);
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.docId !== id);
    return this.chunks.length < before;
  }

  async upsertDocument(input: { source: string; title: string; contentHash: string; topic?: string | null }) {
    const id = this.nextDocId++;
    const doc = { id, source: input.source, title: input.title, contentHash: input.contentHash, topic: input.topic ?? null };
    this.docs.set(id, doc);
    return { id };
  }

  async insertChunkWithEmbedding(input: {
    documentId: number; chunkIndex: number; text: string; tokenCount: number; embedding: number[];
  }) {
    const doc = this.docs.get(input.documentId);
    this.chunks.push({
      id: this.nextChunkId++,
      docId: input.documentId,
      index: input.chunkIndex,
      text: input.text,
      tokenCount: input.tokenCount,
      embedding: input.embedding,
      source: doc?.source ?? "",
      title: doc?.title ?? "",
    });
  }
}

function cosineDist(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

// ── Provider setup ──────────────────────────────────────────────────────────

const useOllama = process.argv.includes("--ollama");

let chat: ChatClient;
let embedder: EmbeddingClient;

if (useOllama) {
  console.log("Using Ollama (local)…");
  chat = new OllamaChatClient({ host: "http://localhost:11434", model: "qwen3:latest" });
  embedder = new OllamaEmbeddingClient({ host: "http://localhost:11434", model: "bge-m3", dim: 1024 });
} else {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY or pass --ollama");
    process.exit(1);
  }
  chat = new OpenAIChatClient({ apiKey, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
  embedder = new OpenAIEmbeddingClient({ apiKey, baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536 });
}

// ── Load knowledge base ─────────────────────────────────────────────────────

const kb = new InMemoryKbStore();

await ingestText(
  {
    title: "Product FAQ",
    body: `
# Our Product

## Pricing
- Basic plan: $29/month, up to 1,000 conversations
- Pro plan: $99/month, unlimited conversations + analytics
- Enterprise: custom pricing, SLA, dedicated support

## Features
- Hybrid RAG search (vector + BM25)
- Multi-language support (English and Russian)
- Real-time admin dashboard
- Webhook integrations

## Support
Email support@example.com or open a GitHub issue.
Response time: within 24 hours on business days.
`,
  },
  { kb, embedder },
);

console.log("KB loaded. Asking a question…\n");

// ── Ask a question ──────────────────────────────────────────────────────────

const result = await answerWithRag({
  question: "What does the Pro plan include?",
  kb,
  chat,
  embedder,
  topK: 3,
});

console.log("Answer:", result.text);
console.log("\nTelemetry:", result.telemetry);
