#!/usr/bin/env bun
import { InMemoryLlmRouter, type LlmProvider } from "@chatman-media/llm-router";
import { schema, tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadApiConfig } from "../src/config.ts";
import {
  DEFAULT_FUNNEL_EVAL_SCENARIOS,
  type FunnelEvalScenario,
  formatFunnelEvalSummary,
  runLiveFunnelEval,
} from "../src/lib/funnel-builder-live-eval.ts";
import { loadTenantLlmConfigs } from "../src/lib/llm-config-loader.ts";

interface CliArgs {
  tenant?: string;
  tenantId?: number;
  scenario?: string;
  maxRetries: number;
  output?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { maxRetries: 1, json: false, help: false };
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--json") args.json = true;
    else if (raw.startsWith("--tenant=")) {
      args.tenant = raw.slice("--tenant=".length);
    } else if (raw.startsWith("--tenant-id=")) {
      args.tenantId = Number(raw.slice("--tenant-id=".length));
    } else if (raw.startsWith("--scenario=")) {
      args.scenario = raw.slice("--scenario=".length);
    } else if (raw.startsWith("--max-retries=")) {
      args.maxRetries = Number(raw.slice("--max-retries=".length));
    } else if (raw.startsWith("--output=")) {
      args.output = raw.slice("--output=".length);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  bun run apps/api/scripts/eval-funnel-builder.ts [options]

Options:
  --tenant=<slug>       Tenant slug for DB-configured BYOK chat model
  --tenant-id=<id>      Tenant id for DB-configured BYOK chat model
  --scenario=<id>       Run one scenario instead of the full set
  --max-retries=<n>     Repair retries per scenario. Default: 1
  --output=<file>       Write JSON report to file
  --json                Print full JSON report

LLM config:
  Preferred quick path:
    LLM_PROVIDER=openai|openrouter|ollama LLM_MODEL=... LLM_API_KEY=...
    LLM_BASE_URL=... optional

  DB/BYOK path:
    DATABASE_URL=... PLATFORM_MASTER_KEY=... [--tenant=<slug>|--tenant-id=<id>]
`);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!Number.isFinite(args.maxRetries) || args.maxRetries < 0) {
    throw new Error("--max-retries must be a non-negative number");
  }

  const selectedScenarios = selectScenarios(args.scenario);
  const { client, close } = await resolveChatClient(args);
  try {
    const report = await runLiveFunnelEval({
      chat: client,
      scenarios: selectedScenarios,
      maxRetries: args.maxRetries,
    });
    if (args.output) {
      await Bun.write(args.output, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatFunnelEvalSummary(report));
      if (args.output) console.log(`Wrote report: ${args.output}`);
    }
    if (report.passed !== report.total) process.exitCode = 1;
  } finally {
    await close();
  }
}

function selectScenarios(id: string | undefined): readonly FunnelEvalScenario[] {
  if (!id) return DEFAULT_FUNNEL_EVAL_SCENARIOS;
  const scenario = DEFAULT_FUNNEL_EVAL_SCENARIOS.find((item) => item.id === id);
  if (!scenario) {
    throw new Error(
      `Unknown scenario "${id}". Available: ${DEFAULT_FUNNEL_EVAL_SCENARIOS.map((item) => item.id).join(", ")}`,
    );
  }
  return [scenario];
}

async function resolveChatClient(args: CliArgs): Promise<{
  client: ReturnType<InMemoryLlmRouter["resolveChat"]>;
  close: () => Promise<void>;
}> {
  const envProvider = process.env.LLM_PROVIDER as LlmProvider | undefined;
  const envModel = process.env.LLM_MODEL;
  if (envProvider && envModel) {
    const router = new InMemoryLlmRouter();
    const tenantId = args.tenantId ?? 1;
    const apiKey = process.env.LLM_API_KEY;
    if (envProvider !== "ollama" && !apiKey) {
      throw new Error("LLM_API_KEY env required for non-ollama providers");
    }
    router.setConfig({
      tenantId,
      purpose: "chat",
      provider: envProvider,
      model: envModel,
      ...(apiKey ? { apiKey } : {}),
      ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
    });
    return {
      client: router.resolveChat(tenantId, "chat"),
      close: async () => {},
    };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL required when LLM_PROVIDER/LLM_MODEL env fallback is not set");
  }
  const cfg = loadApiConfig();
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tenantId = await resolveTenantId(db, args);
  const loaded = await loadTenantLlmConfigs({
    db,
    tenantIds: [tenantId],
    envFallback: cfg,
    masterKeyHex: cfg.masterKeyHex,
    onError: (message, ctx) => {
      console.error(`[llm-config] ${message}`, JSON.stringify(ctx));
    },
  });
  const chatCfg = loaded.byTenant.get(tenantId)?.get("chat");
  if (!chatCfg) {
    throw new Error(
      `No chat LLM config for tenantId=${tenantId}. Set LLM_PROVIDER/LLM_MODEL or configure tenant BYOK.`,
    );
  }
  const router = new InMemoryLlmRouter();
  router.setConfig({
    tenantId,
    purpose: "chat",
    provider: chatCfg.provider as LlmProvider,
    model: chatCfg.model,
    ...(chatCfg.apiKey ? { apiKey: chatCfg.apiKey } : {}),
    ...(chatCfg.baseUrl ? { baseUrl: chatCfg.baseUrl } : {}),
    ...(chatCfg.timeoutMs ? { timeoutMs: chatCfg.timeoutMs } : {}),
  });
  return {
    client: router.resolveChat(tenantId, "chat"),
    close: async () => {
      await sql.end({ timeout: 0 }).catch(() => {});
    },
  };
}

async function resolveTenantId(
  db: PostgresJsDatabase<typeof schema>,
  args: CliArgs,
): Promise<number> {
  if (args.tenantId) return args.tenantId;
  if (args.tenant) {
    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, args.tenant))
      .limit(1);
    if (!tenant) throw new Error(`Tenant slug=${args.tenant} not found`);
    return tenant.id;
  }
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"))
    .limit(1);
  if (!tenant) throw new Error("No active tenant found; pass --tenant-id=<id>");
  return tenant.id;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
