import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AdminBus } from "./admin/bus.ts";
import { createInboundEventBridge } from "./admin/inbound-events.ts";
import { activeEmbeddingDim, config, llmIsConfigured } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";
import { sql } from "./db/postgres.ts";
import { AdminsRepo } from "./db/repos/admins.ts";
import { KbRepo } from "./db/repos/kb.ts";
import { SkillsRepo, seedSkillCatalogue } from "./db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "./db/repos/styles.ts";
import { seedInfinityVacancies, VacanciesRepo } from "./db/repos/vacancies.ts";
import type { ChatClient } from "./rag/chat.ts";
import { OpenAIChatClient } from "./rag/chat.ts";
import type { EmbeddingClient } from "./rag/embed.ts";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "./rag/embed.ts";
import { OllamaChatClient } from "./rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "./rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "./rag/providers/openrouter-chat.ts";
import { STYLES as BUILTIN_STYLES, getStyle } from "./sales/styles/index.ts";
import { createServer } from "./server.ts";
import { TelegramClient } from "./telegram/client.ts";
import type { RagDeps, WebhookEvent } from "./telegram/webhook.ts";

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message ?? err);
});

await runMigrations(sql);

const telegram = new TelegramClient({
  token: config.telegram.botToken || "missing-token",
});

// Phase 2a: ensure built-in sales styles exist in the DB on every boot.
// Idempotent — admin's edits in the table win over the source-code styles.
// Newly added builtins (added in source after a deploy) get inserted on next boot.
{
  const stylesRepo = new StylesRepo(sql);
  const seedResult = await seedBuiltinStyles(stylesRepo, BUILTIN_STYLES);
  if (seedResult.inserted.length > 0) {
    console.log(`[server] seeded built-in sales styles: ${seedResult.inserted.join(", ")}`);
  }
  if (seedResult.updated.length > 0) {
    console.log(`[server] refreshed built-in sales styles: ${seedResult.updated.join(", ")}`);
  }
  if (seedResult.skipped.length > 0) {
    console.log(`[server] sales styles unchanged: ${seedResult.skipped.join(", ")}`);
  }
}

// Seed the skill catalogue — refreshes copy/prompt-fragments on every boot
// (operator-toggleable `is_enabled` is preserved across upserts).
{
  const skillsRepo = new SkillsRepo(sql);
  const r = await seedSkillCatalogue(skillsRepo);
  if (r.inserted > 0 || r.updated > 0) {
    console.log(`[server] skill catalogue: ${r.inserted} inserted, ${r.updated} refreshed`);
  }
}

// Auto-create admin from ADMIN_EMAIL + ADMIN_PASSWORD env vars (idempotent).
// Lets operators bootstrap the first admin without running a shell command.
{
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const adminsRepo = new AdminsRepo(sql);
    if (!(await adminsRepo.byEmail(adminEmail))) {
      await adminsRepo.create({ email: adminEmail, password: adminPassword });
      console.log(`[server] admin created: ${adminEmail}`);
    }
  }
}

// Seed built-in INFINITY AGENCY vacancies. Idempotent — skips existing titles.
// Operators can edit/close in /admin/vacancies; new built-ins added in code
// will be inserted on next boot.
{
  const vacanciesRepo = new VacanciesRepo(sql);
  const r = await seedInfinityVacancies(vacanciesRepo);
  if (r.inserted > 0 || r.urlPatched > 0) {
    console.log(
      `[server] vacancies seeded: ${r.inserted} inserted, ${r.urlPatched} url-patched, ${r.skipped} skipped`,
    );
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
    const embedApiKey = config.embed.apiKey ?? config.openai.apiKey;
    if (embedApiKey) {
      embedder = new OpenAIEmbeddingClient({
        apiKey: embedApiKey,
        baseUrl: config.embed.baseUrl ?? config.openai.baseUrl,
        model: config.embed.model ?? config.openai.embeddingModel,
        dim: config.embed.dim ?? config.openai.embeddingDim,
      });
    } else {
      console.warn("[server] OPENAI_API_KEY not set — KB vector search disabled");
      embedder = new NullEmbeddingClient(config.embed.dim ?? config.openai.embeddingDim);
    }
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
    booksPriority: config.rag.booksPriority,
  };

  if (config.rag.userMemory) console.log(`[server] cross-session user memory: ON`);
  if (config.rag.queryRewrite) console.log(`[server] query rewriting: ON`);
  if (config.rag.reflect) console.log(`[server] answer reflection: ON`);
  if (config.rag.hybridSearch) console.log(`[server] hybrid retrieval (BM25+vector+RRF): ON`);
  if (config.rag.conversationSummary) console.log(`[server] conversation summarization: ON`);
  if (config.rag.topicRouting) console.log(`[server] topic-routed retrieval: ON`);
  if (config.rag.booksPriority) console.log(`[server] books-priority retrieval: ON`);

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

// Shared admin WebSocket bus. Created here (not inside createServer) so the
// userbot subprocess can forward its events into the same bus over IPC.
const bus = new AdminBus();
const inboundBridge = createInboundEventBridge({ bus, telegram });

const server = createServer({
  sql,
  telegram,
  webhookSecret: config.telegram.webhookSecret,
  rag,
  bus,
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

if (config.userbot.enabled) {
  if (!config.userbot.apiId || !config.userbot.apiHash) {
    console.error(
      "[userbot] ERROR: TELEGRAM_USERBOT=1 but TELEGRAM_API_ID / TELEGRAM_API_HASH are not set. " +
        "Get them at https://my.telegram.org and run `bun scripts/userbot-auth.ts` once.",
    );
  } else {
    // Run userbot as an isolated subprocess so gramJS crashes don't kill the server.
    const spawnUserbot = () => {
      const proc = Bun.spawn(["bun", "run", "src/telegram/userbot-process.ts"], {
        env: process.env as Record<string, string>,
        stdio: ["ignore", "inherit", "inherit"],
        // The userbot subprocess forwards inbound-pipeline events here over
        // IPC; route them into the shared AdminBus so userbot-channel chats
        // update in real time without a page reload.
        ipc(message) {
          inboundBridge(message as WebhookEvent);
        },
      });
      proc.exited.then((code) => {
        console.warn(`[userbot] process exited (code=${code}), restarting in 10s…`);
        setTimeout(spawnUserbot, 10_000);
      });
    };
    spawnUserbot();
  }
}

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
    db: sql,
    outcomes: new SkillOutcomesRepo(sql),
    ratings: new StyleRatingsRepo(sql),
    messages: new MessagesRepo(sql),
    conversations: new ConversationsRepo(sql),
    styles: new StylesRepo(sql),
  });
}

