import { activeEmbeddingDim, config } from "../../config.ts";
import { ExperimentsRepo } from "../../db/repos/experiments.ts";
import { LeadsRepo } from "../../db/repos/leads.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { VacanciesRepo } from "../../db/repos/vacancies.ts";
import { getCachedCredits } from "../../openrouter/credits.ts";
import { PHOTO_CLASSES, type PhotoClass } from "../../rag/vision.ts";
import { json, type RouteHandler } from "../../router.ts";
import { withAdmin } from "../handler-helpers.ts";
import { type AdminApiDeps, readBotHealth } from "../shared.ts";

/**
 * Admin dashboard data: which RAG layers are enabled, which providers/models
 * are wired, KB stats by topic, and aggregate counts. Lets operators see at
 * a glance what's running without SSHing into the server.
 *
 * NEVER returns API keys or other secrets — only flags, model names, and
 * counts. Safe to render to any authenticated admin.
 */
export function createStatusHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async () => {
    // Provider config — names and dims only, no API keys.
    const chatProvider = config.llm.provider;
    const embedProvider = config.llm.embeddingProvider;
    const chatModel =
      chatProvider === "ollama"
        ? config.ollama.chatModel
        : chatProvider === "openrouter"
          ? config.openrouter.chatModel
          : config.openai.chatModel;
    const embedModel =
      embedProvider === "ollama" ? config.ollama.embeddingModel : config.openai.embeddingModel;

    // Active routing: env override > running experiment > legacy persona > none.
    const styles = new StylesRepo(deps.sql);
    const experiments = new ExperimentsRepo(deps.sql);
    const vacancies = new VacanciesRepo(deps.sql);
    const leadsRepo = new LeadsRepo(deps.sql);
    let routingMode: "env_override" | "running_experiment" | "legacy_persona" | "none";
    let activeStyleSlug: string | null = null;
    let runningExperimentSlug: string | null = null;
    if (config.sales.forcedStyleSlug) {
      routingMode = "env_override";
      activeStyleSlug = config.sales.forcedStyleSlug;
    } else {
      const running = await experiments.getRunning();
      if (running) {
        routingMode = "running_experiment";
        runningExperimentSlug = running.slug;
      } else if (config.persona.name) {
        routingMode = "legacy_persona";
      } else {
        routingMode = "none";
      }
    }

    // KB stats grouped by topic. NULL groups together as "untagged" so the
    // UI can render them distinctly. Single CROSS JOIN for aggregate count.
    const kbByTopic = await deps.sql<{ topic: string | null; documents: number; chunks: number }[]>`
      SELECT d.topic AS topic,
             COUNT(DISTINCT d.id)::INTEGER AS documents,
             COUNT(c.id)::INTEGER AS chunks
      FROM kb_documents d
      LEFT JOIN kb_chunks c ON c.document_id = d.id
      GROUP BY d.topic
      ORDER BY documents DESC, topic ASC
    `;
    const [kbTotalsRow] = await deps.sql<{ documents: number; chunks: number }[]>`
      SELECT (SELECT COUNT(*) FROM kb_documents)::INTEGER AS documents,
             (SELECT COUNT(*) FROM kb_chunks)::INTEGER AS chunks
    `;
    const kbTotals = kbTotalsRow ?? { documents: 0, chunks: 0 };

    const convsByMode = await deps.sql<{ mode: string; count: number }[]>`
      SELECT mode, COUNT(*)::INTEGER AS count FROM conversations GROUP BY mode
    `;
    const convTotal = convsByMode.reduce((s, r) => s + r.count, 0);

    const usersByStatus = await deps.sql<{ status: string; count: number }[]>`
      SELECT status, COUNT(*)::INTEGER AS count FROM users GROUP BY status
    `;
    const usersTotal = usersByStatus.reduce((s, r) => s + r.count, 0);

    const messagesByRole = await deps.sql<{ role: string; count: number }[]>`
      SELECT role, COUNT(*)::INTEGER AS count FROM messages GROUP BY role
    `;
    const messagesTotal = messagesByRole.reduce((s, r) => s + r.count, 0);

    // How many conversations have a long-conversation summary stored?
    // Useful signal for whether RAG_CONVERSATION_SUMMARY is actually doing
    // anything on this corpus.
    const [summarizedConvsRow] = await deps.sql<{ count: number }[]>`
      SELECT COUNT(*)::INTEGER AS count FROM conversations WHERE summary_json IS NOT NULL
    `;
    const summarizedConvs = summarizedConvsRow?.count ?? 0;

    // How many users have memory facts extracted? Same diagnostic value
    // for RAG_USER_MEMORY.
    const [usersWithMemoryRow] = await deps.sql<{ count: number }[]>`
      SELECT COUNT(*)::INTEGER AS count FROM users
      WHERE profile_json IS NOT NULL
        AND (profile_json::jsonb)->'memory'->'facts' IS NOT NULL
    `;
    const usersWithMemory = usersWithMemoryRow?.count ?? 0;

    // Vision classification stats: how many candidate photos got a
    // `photo_class` stamped vs. left unclassified. Diagnostic for whether
    // the vision model is actually keeping up (or wired at all). NULL class
    // groups as "unclassified". Mirrors MessagesRepo.countPhotosByClass but
    // aggregated globally.
    const photosByClass = await deps.sql<{ cls: string | null; n: number }[]>`
      SELECT (meta_json::jsonb)->'media'->>'photo_class' AS cls, COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' = 'photo'
      GROUP BY cls
    `;
    const visionClassified: Record<PhotoClass, number> = {
      passport: 0,
      full_body: 0,
      portrait: 0,
      other: 0,
    };
    let visionUnclassified = 0;
    for (const row of photosByClass) {
      if (row.cls && (PHOTO_CLASSES as readonly string[]).includes(row.cls)) {
        visionClassified[row.cls as PhotoClass] = row.n;
      } else {
        visionUnclassified += row.n;
      }
    }

    return json({
      rag: {
        userMemory: config.rag.userMemory,
        queryRewrite: config.rag.queryRewrite,
        reflect: config.rag.reflect,
        hybridSearch: config.rag.hybridSearch,
        conversationSummary: config.rag.conversationSummary,
        topicRouting: config.rag.topicRouting,
        topK: config.rag.topK,
        maxDistance: config.rag.maxDistance ?? null,
      },
      providers: {
        chat: { provider: chatProvider, model: chatModel },
        embed: { provider: embedProvider, model: embedModel, dim: activeEmbeddingDim() },
      },
      vision: {
        enabled: config.vision.enabled,
        model: config.vision.model,
        // Photo classification always routes through OpenRouter — see
        // src/rag/vision.ts. No provider abstraction here.
        provider: "openrouter",
        // Bool only — never expose the key itself.
        api_key_configured: config.openrouter.apiKey != null,
        classified: visionClassified,
        unclassified: visionUnclassified,
      },
      routing: {
        mode: routingMode,
        active_style_slug: activeStyleSlug,
        running_experiment_slug: runningExperimentSlug,
        legacy_persona:
          routingMode === "legacy_persona"
            ? {
                name: config.persona.name,
                role: config.persona.role,
                company: config.persona.company || null,
              }
            : null,
        stage_classifier: config.sales.stageClassifier,
      },
      kb: {
        documents: kbTotals.documents,
        chunks: kbTotals.chunks,
        by_topic: kbByTopic,
        // Number of active styles seeded in DB (just count for UI hint).
        styles: (await styles.listActive()).length,
      },
      conversations: {
        total: convTotal,
        by_mode: Object.fromEntries(convsByMode.map((r) => [r.mode, r.count])),
        with_summary: summarizedConvs,
      },
      users: {
        total: usersTotal,
        by_status: Object.fromEntries(usersByStatus.map((r) => [r.status, r.count])),
        with_memory: usersWithMemory,
      },
      messages: {
        total: messagesTotal,
        by_role: Object.fromEntries(messagesByRole.map((r) => [r.role, r.count])),
      },
      vacancies: {
        active: await vacancies.countActive(),
      },
      leads: {
        by_state: await leadsRepo.countByState(),
        leads_chat_configured: deps.leadsChatId != null,
        visa_chat_configured: deps.visaChatId != null,
      },
      // OpenRouter balance — only when chat runs through OpenRouter. The
      // figure is whatever the background monitor last cached (never a
      // synchronous API call from this endpoint). `null` until the first
      // monitor pass completes.
      openrouter:
        config.llm.provider === "openrouter"
          ? (() => {
              const c = getCachedCredits();
              return {
                configured: config.openrouter.apiKey !== "",
                low_balance_usd: config.openrouter.lowBalanceUsd,
                remaining: c?.remaining ?? null,
                total_usage: c?.totalUsage ?? null,
                checked_at: c?.checkedAt ?? null,
              };
            })()
          : null,
      bot_health: await readBotHealth(deps),
    });
  });
}
