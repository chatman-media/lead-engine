#!/usr/bin/env bun
import { statSync } from "node:fs";

import {
  activeEmbeddingDim,
  config,
  llmIsConfigured,
} from "../src/config.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { openDb } from "../src/db/sqlite.ts";
import { OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";
import type { EmbeddingClient } from "../src/rag/embed.ts";
import { ingestDirectory, ingestFile } from "../src/rag/ingest.ts";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: bun scripts/ingest.ts <file-or-directory>");
    process.exit(1);
  }
  if (!llmIsConfigured()) {
    console.error(
      `LLM provider "${config.llm.provider}" is not configured. ` +
        (config.llm.provider === "ollama"
          ? "Set OLLAMA_HOST and ensure Ollama is running."
          : "Set OPENAI_API_KEY in .env."),
    );
    process.exit(1);
  }

  const db = openDb();
  const kb = new KbRepo(db);
  let embedder: EmbeddingClient;
  if (config.llm.provider === "ollama") {
    embedder = new OllamaEmbeddingClient({
      host: config.ollama.host,
      model: config.ollama.embeddingModel,
      dim: config.ollama.embeddingDim,
    });
    console.log(
      `[ingest] using ollama @ ${config.ollama.host} model=${config.ollama.embeddingModel} dim=${config.ollama.embeddingDim}`,
    );
  } else {
    embedder = new OpenAIEmbeddingClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.embeddingModel,
      dim: config.openai.embeddingDim,
    });
    console.log(
      `[ingest] using openai-compat @ ${config.openai.baseUrl} model=${config.openai.embeddingModel} dim=${config.openai.embeddingDim}`,
    );
  }
  if (embedder.dim !== activeEmbeddingDim()) {
    throw new Error(
      `Embedder dim ${embedder.dim} != active dim ${activeEmbeddingDim()}`,
    );
  }

  const stat = statSync(target);
  if (stat.isDirectory()) {
    const summary = await ingestDirectory(target, { kb, embedder });
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const r = await ingestFile(target, { kb, embedder });
    console.log(JSON.stringify(r, null, 2));
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
