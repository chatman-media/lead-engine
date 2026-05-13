#!/usr/bin/env bun
/**
 * Self-play CLI. Pairs a salesperson Style against simulated candidate
 * personas and runs N matches per pair, persisting outcomes for the
 * win-rate dashboard.
 *
 * Usage:
 *   bun run scripts/self-play.ts \
 *     --style alina-infinity-v1 \
 *     --personas skeptic-anya,eager-kate,price-sensitive-ira \
 *     --runs 3 \
 *     --max-turns 20 \
 *     [--dry-run]
 *
 * --personas defaults to all known personas. --runs defaults to 1.
 * --dry-run prints transcripts but skips DB writes — useful for
 * eyeballing quality before persisting outcomes that will move ELO.
 *
 * Cost: per match ≈ N salesperson LLM calls + N candidate LLM calls +
 * 1 judge call. Plan N×personas×runs accordingly. On Ollama qwen3:8b
 * a typical match is ~2-3 minutes.
 */
import { config } from "../src/config.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "../src/db/repos/skill-outcomes.ts";
import { SkillsRepo, seedSkillCatalogue } from "../src/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "../src/db/repos/styles.ts";
import { renderVacanciesBlock, VacanciesRepo } from "../src/db/repos/vacancies.ts";
import { getDb } from "../src/db/sqlite.ts";
import { OpenAIChatClient } from "../src/rag/chat.ts";
import { OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { OllamaChatClient } from "../src/rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "../src/rag/providers/openrouter-chat.ts";
import { runSelfPlayMatch } from "../src/sales/self-play/orchestrator.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "../src/sales/self-play/personas.ts";
import { STYLES as BUILTIN_STYLES } from "../src/sales/styles/index.ts";
import type { Style } from "../src/sales/types.ts";

interface Args {
  style: string;
  personas: string[];
  runs: number;
  maxTurns: number;
  dryRun: boolean;
  reflect: boolean;
  /** Override chat model (works for openai/openrouter/ollama providers). */
  model?: string;
  /** Override judge model separately (defaults to same as --model). */
  judgeModel?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let style = "alina-infinity-v1";
  let personas: string[] = CANDIDATE_PERSONAS.map((p) => p.slug);
  let runs = 1;
  let maxTurns = 20;
  let dryRun = false;
  let reflect = true; // default ON — research mode prefers honesty over speed
  let model: string | undefined;
  let judgeModel: string | undefined;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v === "--style") style = a[++i] ?? style;
    else if (v === "--personas")
      personas = (a[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (v === "--runs") runs = parseInt(a[++i] ?? "1", 10) || 1;
    else if (v === "--max-turns") maxTurns = parseInt(a[++i] ?? "20", 10) || 20;
    else if (v === "--dry-run") dryRun = true;
    else if (v === "--no-reflect") reflect = false;
    else if (v === "--model") model = a[++i];
    else if (v === "--judge-model") judgeModel = a[++i];
    else if (v === "--help" || v === "-h") {
      console.log(
        "Usage: bun scripts/self-play.ts --style <slug> [--personas a,b] " +
          "[--runs N] [--max-turns N] [--dry-run] [--no-reflect]\n" +
          "  --model <id>        override chat model (e.g. anthropic/claude-haiku-4.5)\n" +
          "  --judge-model <id>  use different model for judge (defaults to --model)\n" +
          "  --no-reflect        disable hallucination check (faster but counts fabricated wins)",
      );
      process.exit(0);
    }
  }
  return { style, personas, runs, maxTurns, dryRun, reflect, model, judgeModel };
}

function buildChat(modelOverride?: string) {
  if (config.llm.provider === "ollama") {
    return new OllamaChatClient({
      host: config.ollama.host,
      model: modelOverride ?? config.ollama.chatModel,
      timeoutMs: 60 * 60_000,
    });
  }
  if (config.llm.provider === "openrouter") {
    return new OpenRouterChatClient({
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      model: modelOverride ?? config.openrouter.chatModel,
      ...(config.openrouter.siteUrl ? { siteUrl: config.openrouter.siteUrl } : {}),
      ...(config.openrouter.appName ? { appName: config.openrouter.appName } : {}),
    });
  }
  return new OpenAIChatClient({
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    model: modelOverride ?? config.openai.chatModel,
  });
}

function buildEmbedder() {
  if (config.llm.embeddingProvider === "ollama") {
    return new OllamaEmbeddingClient({
      host: config.ollama.host,
      model: config.ollama.embeddingModel,
      dim: config.ollama.embeddingDim,
      timeoutMs: 30 * 60_000,
    });
  }
  // Support separate EMBED_* overrides (e.g. Voyage AI key + URL)
  return new OpenAIEmbeddingClient({
    apiKey: config.embed.apiKey ?? config.openai.apiKey,
    baseUrl: config.embed.baseUrl ?? config.openai.baseUrl,
    model: config.embed.model ?? config.openai.embeddingModel,
    dim: config.embed.dim ?? config.openai.embeddingDim,
  });
}

async function main() {
  const args = parseArgs();
  const db = getDb();
  const stylesRepo = new StylesRepo(db);
  const skillsRepo = new SkillsRepo(db);
  // Seed catalogue + ensure styles loaded on first run from a fresh DB.
  seedSkillCatalogue(skillsRepo);
  seedBuiltinStyles(stylesRepo, BUILTIN_STYLES);

  const styleRow = stylesRepo.bySlug(args.style);
  if (!styleRow) {
    console.error(`[self-play] style not found: ${args.style}`);
    console.error(
      `[self-play] available: ${stylesRepo
        .listActive()
        .map((s) => s.slug)
        .join(", ")}`,
    );
    process.exit(1);
  }
  const style = stylesRepo.parseRow(styleRow) as Style;

  const unknown = args.personas.filter((p) => !CANDIDATE_BY_SLUG.has(p));
  if (unknown.length > 0) {
    console.error(`[self-play] unknown personas: ${unknown.join(", ")}`);
    console.error(`[self-play] available: ${CANDIDATE_PERSONAS.map((p) => p.slug).join(", ")}`);
    process.exit(1);
  }

  const kb = new KbRepo(db);
  const vacancies = new VacanciesRepo(db);
  const vacanciesBlock = renderVacanciesBlock(vacancies.listActive());
  const outcomesRepo = new SkillOutcomesRepo(db);
  const ratingsRepo = new StyleRatingsRepo(db);

  // Both sales + candidate use the same provider/model for now. Splitting
  // into two providers (e.g. Anthropic for candidate, Ollama for sales)
  // is a future tweak.
  const salesChat = buildChat(args.model);
  const candidateChat = buildChat(args.model);
  const judgeChat = buildChat(args.judgeModel ?? args.model);
  const embedder = buildEmbedder();

  const modelLabel = args.model ?? "config default";
  const judgeLabel = args.judgeModel ?? modelLabel;

  console.log("=".repeat(60));
  console.log(`[self-play] style="${args.style}" runs=${args.runs} maxTurns=${args.maxTurns}`);
  console.log(`[self-play] personas: ${args.personas.join(", ")}`);
  console.log(`[self-play] dry-run=${args.dryRun} provider=${config.llm.provider}`);
  console.log(`[self-play] model=${modelLabel}  judge=${judgeLabel}`);
  console.log(`[self-play] vacancies in context: ${vacancies.listActive().length}`);
  console.log("=".repeat(60));

  const tally: Record<string, { won: number; lost: number; draw: number }> = {};
  let total = 0;
  const totalStart = Date.now();

  for (const personaSlug of args.personas) {
    const persona = CANDIDATE_BY_SLUG.get(personaSlug)!;
    tally[personaSlug] = { won: 0, lost: 0, draw: 0 };
    for (let run = 0; run < args.runs; run++) {
      const matchStart = Date.now();
      console.log(`\n--- ${persona.displayName} (run ${run + 1}/${args.runs}) ---`);
      const result = await runSelfPlayMatch(
        {
          db,
          kb,
          skills: skillsRepo,
          outcomes: outcomesRepo,
          ratings: ratingsRepo,
          salesChat,
          candidateChat,
          judgeChat,
          embedder,
          reflect: args.reflect,
          ...(vacanciesBlock ? { vacanciesBlock } : {}),
        },
        {
          style,
          styleId: styleRow.id,
          persona,
          maxTurns: args.maxTurns,
        },
      );
      const elapsed = ((Date.now() - matchStart) / 1000).toFixed(1);
      total++;
      tally[personaSlug]![
        result.outcome === "won" ? "won" : result.outcome === "lost" ? "lost" : "draw"
      ]++;

      const fab =
        result.fabricationsCaught > 0
          ? ` · ⚠ ${result.fabricationsCaught} fabrication${result.fabricationsCaught > 1 ? "s" : ""} caught`
          : "";
      console.log(
        `verdict: ${result.outcome.toUpperCase()} (${elapsed}s, ${result.turns} turns${fab}) — ${result.verdict.reason}`,
      );
      // Always print the transcript on dry-run; on real runs only when
      // verdict is interesting (lost / draw — wins are usually predictable).
      if (args.dryRun || result.outcome !== "won") {
        for (const m of result.transcript) {
          const who = m.role === "candidate" ? `[${persona.displayName}]` : `[Алина]`;
          console.log(`  ${who} ${m.text.replace(/\n/g, " ").slice(0, 200)}`);
        }
      }

      if (args.dryRun && result.leadId > 0) {
        // Best-effort cleanup of synthetic rows when dry-run was set
        // AFTER orchestration already inserted them. The orchestrator
        // doesn't know about dry-run; we clean up here.
        db.run(`DELETE FROM leads WHERE id = ?`, [result.leadId]);
      }
    }
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[self-play] DONE — ${total} matches in ${totalElapsed}s`);
  console.log("[self-play] tally:");
  for (const [persona, t] of Object.entries(tally)) {
    const total = t.won + t.lost + t.draw;
    const wr = total > 0 ? ((t.won / total) * 100).toFixed(0) : "—";
    console.log(`  ${persona.padEnd(28)} ${t.won}W / ${t.lost}L / ${t.draw}D  (win rate ${wr}%)`);
  }
  const rating = ratingsRepo.bySlug(args.style);
  if (rating) {
    console.log(
      `[self-play] style ELO: ${rating.elo}  (record: ${rating.wins}W / ${rating.losses}L / ${rating.draws}D)`,
    );
  }
  db.close();
}

await main();
