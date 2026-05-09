#!/usr/bin/env bun
/**
 * Pairwise self-play CLI. Pits styleA vs styleB against the same set of
 * candidate personas — direct head-to-head verdict + symmetric ELO update.
 *
 * Usage:
 *   bun run scripts/pairwise.ts \
 *     --a alina-infinity-v1 \
 *     --b flirty-belfort-v1 \
 *     --personas skeptic-anya,eager-kate \
 *     --runs 2 \
 *     --max-turns 16
 *
 * Cost per pair: ~2x a solo match + 1 pairwise judge call. Plan
 * runs × personas × 2 LLM-roundtrips accordingly.
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
import { runPairwiseMatch } from "../src/sales/self-play/pairwise.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "../src/sales/self-play/personas.ts";
import { STYLES as BUILTIN_STYLES } from "../src/sales/styles/index.ts";
import type { Style } from "../src/sales/types.ts";

interface Args {
  styleA: string;
  styleB: string;
  personas: string[];
  runs: number;
  maxTurns: number;
  reflect: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let styleA = "alina-infinity-v1";
  let styleB = "flirty-belfort-v1";
  let personas: string[] = CANDIDATE_PERSONAS.map((p) => p.slug);
  let runs = 1;
  let maxTurns = 20;
  let reflect = true;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v === "--a") styleA = a[++i] ?? styleA;
    else if (v === "--b") styleB = a[++i] ?? styleB;
    else if (v === "--personas")
      personas = (a[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (v === "--runs") runs = parseInt(a[++i] ?? "1", 10) || 1;
    else if (v === "--max-turns") maxTurns = parseInt(a[++i] ?? "20", 10) || 20;
    else if (v === "--no-reflect") reflect = false;
    else if (v === "--help" || v === "-h") {
      console.log(
        "Usage: bun scripts/pairwise.ts --a <slug> --b <slug> [--personas a,b] " +
          "[--runs N] [--max-turns N] [--no-reflect]",
      );
      process.exit(0);
    }
  }
  return { styleA, styleB, personas, runs, maxTurns, reflect };
}

function buildChat() {
  if (config.llm.provider === "ollama") {
    return new OllamaChatClient({
      host: config.ollama.host,
      model: config.ollama.chatModel,
      timeoutMs: 60 * 60_000,
    });
  }
  if (config.llm.provider === "openrouter") {
    return new OpenRouterChatClient({
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      model: config.openrouter.chatModel,
      ...(config.openrouter.siteUrl ? { siteUrl: config.openrouter.siteUrl } : {}),
      ...(config.openrouter.appName ? { appName: config.openrouter.appName } : {}),
    });
  }
  return new OpenAIChatClient({
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    model: config.openai.chatModel,
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
  return new OpenAIEmbeddingClient({
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    model: config.openai.embeddingModel,
    dim: config.openai.embeddingDim,
  });
}

async function main() {
  const args = parseArgs();
  const db = getDb();
  const stylesRepo = new StylesRepo(db);
  const skillsRepo = new SkillsRepo(db);
  seedSkillCatalogue(skillsRepo);
  seedBuiltinStyles(stylesRepo, BUILTIN_STYLES);

  const rowA = stylesRepo.bySlug(args.styleA);
  const rowB = stylesRepo.bySlug(args.styleB);
  if (!rowA || !rowB) {
    console.error(
      `[pairwise] missing style: a=${args.styleA} (${rowA ? "ok" : "missing"}) b=${args.styleB} (${rowB ? "ok" : "missing"})`,
    );
    console.error(
      `[pairwise] available: ${stylesRepo
        .listActive()
        .map((s) => s.slug)
        .join(", ")}`,
    );
    process.exit(1);
  }
  const styleA = stylesRepo.parseRow(rowA) as Style;
  const styleB = stylesRepo.parseRow(rowB) as Style;

  const unknown = args.personas.filter((p) => !CANDIDATE_BY_SLUG.has(p));
  if (unknown.length > 0) {
    console.error(`[pairwise] unknown personas: ${unknown.join(", ")}`);
    console.error(`[pairwise] available: ${CANDIDATE_PERSONAS.map((p) => p.slug).join(", ")}`);
    process.exit(1);
  }

  const kb = new KbRepo(db);
  const vacancies = new VacanciesRepo(db);
  const vacanciesBlock = renderVacanciesBlock(vacancies.listActive());
  const outcomesRepo = new SkillOutcomesRepo(db);
  const ratingsRepo = new StyleRatingsRepo(db);

  const salesChat = buildChat();
  const candidateChat = buildChat();
  const judgeChat = buildChat();
  const embedder = buildEmbedder();

  console.log("=".repeat(60));
  console.log(`[pairwise] A=${args.styleA}  vs  B=${args.styleB}`);
  console.log(`[pairwise] personas: ${args.personas.join(", ")}`);
  console.log(`[pairwise] runs=${args.runs} maxTurns=${args.maxTurns} reflect=${args.reflect}`);
  console.log("=".repeat(60));

  const tally = { a: 0, b: 0, draw: 0 };
  const totalStart = Date.now();
  let total = 0;

  for (const personaSlug of args.personas) {
    const persona = CANDIDATE_BY_SLUG.get(personaSlug)!;
    for (let run = 0; run < args.runs; run++) {
      const matchStart = Date.now();
      console.log(`\n--- ${persona.displayName} (run ${run + 1}/${args.runs}) ---`);
      const result = await runPairwiseMatch(
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
          styleA,
          styleAId: rowA.id,
          styleB,
          styleBId: rowB.id,
          persona,
          maxTurns: args.maxTurns,
        },
      );
      total++;
      tally[result.verdict.winner]++;
      const elapsed = ((Date.now() - matchStart) / 1000).toFixed(1);
      const fabA = result.matchA.fabricationsCaught;
      const fabB = result.matchB.fabricationsCaught;
      console.log(
        `verdict: ${result.verdict.winner.toUpperCase()} (${elapsed}s) — ${result.verdict.reason}`,
      );
      console.log(
        `  A solo: ${result.matchA.outcome.toUpperCase()} (${result.matchA.turns} turns${fabA > 0 ? `, ⚠ ${fabA} fab` : ""})`,
      );
      console.log(
        `  B solo: ${result.matchB.outcome.toUpperCase()} (${result.matchB.turns} turns${fabB > 0 ? `, ⚠ ${fabB} fab` : ""})`,
      );
      console.log(`  ELO: ${args.styleA}=${result.eloAAfter}  ${args.styleB}=${result.eloBAfter}`);
    }
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[pairwise] DONE — ${total} pairs in ${totalElapsed}s`);
  console.log(
    `[pairwise] tally: A=${tally.a} (${pct(tally.a, total)}%)  B=${tally.b} (${pct(tally.b, total)}%)  draw=${tally.draw} (${pct(tally.draw, total)}%)`,
  );
  const ratA = ratingsRepo.bySlug(args.styleA);
  const ratB = ratingsRepo.bySlug(args.styleB);
  console.log(
    `[pairwise] final ELO: ${args.styleA}=${ratA?.elo ?? "—"}  ${args.styleB}=${ratB?.elo ?? "—"}`,
  );
  db.close();
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return ((n / total) * 100).toFixed(0);
}

await main();
