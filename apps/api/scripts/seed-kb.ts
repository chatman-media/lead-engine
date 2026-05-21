#!/usr/bin/env bun
/**
 * Seed KB documents для tenant'а через @chatman-media/rag.ingestDirectory.
 * Скрипт читает все поддерживаемые файлы из директории, чанкует, эмбеддит,
 * пишет в kb_documents + kb_chunks через DrizzleKbStore (tenant-scoped).
 *
 * Usage:
 *   bun run apps/api/scripts/seed-kb.ts \
 *     --tenant=legacy \
 *     --dir=./kb-sources
 *
 * Env:
 *   DATABASE_URL — Postgres URL
 *   LLM_EMBED_PROVIDER=openai|ollama
 *   LLM_EMBED_MODEL=text-embedding-3-small (или другая)
 *   LLM_EMBED_API_KEY=sk-... (для openai)
 *   LLM_EMBED_DIM=1536 — должна совпадать с storage.kb_chunks.embedding
 *   LLM_EMBED_BASE_URL (опционально)
 *
 * Идемпотентность: ingestFile sequence через content_hash dedup'ится в
 * upsertDocument; повторный прогон не создаёт дублей chunks (документ
 * пропускается если content_hash совпал).
 */

import { DrizzleKbStore } from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { ingestDirectory, type EmbeddingClient as RagEmbeddingClient } from "@chatman-media/rag";
import * as schema from "@chatman-media/storage";
import { tenants } from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";

interface Args {
  tenantSlug: string;
  dir: string;
  topic: string | null;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (!k || v === undefined) continue;
    if (k === "tenant") out.tenantSlug = v;
    else if (k === "dir") out.dir = v;
    else if (k === "topic") out.topic = v;
  }
  if (!out.tenantSlug) throw new Error("--tenant=<slug> required");
  if (!out.dir) throw new Error("--dir=<path> required");
  return { tenantSlug: out.tenantSlug, dir: out.dir, topic: out.topic ?? null };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} required`);
  return v;
}

async function main() {
  const args = parseArgs();
  const databaseUrl = required("DATABASE_URL");
  const embedProvider = required("LLM_EMBED_PROVIDER") as "openai" | "openrouter" | "ollama";
  const embedModel = required("LLM_EMBED_MODEL");
  const embedDim = Number.parseInt(process.env.LLM_EMBED_DIM ?? "1536", 10);
  const embedApiKey = process.env.LLM_EMBED_API_KEY ?? process.env.LLM_API_KEY ?? "";
  const embedBaseUrl = process.env.LLM_EMBED_BASE_URL;

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client, { schema });

  try {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, args.tenantSlug));
    if (!tenant) throw new Error(`tenant slug=${args.tenantSlug} not found`);

    const router = new InMemoryLlmRouter();
    router.setConfig({
      tenantId: tenant.id,
      purpose: "embed",
      provider: embedProvider,
      model: embedModel,
      ...(embedApiKey ? { apiKey: embedApiKey } : {}),
      embedDim,
      ...(embedBaseUrl ? { baseUrl: embedBaseUrl } : {}),
    });
    const embedder = router.resolveEmbed(tenant.id) as unknown as RagEmbeddingClient;
    const kb = new DrizzleKbStore({ db, tenantId: tenant.id });

    console.log(
      `[seed-kb] tenant=${tenant.slug} (id=${tenant.id}) dir=${args.dir} ` +
        `embed=${embedProvider}/${embedModel}/dim=${embedDim}` +
        (args.topic ? ` topic=${args.topic}` : ""),
    );

    const summary = await ingestDirectory(args.dir, {
      kb,
      embedder,
      topic: args.topic,
    });

    console.log(
      `[seed-kb] done: ${summary.documents} documents, ${summary.chunks} chunks, ${summary.skipped} skipped`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-kb] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
