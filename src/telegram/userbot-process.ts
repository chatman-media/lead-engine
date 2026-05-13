#!/usr/bin/env bun
// Standalone entry point for the userbot subprocess.
// Spawned by index.ts via Bun.spawn so that gramJS crashes don't kill the main server.

// gramJS emits TIMEOUT and network errors as unhandled promise rejections.
// Log them and keep running — the connect/reconnect loop in userbot.ts handles recovery.
process.on("unhandledRejection", (reason) => {
  console.error("[userbot-process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[userbot-process] uncaughtException:", err?.message ?? err);
});

import { config } from "../config.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { getDb } from "../db/sqlite.ts";
import { OpenAIChatClient } from "../rag/chat.ts";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../rag/embed.ts";
import { OllamaChatClient } from "../rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "../rag/providers/openrouter-chat.ts";
import type { Style } from "../sales/types.ts";
import { startUserbot } from "./userbot.ts";

const db = getDb();

let rag: Parameters<typeof startUserbot>[0]["rag"];

if (config.llm.provider === "openrouter" ? !!config.openrouter.apiKey : !!config.openai.apiKey) {
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

  const stylesRepo = new StylesRepo(db);
  const styleRow = config.sales.forcedStyleSlug
    ? stylesRepo.bySlug(config.sales.forcedStyleSlug)
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

await startUserbot({ db, apiId: config.userbot.apiId, apiHash: config.userbot.apiHash, rag });