// Proactive waiting-period check-ins: while a lead waits in docs_pending /
// submitted, DM a warm "как дела?" nudge so a silent candidate doesn't drop
// off mid-process. Opt-in via LEAD_PROACTIVE_CHECKINS.
if (config.leads.proactiveCheckins) {
  const { scheduleProactiveCheckins } = await import("./leads/proactive-checkin.ts");
  const { LeadsService } = await import("./leads/service.ts");
  const { LeadsRepo } = await import("./db/repos/leads.ts");
  const { UsersRepo } = await import("./db/repos/users.ts");
  const { ConversationsRepo } = await import("./db/repos/conversations.ts");
  const { MessagesRepo } = await import("./db/repos/messages.ts");
  const checkinService = new LeadsService({
    leads: new LeadsRepo(sql),
    users: new UsersRepo(sql),
    conversations: new ConversationsRepo(sql),
    messages: new MessagesRepo(sql),
    telegram,
    leadsChatId: config.telegram.leadsChatId,
    visaChatId: config.telegram.visaChatId,
    userbotEnabled: config.userbot.enabled,
    sql,
  });
  scheduleProactiveCheckins({
    leads: new LeadsRepo(sql),
    users: new UsersRepo(sql),
    service: checkinService,
    intervalDays: config.leads.checkinIntervalDays,
  });
  console.log(`[server] proactive check-ins enabled (every ${config.leads.checkinIntervalDays}d)`);
}

// OpenRouter balance monitor: when chat runs through OpenRouter, poll the
// account balance every few hours and DM the operator before it runs out.
if (config.llm.provider === "openrouter" && config.openrouter.apiKey) {
  const { scheduleOpenRouterBalanceMonitor } = await import("./openrouter/balance-monitor.ts");
  scheduleOpenRouterBalanceMonitor({
    telegram,
    apiKey: config.openrouter.apiKey,
    baseUrl: config.openrouter.baseUrl,
    lowBalanceUsd: config.openrouter.lowBalanceUsd,
    adminTgId: config.admin.tgUserId,
    publicBaseUrl: config.publicBaseUrl,
  });
  console.log(
    `[server] OpenRouter balance monitor on (alert below $${config.openrouter.lowBalanceUsd})`,
  );
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

// Auto-ingest KB on first boot when the knowledge base is empty and the
// kb/ directory is present (committed to git). Fire-and-forget — server
// is already serving, ingest runs in the background. Idempotent by
// content hash: re-running on a non-empty KB is a no-op for unchanged files.
if (rag) {
  const kbDir = resolve(import.meta.dir, "../kb");
  const kb = new KbRepo(sql);
  const chunkCount = await kb.countChunks();
  if (chunkCount === 0 && existsSync(kbDir)) {
    console.log(`[server] KB is empty — starting background ingest of ${kbDir}`);
    import("./rag/ingest.ts")
      .then(({ ingestDirectory }) => ingestDirectory(kbDir, { kb, embedder: rag.embedder }))
      .then((summary) => {
        console.log(
          `[server] KB ingest done: ${summary.documents} docs, ${summary.chunks} chunks (${summary.skipped} skipped)`,
        );
      })
      .catch((err) => {
        console.error("[server] KB auto-ingest failed:", err?.message ?? err);
      });
  } else if (chunkCount > 0) {
    console.log(`[server] KB ready: ${chunkCount} chunks`);
  }
}
