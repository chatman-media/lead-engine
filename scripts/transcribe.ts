#!/usr/bin/env bun
/**
 * Transcribes voice messages from a Telegram export.
 *
 * Walks `result.json`, finds `media_type=voice_message` entries (default:
 * only from the agent; pass `--all` to include candidates too), and sends
 * each `.ogg` file to a Whisper-compatible endpoint. Transcripts are
 * cached one file at a time, so the script is fully resumable — re-runs
 * skip files that already have a transcript.
 *
 *   kb/extracted/voice/transcripts/<chat_dir>__<file_stem>.txt
 *
 * On the next run of `extract-tg.ts`, those transcripts are picked up
 * automatically and inlined into the dialog files at the right position.
 *
 * Usage:
 *   bun scripts/transcribe.ts <result.json> [outDir] [--all] [--agent <id>]
 *                             [--dry-run]
 *
 * Configuration via env (in .env or shell):
 *   WHISPER_BASE_URL    default https://api.openai.com/v1
 *   WHISPER_API_KEY     required unless --dry-run; falls back to OPENAI_API_KEY
 *   WHISPER_MODEL       default whisper-1
 *   WHISPER_LANGUAGE    default ru
 *
 * Tip: for a fully local setup, run faster-whisper-server (or any OAI-
 * compatible Whisper proxy) and point WHISPER_BASE_URL at it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

interface TgMessage {
  type: string;
  date: string;
  from?: string;
  from_id?: string;
  media_type?: string;
  file?: string;
  duration_seconds?: number;
}
interface TgChat {
  id: number;
  name?: string;
  messages: TgMessage[];
}
interface TgExport {
  chats: { list: TgChat[] };
}

const DEFAULT_AGENT_ID = "user8201160309";

interface Args {
  input: string;
  outDir: string;
  agentId: string;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const positional: string[] = [];
  let agentId = DEFAULT_AGENT_ID;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v === "--all") all = true;
    else if (v === "--dry-run") dryRun = true;
    else if (v === "--agent") agentId = a[++i] ?? agentId;
    else positional.push(v);
  }
  const input = positional[0];
  if (!input) {
    console.error(
      "Usage: bun scripts/transcribe.ts <result.json> [outDir] [--all] " +
        "[--agent <id>] [--dry-run]",
    );
    process.exit(1);
  }
  const outDir = positional[1] ?? join(dirname(resolve(input)), "extracted");
  return {
    input: resolve(input),
    outDir: resolve(outDir),
    agentId,
    all,
    dryRun,
  };
}

/** Tiny .env loader for environments without bun (which loads .env natively). */
function loadDotenv() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(dirname(process.argv[1] ?? "."), "..", ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return;
  }
}

interface VoiceTask {
  chat: string;
  chatDir: string;
  file: string; // relative to result.json's parent
  absFile: string;
  date: string;
  duration: number;
  fromAgent: boolean;
  cachePath: string;
}

function cacheKeyFor(file: string): { chatDir: string; stem: string } {
  // e.g. "chats/chat_002/voice_messages/audio_1@20-04-2026_17-19-29.ogg"
  const parts = file.split("/");
  const chatDir = parts[1] ?? "chat_unknown";
  const stem = basename(parts[parts.length - 1]!, extname(parts[parts.length - 1]!));
  return { chatDir, stem };
}

function collectTasks(input: string, outDir: string, agentId: string, all: boolean): VoiceTask[] {
  const data = JSON.parse(readFileSync(input, "utf8")) as TgExport;
  const root = dirname(input);
  const transcriptsDir = join(outDir, "voice", "transcripts");
  const tasks: VoiceTask[] = [];
  for (const chat of data.chats.list) {
    for (const m of chat.messages ?? []) {
      if (m.type !== "message") continue;
      if (m.media_type !== "voice_message" || !m.file) continue;
      const fromAgent = m.from_id === agentId;
      if (!all && !fromAgent) continue;
      const { chatDir, stem } = cacheKeyFor(m.file);
      tasks.push({
        chat: chat.name ?? `chat-${chat.id}`,
        chatDir,
        file: m.file,
        absFile: join(root, m.file),
        date: m.date,
        duration: m.duration_seconds ?? 0,
        fromAgent,
        cachePath: join(transcriptsDir, `${chatDir}__${stem}.txt`),
      });
    }
  }
  return tasks;
}

async function transcribeOne(
  task: VoiceTask,
  cfg: { baseUrl: string; apiKey: string; model: string; language: string },
): Promise<string> {
  const buf = readFileSync(task.absFile);
  // Build multipart manually via FormData / Blob (Node ≥18 has these globals).
  const fd = new FormData();
  const blob = new Blob([buf], { type: "audio/ogg" });
  fd.append("file", blob, basename(task.absFile));
  fd.append("model", cfg.model);
  fd.append("language", cfg.language);
  fd.append("response_format", "text");

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.text()).trim();
}

async function main() {
  loadDotenv();
  const args = parseArgs();
  const tasks = collectTasks(args.input, args.outDir, args.agentId, args.all);
  const transcriptsDir = join(args.outDir, "voice", "transcripts");
  if (!existsSync(transcriptsDir)) mkdirSync(transcriptsDir, { recursive: true });

  const todo = tasks.filter((t) => !existsSync(t.cachePath));
  const done = tasks.length - todo.length;
  const totalSec = todo.reduce((s, t) => s + t.duration, 0);

  console.log(`[transcribe] ${tasks.length} voice messages found`);
  console.log(`             ${done} already cached, ${todo.length} to process`);
  console.log(`             ~${Math.round(totalSec / 60)}min audio queued (${totalSec}s)`);

  if (args.dryRun) {
    console.log("[transcribe] dry-run: not calling API. Files that would be transcribed:");
    for (const t of todo) {
      console.log(
        `  [${t.duration}s] ${t.fromAgent ? "AGENT" : "USER "} ${t.chat}  →  ${t.cachePath}`,
      );
    }
    return;
  }

  const apiKey = process.env.WHISPER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "\n[transcribe] Neither WHISPER_API_KEY nor OPENAI_API_KEY is set.\n" +
        "             Add one to .env, or run with --dry-run to see the plan.\n" +
        "             Tip: WHISPER_BASE_URL can point to any OpenAI-compatible\n" +
        "             /v1/audio/transcriptions endpoint (e.g. faster-whisper-server\n" +
        "             running locally — no cloud API needed).",
    );
    process.exit(1);
  }
  const cfg = {
    baseUrl: process.env.WHISPER_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: process.env.WHISPER_MODEL ?? "whisper-1",
    language: process.env.WHISPER_LANGUAGE ?? "ru",
  };
  console.log(`[transcribe] using ${cfg.baseUrl}  model=${cfg.model}  lang=${cfg.language}`);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]!;
    const tag = `[${i + 1}/${todo.length}] ${t.chat} (${t.duration}s)`;
    try {
      const text = await transcribeOne(t, cfg);
      writeFileSync(t.cachePath, `${text}\n`, "utf8");
      ok++;
      const preview = text.replace(/\s+/g, " ").slice(0, 60);
      console.log(`  ${tag}  ✓  ${preview}${text.length > 60 ? "…" : ""}`);
    } catch (err) {
      failed++;
      console.error(`  ${tag}  ✗  ${(err as Error).message}`);
    }
  }
  console.log(`[transcribe] done: ${ok} ok, ${failed} failed, cached in ${transcriptsDir}`);
  console.log(`[transcribe] re-run "extract-tg.ts" to inline transcripts into dialog files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
