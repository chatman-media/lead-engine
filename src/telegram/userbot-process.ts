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
import { type ParsedMTProxy, parseMTProxy, parseMTProxyList } from "./mtproxy.ts";
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

  // Build the ordered list of proxies to try. USERBOT_MTPROXY_LIST wins over
  // the legacy single-value USERBOT_MTPROXY when both are set (operators
  // migrating from #21 keep their old value as a comment).
  const proxies = collectProxies();

  // No proxy configured → direct connection.
  if (proxies.length === 0) {
    try {
      activeClient = await startUserbot({
        db: sql,
        apiId: config.userbot.apiId,
        apiHash: config.userbot.apiHash,
        rag,
      });
    } catch (err) {
      log.error("startUserbot (direct) failed; restarting in 10s", {
        scope: "userbot-process",
        err,
      });
      setTimeout(runUserbot, 10_000);
    }
    return;
  }

  // Try each proxy in order, capped by USERBOT_PROXY_CONNECT_TIMEOUT_SEC per
  // attempt. First success wins; if all fail, log a summary and let the parent
  // restart the whole loop (env may have been updated meanwhile).
  const timeoutMs = config.userbot.proxyConnectTimeoutSec * 1000;
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i]!;
    log.info("trying proxy", {
      scope: "userbot-process",
      attempt: i + 1,
      total: proxies.length,
      proxy_host: proxy.ip,
      proxy_port: proxy.port,
    });
    try {
      activeClient = await withTimeout(
        startUserbot({
          db: sql,
          apiId: config.userbot.apiId,
          apiHash: config.userbot.apiHash,
          proxy,
          rag,
        }),
        timeoutMs,
      );
      log.info("proxy connect succeeded", {
        scope: "userbot-process",
        attempt: i + 1,
        proxy_host: proxy.ip,
      });
      return; // first working proxy wins
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("proxy connect failed, moving to next", {
        scope: "userbot-process",
        attempt: i + 1,
        total: proxies.length,
        proxy_host: proxy.ip,
        reason: msg,
      });
    }
  }

  log.error("all proxies in the list failed; restarting loop in 10s", {
    scope: "userbot-process",
    total: proxies.length,
  });
  setTimeout(runUserbot, 10_000);
}

/**
 * Resolve the operator's proxy configuration into an ordered list. Reads
 * both USERBOT_MTPROXY_LIST (newline-separated, takes precedence) and
 * USERBOT_MTPROXY (single legacy value). Exits with status 1 when env is
 * set but unparseable — silent fallback to direct would defeat the point
 * on a geoblocked server.
 */
function collectProxies(): ParsedMTProxy[] {
  if (config.userbot.mtproxyList) {
    const { proxies, invalid_lines } = parseMTProxyList(config.userbot.mtproxyList);
    if (invalid_lines.length > 0) {
      log.warn("USERBOT_MTPROXY_LIST has unparseable lines (skipped)", {
        scope: "userbot-process",
        invalid_line_numbers: invalid_lines,
      });
    }
    if (proxies.length === 0) {
      log.error("USERBOT_MTPROXY_LIST yielded zero valid proxies — refusing to start", {
        scope: "userbot-process",
      });
      process.exit(1);
    }
    log.info("loaded proxy list", { scope: "userbot-process", count: proxies.length });
    return proxies;
  }
  if (config.userbot.mtproxy) {
    const parsed = parseMTProxy(config.userbot.mtproxy);
    if (!parsed) {
      log.error("USERBOT_MTPROXY is set but unparseable — refusing to start", {
        scope: "userbot-process",
      });
      process.exit(1);
    }
    return [parsed];
  }
  return [];
}

/** Promise.race-style timeout — rejects with TIMEOUT after `ms` if the inner
 *  promise hasn't settled. Used to skip slow / dead proxies during iteration. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(handle);
        resolve(v);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
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
