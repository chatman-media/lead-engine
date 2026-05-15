#!/usr/bin/env bun
// Standalone entry point for the userbot subprocess.
// Spawned by index.ts via Bun.spawn so that gramJS crashes don't kill the main server.

import { config, llmIsConfigured } from "../config.ts";
import { sql } from "../db/postgres.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { log } from "../log.ts";
import { OpenAIChatClient } from "../rag/chat.ts";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../rag/embed.ts";
import { OllamaChatClient } from "../rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "../rag/providers/openrouter-chat.ts";
import type { Style } from "../sales/types.ts";
import { parseMTProxy } from "./mtproxy.ts";
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
    log.warn("disconnecting previous client", { scope: "userbot-process" });
    await activeClient.disconnect().catch(() => {});
    activeClient = null;
  }

  restarting = false;

  // Parse the optional MTProto proxy at every restart so an operator can
  // hot-swap the env value via container restart without redeploying.
  // Malformed values abort the subprocess loud — silently falling back to
  // direct on a blocked server would mask the actual failure mode.
  let proxy: Parameters<typeof startUserbot>[0]["proxy"];
  if (config.userbot.mtproxy) {
    const parsed = parseMTProxy(config.userbot.mtproxy);
    if (!parsed) {
      log.error("USERBOT_MTPROXY is set but unparseable — refusing to start", {
        scope: "userbot-process",
      });
      // 10s restart loop above would re-trip on the same malformed value;
      // exit hard so the orchestrator surfaces the bad config.
      process.exit(1);
    }
    proxy = parsed;
  }

  try {
    activeClient = await startUserbot({
      db: sql,
      apiId: config.userbot.apiId,
      apiHash: config.userbot.apiHash,
      ...(proxy ? { proxy } : {}),
      rag,
    });
  } catch (err) {
    log.error("startUserbot failed; restarting in 10s", { scope: "userbot-process", err });
    setTimeout(runUserbot, 10_000);
  }
}

// gramJS emits TIMEOUT and network errors as unhandled promise rejections.
// Catch them here and restart the client instead of letting the process die.
process.on("unhandledRejection", (reason) => {
  log.warn("unhandledRejection; restarting gramJS in 5s", {
    scope: "userbot-process",
    err: reason,
  });
  setTimeout(runUserbot, 5_000);
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException; restarting gramJS in 5s", { scope: "userbot-process", err });
  setTimeout(runUserbot, 5_000);
});

await runUserbot();
