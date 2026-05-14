#!/usr/bin/env bun
// Standalone entry point for the userbot subprocess.
// Spawned by index.ts via Bun.spawn so that gramJS crashes don't kill the main server.

import { config, llmIsConfigured } from "../config.ts";
import { sql } from "../db/postgres.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { OpenAIChatClient } from "../rag/chat.ts";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../rag/embed.ts";
import { OllamaChatClient } from "../rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "../rag/providers/openrouter-chat.ts";
import type { Style } from "../sales/types.ts";
import { startUserbot } from "./userbot.ts";

let rag: Parameters<typeof startUserbot>[0]["rag"];

if (llmIsConfigured()) {
  const chat =
    config.llm.provider === "ollama"
      ? new OllamaChatClient({ host: config.ollama.host, model: config.ollama.chatModel })
      : config.llm.provider === "openrouter"
        ? new OpenRouterChatClient({
            apiKey: config.openrouter.apiKey,
            baseUrl: config.openrouter.baseUrl,
            model: config.openrouter.chatModel,
          })
        : new OpenAIChatClient({
            apiKey: config.openai.apiKey,
            baseUrl: config.openai.baseUrl,
            model: config.openai.chatModel,
          });

  const embedApiKey = config.embed.apiKey ?? config.openai.apiKey;
  const embedder =
    config.llm.embeddingProvider === "ollama"
      ? new OllamaEmbeddingClient({
          host: config.ollama.host,
          model: config.ollama.embeddingModel,
          dim: config.ollama.embeddingDim,
        })
      : embedApiKey
        ? new OpenAIEmbeddingClient({
            apiKey: embedApiKey,
            baseUrl: config.embed.baseUrl ?? config.openai.baseUrl,
            model: config.embed.model ?? config.openai.embeddingModel,
            dim: config.embed.dim ?? config.openai.embeddingDim,
          })
        : new NullEmbeddingClient(config.embed.dim ?? config.openai.embeddingDim);

  const stylesRepo = new StylesRepo(sql);
  const styleRow = config.sales.forcedStyleSlug
    ? await stylesRepo.bySlug(config.sales.forcedStyleSlug)
    : undefined;
  const style = styleRow ? (stylesRepo.parseRow(styleRow) as Style) : undefined;

  rag = {
    chat,
    embedder,
    persona: config.persona,
    topK: config.rag.topK,
    maxDistance: config.rag.maxDistance,
    ...(style ? { style } : {}),
    stageClassifier: config.sales.stageClassifier,
    userMemory: config.rag.userMemory,
    queryRewrite: config.rag.queryRewrite,
    reflect: config.rag.reflect,
    hybridSearch: config.rag.hybridSearch,
    conversationSummary: config.rag.conversationSummary,
    topicRouting: config.rag.topicRouting,
    booksPriority: config.rag.booksPriority,
  };
}

// Keep-alive: gramJS tears down all sockets on TIMEOUT, which empties the
// event loop. Without this interval Bun exits before our 5s restart timer
// fires, making the unhandledRejection handler useless.
const _keepAlive = setInterval(() => {}, 30_000);

// Track the active gramJS client so we can disconnect it before restarting.
let activeClient: Awaited<ReturnType<typeof startUserbot>> | null = null;
let restarting = false;

async function runUserbot() {
  if (restarting) return;
  restarting = true;

  if (activeClient) {
    console.warn("[userbot-process] disconnecting previous client...");
    await activeClient.disconnect().catch(() => {});
    activeClient = null;
  }

  restarting = false;

  try {
    activeClient = await startUserbot({
      db: sql,
      apiId: config.userbot.apiId,
      apiHash: config.userbot.apiHash,
      rag,
    });
  } catch (err) {
    console.error("[userbot-process] startUserbot failed:", (err as Error)?.message ?? err);
    console.warn("[userbot-process] restarting in 10s...");
    setTimeout(runUserbot, 10_000);
  }
}

// gramJS emits TIMEOUT and network errors as unhandled promise rejections.
// Catch them here and restart the client instead of letting the process die.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.warn("[userbot-process] unhandledRejection:", msg, "— restarting gramJS in 5s");
  setTimeout(runUserbot, 5_000);
});

process.on("uncaughtException", (err) => {
  console.error(
    "[userbot-process] uncaughtException:",
    err?.message ?? err,
    "— restarting gramJS in 5s",
  );
  setTimeout(runUserbot, 5_000);
});

await runUserbot();
