import { activeEmbeddingDim, config, llmIsConfigured } from "./config.ts";
import { SkillsRepo, seedSkillCatalogue } from "./db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "./db/repos/styles.ts";
import { getDb } from "./db/sqlite.ts";
import type { ChatClient } from "./rag/chat.ts";
import { OpenAIChatClient } from "./rag/chat.ts";
import type { EmbeddingClient } from "./rag/embed.ts";
import { OpenAIEmbeddingClient } from "./rag/embed.ts";
import { OllamaChatClient } from "./rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "./rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "./rag/providers/openrouter-chat.ts";
import { STYLES as BUILTIN_STYLES, getStyle } from "./sales/styles/index.ts";
import { createServer } from "./server.ts";
import { TelegramClient } from "./telegram/client.ts";
import type { RagDeps } from "./telegram/webhook.ts";

const db = getDb();
const telegram = new TelegramClient({
  token: config.telegram.botToken || "missing-token",
});

// Phase 2a: ensure built-in sales styles exist in the DB on every boot.
// Idempotent — admin's edits in the table win over the source-code styles.
// Newly added builtins (added in source after a deploy) get inserted on next boot.
{
  const stylesRepo = new StylesRepo(db);
  const seedResult = seedBuiltinStyles(stylesRepo, BUILTIN_STYLES);
  if (seedResult.inserted.length > 0) {
    console.log(`[server] seeded built-in sales styles: ${seedResult.inserted.join(", ")}`);
  }
  if (seedResult.skipped.length > 0) {
    console.log(
      `[server] sales styles already present (kept DB version): ${seedResult.skipped.join(", ")}`,
    );
  }
}

// Seed the skill catalogue — refreshes copy/prompt-fragments on every boot
// (operator-toggleable `is_enabled` is preserved across upserts).
{
  const skillsRepo = new SkillsRepo(db);
  const r = seedSkillCatalogue(skillsRepo);
  if (r.inserted > 0 || r.updated > 0) {
    console.log(`[server] skill catalogue: ${r.inserted} inserted, ${r.updated} refreshed`);
  }
}

let rag: RagDeps | undefined;
if (llmIsConfigured()) {
  // Chat and embedder are configured INDEPENDENTLY. OpenRouter has no
  // embeddings endpoint, so when chat=openrouter the embedder still resolves
  // to ollama or openai. Mixed setups (e.g. Claude chat via OpenRouter +
  // local Ollama embeddings) are first-class.
  let chat: ChatClient;
  if (config.llm.provider === "ollama") {
    chat = new OllamaChatClient({
      host: config.ollama.host,
      model: config.ollama.chatModel,
    });
  } else if (config.llm.provider === "openrouter") {
    chat = new OpenRouterChatClient({
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      model: config.openrouter.chatModel,
      ...(config.openrouter.siteUrl ? { siteUrl: config.openrouter.siteUrl } : {}),
      ...(config.openrouter.appName ? { appName: config.openrouter.appName } : {}),
    });
  } else {
    chat = new OpenAIChatClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.chatModel,
    });
  }

  let embedder: EmbeddingClient;
  if (config.llm.embeddingProvider === "ollama") {
    embedder = new OllamaEmbeddingClient({
      host: config.ollama.host,
      model: config.ollama.embeddingModel,
      dim: config.ollama.embeddingDim,
    });
  } else {
    embedder = new OpenAIEmbeddingClient({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.embeddingModel,
      dim: config.openai.embeddingDim,
    });
  }

  // Provider-specific summary line so operators see exactly what's wired.
  const chatLine =
    config.llm.provider === "ollama"
      ? `ollama host=${config.ollama.host} model=${config.ollama.chatModel}`
      : config.llm.provider === "openrouter"
        ? `openrouter base=${config.openrouter.baseUrl} model=${config.openrouter.chatModel}`
        : `openai base=${config.openai.baseUrl} model=${config.openai.chatModel}`;
  const embedLine =
    config.llm.embeddingProvider === "ollama"
      ? `ollama model=${config.ollama.embeddingModel} dim=${config.ollama.embeddingDim}`
      : `openai model=${config.openai.embeddingModel} dim=${config.openai.embeddingDim}`;
  console.log(`[server] chat:    ${chatLine}`);
  console.log(`[server] embed:   ${embedLine}`);
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
    stageClassifier: config.sales.stageClassifier,
    ...(config.sales.stageClassifierThreshold !== undefined
      ? { stageClassifierThreshold: config.sales.stageClassifierThreshold }
      : {}),
    userMemory: config.rag.userMemory,
    queryRewrite: config.rag.queryRewrite,
    reflect: config.rag.reflect,
    hybridSearch: config.rag.hybridSearch,
    conversationSummary: config.rag.conversationSummary,
    topicRouting: config.rag.topicRouting,
  };

  if (config.rag.userMemory) console.log(`[server] cross-session user memory: ON`);
  if (config.rag.queryRewrite) console.log(`[server] query rewriting: ON`);
  if (config.rag.reflect) console.log(`[server] answer reflection: ON`);
  if (config.rag.hybridSearch) console.log(`[server] hybrid retrieval (BM25+vector+RRF): ON`);
  if (config.rag.conversationSummary) console.log(`[server] conversation summarization: ON`);
  if (config.rag.topicRouting) console.log(`[server] topic-routed retrieval: ON`);

  if (config.sales.stageClassifier === "llm") {
    console.log(
      `[server] funnel-stage routing: LLM classifier (threshold=${
        config.sales.stageClassifierThreshold ?? 0.6
      })`,
    );
  }

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
  leadsChatId: config.telegram.leadsChatId,
  visaChatId: config.telegram.visaChatId,
});

if (config.telegram.leadsChatId) {
  console.log(`[server] leads chat: ${config.telegram.leadsChatId}`);
}
if (config.telegram.visaChatId) {
  console.log(`[server] visa chat: ${config.telegram.visaChatId}`);
}

console.log(`[server] listening on http://localhost:${server.port}`);

// Stale-lead sweep: every 6h, auto-close non-terminal leads that haven't
// transitioned in 14d → records `lost` outcomes for skills the bot used.
// This populates the loss side of the leaderboard; otherwise the win-rate
// table would be biased by counting only the explicit `submitted`/`rejected`.
{
  const { scheduleStaleLeadSweep } = await import("./leads/stale-sweep.ts");
  const { ConversationsRepo } = await import("./db/repos/conversations.ts");
  const { MessagesRepo } = await import("./db/repos/messages.ts");
  const { SkillOutcomesRepo, StyleRatingsRepo } = await import("./db/repos/skill-outcomes.ts");
  scheduleStaleLeadSweep({
    db,
    outcomes: new SkillOutcomesRepo(db),
    ratings: new StyleRatingsRepo(db),
    messages: new MessagesRepo(db),
    conversations: new ConversationsRepo(db),
    styles: new StylesRepo(db),
  });
}

// Pre-load Ollama models in the background. Without this, the first user
// message after server start has to wait for ~3 min of cold qwen3 weights
// loading (8B Q4_K_M ≈ 5 GB). Once warm, keep_alive=30m holds them. We
// don't await — server is up and serving, the warm-up just hides the
// cold start from the very first inbound message.
if (rag) {
  const startedAt = Date.now();
  Promise.all([
    rag.embedder
      .embed(["warm-up"])
      .then(() => "embed")
      .catch((err) => {
        console.warn("[server] embed warm-up failed:", err?.message ?? err);
        return null;
      }),
    rag.chat
      .complete([{ role: "user", content: "ok" }])
      .then(() => "chat")
      .catch((err) => {
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
