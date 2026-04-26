import { activeEmbeddingDim, config, llmIsConfigured } from "./config.ts";
import { getDb } from "./db/sqlite.ts";
import { OpenAIChatClient } from "./rag/chat.ts";
import { OpenAIEmbeddingClient } from "./rag/embed.ts";
import { OllamaChatClient } from "./rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "./rag/providers/ollama-embed.ts";
import type { ChatClient } from "./rag/chat.ts";
import type { EmbeddingClient } from "./rag/embed.ts";
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
  rag = { chat, embedder };
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
