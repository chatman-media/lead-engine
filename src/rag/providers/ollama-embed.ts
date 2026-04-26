import { EmbeddingApiError, type EmbeddingClient } from "../embed.ts";

export type FetchLike = typeof fetch;

export interface OllamaEmbeddingOptions {
  host: string;
  model: string;
  dim: number;
  fetch?: FetchLike;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  error?: string;
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaEmbeddingOptions) {
    this.host = opts.host.replace(/\/+$/, "");
    this.model = opts.model;
    this.dim = opts.dim;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];

    const res = await this.fetchImpl(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EmbeddingApiError(res.status, text || "ollama embed error");
    }

    let payload: OllamaEmbedResponse;
    try {
      payload = (await res.json()) as OllamaEmbedResponse;
    } catch {
      throw new EmbeddingApiError(res.status, "non-JSON response");
    }

    const vectors = payload.embeddings;
    if (!Array.isArray(vectors)) {
      throw new EmbeddingApiError(res.status, "missing embeddings field");
    }
    if (vectors.length !== inputs.length) {
      throw new EmbeddingApiError(
        res.status,
        `expected ${inputs.length} embeddings, got ${vectors.length}`,
      );
    }
    for (const v of vectors) {
      if (v.length !== this.dim) {
        throw new Error(
          `Embedding dim mismatch: expected ${this.dim}, got ${v.length}`,
        );
      }
    }
    return vectors;
  }
}
