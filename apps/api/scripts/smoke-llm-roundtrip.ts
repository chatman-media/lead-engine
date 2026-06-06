#!/usr/bin/env bun
/**
 * Smoke-roundtrip end-to-end под реальной LLM. Поток:
 *   1. Connect WS на /ws/<slug>?user=<id>
 *   2. Receive ready-frame
 *   3. Send user_text frame
 *   4. Poll outbound_queue до status='sent' / status='pending' с payload_json
 *      где есть bot text
 *   5. Print metrics: latency, reply preview
 *
 * Pre-conditions:
 *   - apps/api running (e.g. bun dev) с LLM_PROVIDER configured
 *   - tenant с web-channel onboarded (e.g. onboard-tenant.ts --with-web)
 *   - Postgres up (см. bun db:up)
 *
 * Usage:
 *   bun run apps/api/scripts/smoke-llm-roundtrip.ts --slug=smoke --user=u1 --text="привет"
 *
 * Exits 0 on success (reply received within timeout), 1 otherwise.
 */

import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../packages/storage/src/index.ts";

interface Args {
  slug: string;
  user: string;
  text: string;
  host: string;
  port: number;
  timeoutMs: number;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (!k || v === undefined) continue;
    if (k === "slug") out.slug = v;
    else if (k === "user") out.user = v;
    else if (k === "text") out.text = v;
    else if (k === "host") out.host = v;
    else if (k === "port") out.port = Number.parseInt(v, 10);
    else if (k === "timeout-ms") out.timeoutMs = Number.parseInt(v, 10);
  }
  return {
    slug: out.slug ?? "smoke",
    user: out.user ?? `u-${Date.now()}`,
    text: out.text ?? "привет",
    host: out.host ?? "localhost",
    port: out.port ?? 3000,
    timeoutMs: out.timeoutMs ?? 120_000,
  };
}

async function main() {
  const args = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env required");
  const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  // 1. Locate tenant + web channel.
  const tenantRow = (
    await db.select().from(schema.tenants).where(eq(schema.tenants.slug, args.slug))
  )[0];
  if (!tenantRow) throw new Error(`tenant slug=${args.slug} not found — onboard first`);
  const channelRow = (
    await db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.tenantId, tenantRow.id),
          eq(schema.channels.kind, "web"),
          eq(schema.channels.status, "active"),
        ),
      )
  )[0];
  if (!channelRow) throw new Error(`no active web channel for tenant ${args.slug} — onboard with --with-web`);
  console.log(`[smoke] tenant id=${tenantRow.id} slug=${tenantRow.slug} web-channel id=${channelRow.id}`);

  // 2. Snapshot outbound queue (нам нужны rows ПОСЛЕ нашего message'а).
  const beforeRows = await db
    .select({ id: schema.outboundQueue.id })
    .from(schema.outboundQueue)
    .where(eq(schema.outboundQueue.tenantId, tenantRow.id));
  const knownIds = new Set(beforeRows.map((r) => r.id));
  console.log(`[smoke] baseline outbound rows: ${beforeRows.length}`);

  // 3. Connect WS, send user_text.
  const wsUrl = `ws://${args.host}:${args.port}/ws/${args.slug}?user=${encodeURIComponent(args.user)}`;
  console.log(`[smoke] connecting ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  const startedAt = performance.now();
  let receivedReply: { id: string; text: string } | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      console.log("[smoke] ws open");
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e}`));
    });
  });

  // Listen for bot_text frame.
  ws.addEventListener("message", (ev) => {
    try {
      const frame = JSON.parse(ev.data as string);
      if (frame.type === "ready") {
        console.log(
          `[smoke] ready (channel=${String(frame.channelId).replace(/\n|\r/g, "")}, user=${String(frame.userId).replace(/\n|\r/g, "")})`,
        );
      } else if (frame.type === "bot_text") {
        receivedReply = { id: frame.id, text: frame.text };
        console.log(`[smoke] bot_text received (${String(frame.text).replace(/\n|\r/g, "").length} chars)`);
      } else {
        console.log("[smoke] unknown frame:", JSON.stringify(frame).replace(/\n|\r/g, ""));
      }
    } catch (err) {
      console.error("[smoke] parse error", err);
    }
  });

  // Wait briefly to receive ready.
  await new Promise((r) => setTimeout(r, 200));

  // 4. Send user_text.
  const msgId = `smoke-${Date.now()}`;
  ws.send(JSON.stringify({ type: "user_text", id: msgId, text: args.text }));
  console.log(`[smoke] sent user_text id=${msgId} text=${JSON.stringify(args.text)}`);

  // 5. Poll outbound_queue для нового row (status 'sent'/'pending'/'processing').
  const deadline = Date.now() + args.timeoutMs;
  let newRow: { id: number; status: string; payloadJson: string; lastError: string | null } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db
      .select({
        id: schema.outboundQueue.id,
        status: schema.outboundQueue.status,
        payloadJson: schema.outboundQueue.payloadJson,
        lastError: schema.outboundQueue.lastError,
      })
      .from(schema.outboundQueue)
      .where(eq(schema.outboundQueue.tenantId, tenantRow.id))
      .orderBy(desc(schema.outboundQueue.id));
    const candidate = rows.find((r) => !knownIds.has(r.id));
    if (candidate) {
      newRow = candidate;
      console.log(
        `[smoke] outbound row id=${newRow.id} status=${newRow.status} (${
          ((Date.now() - (startedAt + performance.timeOrigin)) / 1000).toFixed(1)
        }s ${newRow.status === "sent" ? "delivered" : "queued"})`,
      );
      break;
    }
  }

  ws.close();
  await sql.end({ timeout: 0 });

  if (!newRow) {
    console.error(`[smoke] FAIL: no outbound row created within ${args.timeoutMs / 1000}s`);
    process.exit(1);
  }

  // 6. Parse payload, print reply preview.
  const env = JSON.parse(newRow.payloadJson) as {
    parts: Array<{ kind: string; text?: string }>;
  };
  const replyText = env.parts
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  console.log("\n========== LLM REPLY ==========");
  console.log(replyText || "<empty>");
  console.log("================================");
  console.log(`[smoke] queue status: ${newRow.status}${newRow.lastError ? ` (error: ${newRow.lastError})` : ""}`);

  if (receivedReply) {
    console.log(`[smoke] WS bot_text frame: ${String(receivedReply.text).replace(/\n|\r/g, "").length} chars (matched DB: ${receivedReply.text === replyText})`);
  } else {
    console.log("[smoke] ⚠ WS bot_text frame NOT received — adapter.send not invoked in time");
  }

  if (newRow.status === "failed") {
    console.error("[smoke] FAIL: outbound marked failed");
    process.exit(1);
  }
  if (!replyText.trim()) {
    console.error("[smoke] FAIL: reply text empty");
    process.exit(1);
  }
  const elapsedSec = ((Date.now() - (startedAt + performance.timeOrigin)) / 1000).toFixed(2);
  console.log(`[smoke] ✅ SUCCESS: roundtrip in ${elapsedSec}s`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
