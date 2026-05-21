#!/usr/bin/env bun
/**
 * Coach batch admin-job: проходит по terminal leads (won/lost/closed) и
 * вызывает CoachAnalyzer.analyzeLead для каждого. Результат — записи в
 * skill_outcomes для дальнейшего win-rate analytics.
 *
 * Запускать по cron, например раз в час:
 *   bun run apps/api/scripts/coach-batch.ts --tenant=alpha --hours=1
 *
 * Idempotent: SkillOutcomesRepo.record делает ON CONFLICT DO NOTHING на
 * (lead_id, skill_slug, source) — повторный прогон в окне = no-op.
 *
 * Env:
 *   DATABASE_URL
 *   LLM_PROVIDER, LLM_MODEL, LLM_API_KEY [, LLM_BASE_URL]
 *   COACH_GRADING_MODEL  (опционально, lightweight model для cheap grading)
 *   COACH_AVAILABLE_SKILLS (опционально, CSV slug'ов; default — 25 builtin
 *     skills из rag/sales)
 */

import {
  ConversationsRepo,
  MessagesRepo,
  SkillOutcomesRepo,
} from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { CoachAnalyzer } from "@chatman-media/sales";
import { makeDefaultLogger } from "@chatman-media/observability";
import * as schema from "@chatman-media/storage";
import { leads, tenants } from "@chatman-media/storage";
import { and, eq, gte, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface Args {
  tenant: string;
  hours: number;
  outcome: "won" | "lost" | "draw" | null;
}

function parseArgs(): Args {
  const args: Partial<Args> = { hours: 24 };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (!k || !v) continue;
    if (k === "tenant") args.tenant = v;
    if (k === "hours") args.hours = Number.parseInt(v, 10) || 24;
    if (k === "outcome" && (v === "won" || v === "lost" || v === "draw")) {
      args.outcome = v;
    }
  }
  if (!args.tenant) throw new Error("--tenant=<slug> required");
  return { tenant: args.tenant, hours: args.hours ?? 24, outcome: args.outcome ?? null };
}

// Default 25 skills из rag persuasion catalog. Override через
// COACH_AVAILABLE_SKILLS env (CSV slug'ов) если operator хочет узкий набор.
const DEFAULT_SKILLS = [
  "social-proof-stat",
  "tactical-empathy",
  "calibrated-question",
  "liking-genuine-compliment",
  "accusation-audit",
  "authority-license",
  "scarcity-spots-left",
  "reciprocity-free-info",
  "unity-belonging",
  "commitment-microyes",
  "mirroring",
] as const;

// Terminal states из leads_state_check (миграция 0000/0002). Coach-анализ
// нужен на лиды дошедшие до финала пайплайна:
//   ready_to_work → won (контракт подписан, кандидат выехал)
//   rejected      → lost (оператор отказал на любой стадии)
//   closed        → won (lead закрыт без рестарта; lifecycle завершён)
const TERMINAL_STATES = ["ready_to_work", "rejected", "closed"] as const;

function leadStateToOutcome(state: string): "won" | "lost" | "draw" {
  if (state === "ready_to_work" || state === "closed") return "won";
  if (state === "rejected") return "lost";
  return "draw";
}

function leadStateToSource(
  state: string,
): "lead_submitted" | "lead_rejected" | "lead_ghosted" | "manual" {
  if (state === "ready_to_work" || state === "closed") return "lead_submitted";
  if (state === "rejected") return "lead_rejected";
  return "lead_ghosted";
}

async function main() {
  const log = makeDefaultLogger("coach-batch");
  const args = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL env required");
  const provider = process.env.LLM_PROVIDER as "openai" | "openrouter" | "ollama" | undefined;
  const model = process.env.LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY;
  if (!provider || !model || !apiKey) {
    throw new Error("LLM_PROVIDER + LLM_MODEL + LLM_API_KEY env required");
  }

  const availableSlugs = (
    process.env.COACH_AVAILABLE_SKILLS?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? DEFAULT_SKILLS
  ) as readonly string[];

  const client = postgres(databaseUrl, { max: 4 });
  const db = drizzle(client, { schema });

  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, args.tenant));
    if (!tenant) throw new Error(`tenant slug=${args.tenant} not found`);
    log.info("starting", {
      tenant: tenant.slug,
      tenantId: tenant.id,
      hours: args.hours,
      outcomeFilter: args.outcome ?? "any",
      skills: availableSlugs.length,
    });

    const cutoff = Math.floor(Date.now() / 1000) - args.hours * 3600;
    const candidateLeads = await db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, tenant.id),
          inArray(leads.state, TERMINAL_STATES as unknown as string[]),
          gte(leads.updatedAt, cutoff),
        ),
      );
    log.info("candidate leads", { count: candidateLeads.length });

    const router = new InMemoryLlmRouter();
    router.setConfig({
      tenantId: tenant.id,
      purpose: "chat",
      provider,
      model,
      apiKey,
      ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
    });

    const analyzer = new CoachAnalyzer({
      availableSlugs,
      resolveChat: (tid: number) => router.resolveChat(tid, "chat"),
      ...(process.env.COACH_GRADING_MODEL
        ? { gradingModel: process.env.COACH_GRADING_MODEL }
        : {}),
    });

    let totalPairs = 0;
    let totalRecorded = 0;
    let totalDuplicate = 0;
    let processedLeads = 0;
    let skippedLeads = 0;

    for (const lead of candidateLeads) {
      const outcome = leadStateToOutcome(lead.state);
      if (args.outcome && outcome !== args.outcome) {
        skippedLeads += 1;
        continue;
      }
      const source = leadStateToSource(lead.state);
      // Lead.userId references contacts.id (after migration 0007). Conversation
      // user_id ↔ contact.id same mapping. Resolve conversation by lead.user_id.
      const convsRepo = new ConversationsRepo({ db, tenantId: tenant.id });
      const conv = await convsRepo.findByContactAndSource(lead.userId, "userbot");
      const convBot = conv ?? (await convsRepo.findByContactAndSource(lead.userId, "bot"));
      if (!convBot) {
        log.warn("no conversation for lead", { leadId: lead.id, contactId: lead.userId });
        skippedLeads += 1;
        continue;
      }
      const styleSlug: string | null = null; // TODO: resolve styles.slug по conv.style_id если есть
      void drizzleSql; // не используется, оставлено для future raw queries
      try {
        const result = await analyzer.analyzeLead(
          {
            messages: new MessagesRepo({ db, tenantId: tenant.id }),
            skillOutcomes: new SkillOutcomesRepo({ db, tenantId: tenant.id }),
          },
          {
            lead: { id: lead.id, tenantId: tenant.id },
            conversationId: convBot.id,
            outcome,
            source,
            styleSlug,
            nowEpoch: Math.floor(Date.now() / 1000),
          },
        );
        totalPairs += result.pairsAnalyzed;
        totalRecorded += result.outcomesRecorded;
        totalDuplicate += result.outcomesDuplicate;
        processedLeads += 1;
      } catch (err) {
        log.error("analyzeLead failed", {
          leadId: lead.id,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        skippedLeads += 1;
      }
    }

    log.info("done", {
      processedLeads,
      skippedLeads,
      totalPairs,
      totalRecorded,
      totalDuplicate,
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[coach-batch] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
