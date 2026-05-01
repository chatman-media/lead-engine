import { activeEmbeddingDim, config, llmIsConfigured } from "./config.ts";
import { getDb } from "./db/sqlite.ts";
import { OpenAIChatClient } from "./rag/chat.ts";
import { OpenAIEmbeddingClient } from "./rag/embed.ts";
import { OllamaChatClient } from "./rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "./rag/providers/ollama-embed.ts";
import type { ChatClient } from "./rag/chat.ts";
import type { EmbeddingClient } from "./rag/embed.ts";
import { getStyle } from "./sales/styles/index.ts";
import { createServer } from "./server.ts";
import type { RagDeps } from "./telegram/webhook.ts";
import { TelegramClient } from "./telegram/client.ts";

const db = getDb();
const telegram = new TelegramClient({
  token: config.telegram.botToken || "missing-token",
});

let rag: RagDeps | undefined;
if (llmIsConfigured()) {
  let chat: ChatClient;
  let embedder: EmbeddingClient;
  if (config.llm.provider === "ollama") {
    chat = new OllamaChatClient({
      host: config.ollama.host,
      model: config.ollama.chatModel,
    });
    embedder = new OllamaEmbeddingClient({
      host: config.ollama.host,
      model: config.ollama.embeddingModel,
      dim: config.ollama.embeddingDim,
    });
    console.log(
      `[server] LLM provider=ollama host=${config.ollama.host} chat=${config.ollama.chatModel} embed=${config.ollama.embeddingModel} dim=${config.ollama.embeddingDim}`,
    );
  } else {
    chat = new OpenAIChatClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.chatModel,
    });
    embedder = new OpenAIEmbeddingClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.embeddingModel,
      dim: config.openai.embeddingDim,
    });
    console.log(
      `[server] LLM provider=openai chat=${config.openai.chatModel} embed=${config.openai.embeddingModel} dim=${config.openai.embeddingDim}`,
    );
  }
  // Resolve sales style from BOT_SALES_STYLE env. When set, it takes
  // precedence over the legacy BOT_PERSONA_* env vars: the bot uses the
  // sales-engine prompt (persona + voice + framework + hooks + stage +
  // few-shot) instead of the simpler persona prompt.
  const salesSlug = config.sales.forcedStyleSlug;
  const style = salesSlug ? getStyle(salesSlug) : undefined;
  if (salesSlug && !style) {
    console.warn(
      `[server] BOT_SALES_STYLE="${salesSlug}" not found in registry — falling back to legacy persona. ` +
        `See src/sales/styles/index.ts for available slugs.`,
    );
  }

  rag = {
    chat,
    embedder,
    persona: config.persona,
    topK: config.rag.topK,
    maxDistance: config.rag.maxDistance,
    ...(style ? { style } : {}),
  };

  if (style) {
    console.log(
      `[server] sales-style engine active: slug="${style.slug}" persona="${style.persona.name}" framework=${style.framework}`,
    );
  } else {
    console.log(
      `[server] persona role=${config.persona.role} name="${config.persona.name}"` +
        (config.persona.company ? ` company="${config.persona.company}"` : ""),
    );
  }
} else {
  console.warn(
    `[server] LLM not configured (provider=${config.llm.provider}); bot will reply with placeholder text.`,
  );
}

console.log(`[server] embedding dim in use: ${activeEmbeddingDim()}`);

const server = createServer({
  db,
  telegram,
  webhookSecret: config.telegram.webhookSecret,
  rag,
  enableTestHooks: process.env.TEST_HOOKS === "1",
  port: config.port,
});

console.log(`[server] listening on http://localhost:${server.port}`);

// Pre-load Ollama models in the background. Without this, the first user
// message after server start has to wait for ~3 min of cold qwen3 weights
// loading (8B Q4_K_M ≈ 5 GB). Once warm, keep_alive=30m holds them. We
// don't await — server is up and serving, the warm-up just hides the
// cold start from the very first inbound message.
if (rag) {
  const startedAt = Date.now();
  Promise.all([
    rag.embedder.embed(["warm-up"]).then(() => "embed").catch((err) => {
      console.warn("[server] embed warm-up failed:", err?.message ?? err);
      return null;
    }),
    rag.chat.complete([{ role: "user", content: "ok" }]).then(() => "chat").catch((err) => {
      console.warn("[server] chat warm-up failed:", err?.message ?? err);
      return null;
    }),
  ]).then((results) => {
    const ok = results.filter(Boolean).join("+");
    console.log(
      `[server] LLM warm-up done in ${Math.round((Date.now() - startedAt) / 1000)}s (${ok || "all failed"})`,
    );
  });
}
