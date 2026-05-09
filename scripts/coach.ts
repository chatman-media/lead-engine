#!/usr/bin/env bun
/**
 * Coach-LLM CLI. Reads recent self-play LOSSES + DRAWS for a style,
 * asks an LLM coach for concrete edits to improve win rate. Prints
 * the proposal as JSON — operator reviews and (optionally) applies
 * edits manually via the Styles admin page.
 *
 * Usage:
 *   bun run scripts/coach.ts --style alina-infinity-v1 --sample 8
 *   bun run scripts/coach.ts --style alina-infinity-v1 --persona time-pressed-zhanna
 *
 * Defaults: --sample 8, all personas, current chat provider/model.
 */
import { config } from "../src/config.ts";
import { SelfPlayMatchesRepo } from "../src/db/repos/self-play-matches.ts";
import { SkillsRepo } from "../src/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "../src/db/repos/styles.ts";
import { getDb } from "../src/db/sqlite.ts";
import { OpenAIChatClient } from "../src/rag/chat.ts";
import { OllamaChatClient } from "../src/rag/providers/ollama-chat.ts";
import { OpenRouterChatClient } from "../src/rag/providers/openrouter-chat.ts";
import { proposeStyleEdits } from "../src/sales/coach.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "../src/sales/self-play/personas.ts";
import { STYLES as BUILTIN_STYLES } from "../src/sales/styles/index.ts";
import type { Style } from "../src/sales/types.ts";

interface Args {
  style: string;
  sample: number;
  personaSlug: string | null;
  model: string | null;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let style = "alina-infinity-v1";
  let sample = 8;
  let personaSlug: string | null = null;
  let model: string | null = null;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v === "--style") style = a[++i] ?? style;
    else if (v === "--sample") sample = parseInt(a[++i] ?? "8", 10) || 8;
    else if (v === "--persona") personaSlug = a[++i] ?? null;
    else if (v === "--model") model = a[++i] ?? null;
    else if (v === "--help" || v === "-h") {
      console.log(
        "Usage: bun scripts/coach.ts --style <slug> [--sample N] " +
          "[--persona <slug>] [--model <id>]\n" +
          "  Reads N (default 8) recent lost+draw self-play matches and proposes\n" +
          "  concrete style edits via an LLM coach. Prints JSON.",
      );
      process.exit(0);
    }
  }
  return { style, sample, personaSlug, model };
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

async function main() {
  const args = parseArgs();
  const db = getDb();
  const stylesRepo = new StylesRepo(db);
  seedBuiltinStyles(stylesRepo, BUILTIN_STYLES);

  const styleRow = stylesRepo.bySlug(args.style);
  if (!styleRow) {
    console.error(`[coach] style not found: ${args.style}`);
    console.error(
      `[coach] available: ${stylesRepo
        .listActive()
        .map((s) => s.slug)
        .join(", ")}`,
    );
    process.exit(1);
  }
  const style = stylesRepo.parseRow(styleRow) as Style;

  if (args.personaSlug && !CANDIDATE_BY_SLUG.has(args.personaSlug)) {
    console.error(`[coach] unknown persona: ${args.personaSlug}`);
    console.error(`[coach] available: ${CANDIDATE_PERSONAS.map((p) => p.slug).join(", ")}`);
    process.exit(1);
  }

  const matchesRepo = new SelfPlayMatchesRepo(db);
  const skillsRepo = new SkillsRepo(db);
  const currentSkills = skillsRepo.skillsForStyle(styleRow.id).map((r) => r.slug);

  const chat = buildChat();

  console.log(`[coach] style=${args.style} sample=${args.sample}`);
  if (args.personaSlug) console.log(`[coach] persona filter: ${args.personaSlug}`);
  if (args.model) console.log(`[coach] coach model override: ${args.model}`);
  console.log("[coach] calling LLM (this can take 30-90s)…");
  const t0 = Date.now();

  const proposal = await proposeStyleEdits({
    style,
    matchesRepo,
    chat,
    sampleSize: args.sample,
    ...(args.personaSlug ? { personaSlug: args.personaSlug } : {}),
    ...(args.model ? { model: args.model } : {}),
    currentSkills,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[coach] done in ${elapsed}s\n`);
  console.log(JSON.stringify(proposal, null, 2));
  db.close();
}

await main();
