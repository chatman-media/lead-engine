#!/usr/bin/env bun
/**
 * Ingest a directory of books (PDF / TXT / MD) into the KB with topic="books".
 * All ingested documents are tagged so the bot can prioritise them when
 * RAG_BOOKS_PRIORITY=true.
 *
 * Usage:
 *   bun scripts/ingest-books.ts ./kb/books
 *   bun scripts/ingest-books.ts ./kb/books --max-chars 1200 --overlap 150
 */
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { activeEmbeddingDim, config, llmIsConfigured } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import type { EmbeddingClient } from "../src/rag/embed.ts";
import { OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { ingestFile } from "../src/rag/ingest.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";

const SUPPORTED_EXTS = new Set([".pdf", ".txt", ".md"]);
const BOOKS_TOPIC = "books";

interface CliOpts {
  dir: string;
  maxChars?: number;
  overlap?: number;
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let maxChars: number | undefined;
  let overlap: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--max-chars") maxChars = parseInt(argv[++i] ?? "", 10);
    else if (v === "--overlap") overlap = parseInt(argv[++i] ?? "", 10);
    else if (v === "-h" || v === "--help") {
      console.log(
        "Usage: bun scripts/ingest-books.ts <directory>\n" +
          "                                   [--max-chars N]   default 1200\n" +
          "                                   [--overlap N]     default 150\n\n" +
          "All PDF/TXT/MD files are ingested with topic='books'.\n" +
          "Idempotent: unchanged files (same SHA256) are skipped.\n" +
          "Set RAG_BOOKS_PRIORITY=true for the bot to answer from books first.",
      );
      process.exit(0);
    } else positional.push(v);
  }

  if (!positional[0]) {
    console.error("Usage: bun scripts/ingest-books.ts <directory> [--max-chars N] [--overlap N]");
    process.exit(1);
  }
  const result: CliOpts = { dir: positional[0]! };
  if (maxChars !== undefined) result.maxChars = maxChars;
  if (overlap !== undefined) result.overlap = overlap;
  return result;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function collectBooks(dir: string): string[] {
  const root = resolve(dir);
  const stat = statSync(root);
  if (!stat.isDirectory()) {
    if (SUPPORTED_EXTS.has(extname(root).toLowerCase())) return [root];
    console.error(`"${root}" is not a directory or supported file`);
    process.exit(1);
  }
  return [...walk(root)].filter((f) => SUPPORTED_EXTS.has(extname(f).toLowerCase()));
}

async function main() {
  const opts = parseArgs();

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
  if (config.llm.embeddingProvider === "ollama") {
    embedder = new OllamaEmbeddingClient({
      host: config.ollama.host,
      model: config.ollama.embeddingModel,
      dim: config.ollama.embeddingDim,
    });
    console.log(
      `[ingest-books] embedder: ollama @ ${config.ollama.host}  model=${config.ollama.embeddingModel}`,
    );
  } else {
    embedder = new OpenAIEmbeddingClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.embeddingModel,
      dim: config.openai.embeddingDim,
    });
    console.log(
      `[ingest-books] embedder: openai @ ${config.openai.baseUrl}  model=${config.openai.embeddingModel}`,
    );
  }

  if (embedder.dim !== activeEmbeddingDim()) {
    throw new Error(`Embedder dim ${embedder.dim} != active dim ${activeEmbeddingDim()}`);
  }

  const chunkOpts: { maxChars?: number; overlapChars?: number } = {
    maxChars: opts.maxChars ?? 1200,
    overlapChars: opts.overlap ?? 150,
  };
  console.log(
    `[ingest-books] chunk: maxChars=${chunkOpts.maxChars}  overlap=${chunkOpts.overlapChars}`,
  );
  console.log(`[ingest-books] topic: "${BOOKS_TOPIC}" (used for priority retrieval)`);

  const files = collectBooks(opts.dir);
  if (files.length === 0) {
    console.log("[ingest-books] no PDF/TXT/MD files found — nothing to do.");
    await sql.end();
    return;
  }

  console.log(`[ingest-books] found ${files.length} file(s)`);

  let totalChunks = 0;
  let totalNew = 0;
  let totalSkipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const label = `[${i + 1}/${files.length}] ${basename(file)}`;
    process.stdout.write(`${label} … `);

    const r = await ingestFile(file, {
      kb,
      embedder,
      chunk: chunkOpts,
      topic: BOOKS_TOPIC,
    });

    if (r.created) {
      console.log(`${r.chunks} chunks`);
      totalChunks += r.chunks;
      totalNew++;
    } else {
      console.log(`skipped (unchanged)`);
      totalChunks += r.chunks;
      totalSkipped++;
    }
  }

  console.log(
    `\n[ingest-books] done — ${totalNew} ingested, ${totalSkipped} skipped, ${totalChunks} total chunks`,
  );
  console.log(`[ingest-books] activate: set RAG_BOOKS_PRIORITY=true in .env`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
