#!/usr/bin/env bun
import { statSync } from "node:fs";

import { activeEmbeddingDim, config, llmIsConfigured } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import type { EmbeddingClient } from "../src/rag/embed.ts";
import { OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { ingestDirectory, ingestFile } from "../src/rag/ingest.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";

interface CliOpts {
  target: string;
  maxChars?: number;
  overlap?: number;
  topic?: string;
}

function parseCliArgs(): CliOpts {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let maxChars: number | undefined;
  let overlap: number | undefined;
  let topic: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--max-chars") maxChars = parseInt(argv[++i] ?? "", 10);
    else if (v === "--overlap") overlap = parseInt(argv[++i] ?? "", 10);
    else if (v === "--topic") topic = argv[++i];
    else if (v === "-h" || v === "--help") {
      console.log(
        "Usage: bun scripts/ingest.ts <file-or-directory>\n" +
          "                            [--max-chars N]   default 1500\n" +
          "                            [--overlap N]     default 150\n" +
          "                            [--topic SLUG]    tag every doc with this topic;\n" +
          "                                              in directory mode without --topic,\n" +
          "                                              the immediate sub-dir name becomes\n" +
          "                                              the topic (kb/curated/visa/*.md\n" +
          "                                              → topic=visa)\n\n" +
          "Tip: small embedding models have a 512-token context. For\n" +
          "Russian text, prefer --max-chars 600 --overlap 80 (e.g. for\n" +
          "all-minilm:l6-v2). Larger models like nomic-embed-text accept\n" +
          "the default 1500/150.",
      );
      process.exit(0);
    } else positional.push(v);
  }
  if (!positional[0]) {
    console.error(
      "Usage: bun scripts/ingest.ts <file-or-directory> [--max-chars N] [--overlap N] [--topic SLUG]",
    );
    process.exit(1);
  }
  const result: CliOpts = { target: positional[0]! };
  if (maxChars !== undefined) result.maxChars = maxChars;
  if (overlap !== undefined) result.overlap = overlap;
  if (topic !== undefined) result.topic = topic;
  return result;
}

async function main() {
  const opts = parseCliArgs();
  const target = opts.target;
  if (!llmIsConfigured()) {
    console.error(
      `LLM provider "${config.llm.provider}" is not configured. ` +
        (config.llm.provider === "ollama"
          ? "Set OLLAMA_HOST and ensure Ollama is running."
          : "Set OPENAI_API_KEY in .env."),
    );
    process.exit(1);
  }

  const kb = new KbRepo(sql);
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
    throw new Error(`Embedder dim ${embedder.dim} != active dim ${activeEmbeddingDim()}`);
  }

  const chunkOpts: { maxChars?: number; overlapChars?: number } = {};
  if (opts.maxChars !== undefined) chunkOpts.maxChars = opts.maxChars;
  if (opts.overlap !== undefined) chunkOpts.overlapChars = opts.overlap;
  if (Object.keys(chunkOpts).length > 0) {
    console.log(
      `[ingest] chunk override: maxChars=${chunkOpts.maxChars ?? "default"} overlap=${chunkOpts.overlapChars ?? "default"}`,
    );
  }

  const deps: { kb: KbRepo; embedder: EmbeddingClient; chunk: typeof chunkOpts; topic?: string } = {
    kb,
    embedder,
    chunk: chunkOpts,
  };
  if (opts.topic !== undefined) {
    deps.topic = opts.topic;
    console.log(`[ingest] applying topic="${opts.topic}" to all ingested docs`);
  }
  const stat = statSync(target);
  if (stat.isDirectory()) {
    const summary = await ingestDirectory(target, deps);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const r = await ingestFile(target, deps);
    console.log(JSON.stringify(r, null, 2));
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
