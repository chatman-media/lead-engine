#!/usr/bin/env bun

/**
 * Local transcription via `nodejs-whisper` (whisper.cpp wrapper).
 * No cloud API, no Docker. The whisper model is downloaded on first run.
 *
 * Prerequisites:
 *   bun add -d nodejs-whisper
 *   bun install --trust nodejs-whisper   # required: postinstall builds whisper.cpp
 *   ffmpeg in PATH                       # brew install ffmpeg / apt install ffmpeg
 *
 * Usage:
 *   bun scripts/transcribe-local.ts <result.json> [outDir]
 *                                       [--all]                 # also candidate voices
 *                                       [--agent id1,id2,...]   # override agent ids
 *                                       [--model small]         # tiny|base|small|medium|large-v3
 *                                       [--language ru]         # default ru
 *                                       [--limit 10]            # cap files (testing)
 *
 * Output cache (one .txt per voice file, mirrors transcribe.ts layout):
 *   <outDir>/voice/transcripts/<chat_dir>__<file_stem>.txt
 *
 * After it finishes:
 *   bun scripts/extract-tg.ts <result.json> <outDir>
 * — picks up the cached transcripts and inlines them into dialogs/*.md.
 *
 * Model size cheat-sheet (CPU, M1-class):
 *   tiny     75 MB   ~0.3× realtime  fair quality
 *   base    142 MB   ~0.5× realtime  ok
 *   small   465 MB   ~1×   realtime  good (recommended for ru)
 *   medium  1.5 GB   ~3×   realtime  very good
 *   large   2.9 GB   ~6×+  realtime  best, slow on CPU
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

// Known agent IDs across both exports we have. --agent overrides this entirely.
const DEFAULT_AGENTS = [
  "user8201160309", // Manager ALINA — first export
  "user1407915708", // 魔術 — main account in sec/result.json
  "channel2578052324", // INFINITY AGENCY official channel
];

interface Args {
  input: string;
  outDir: string;
  agentIds: Set<string>;
  all: boolean;
  model: string;
  language: string;
  limit?: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const positional: string[] = [];
  const agentIds = new Set<string>();
  let all = false;
  let model = "small";
  let language = "ru";
  let limit: number | undefined;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v === "--all") all = true;
    else if (v === "--agent") {
      const raw = a[++i] ?? "";
      for (const s of raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        agentIds.add(s);
      }
    } else if (v === "--model") model = a[++i] ?? model;
    else if (v === "--language") language = a[++i] ?? language;
    else if (v === "--limit") limit = parseInt(a[++i] ?? "", 10);
    else positional.push(v);
  }
  if (agentIds.size === 0) for (const id of DEFAULT_AGENTS) agentIds.add(id);
  if (!positional[0]) {
    console.error(
      "Usage: bun scripts/transcribe-local.ts <result.json> [outDir] " +
        "[--all] [--agent id1,id2] [--model small] [--language ru] [--limit N]",
    );
    process.exit(1);
  }
  return {
    input: resolve(positional[0]!),
    outDir: resolve(positional[1] ?? join(dirname(resolve(positional[0]!)), "extracted")),
    agentIds,
    all,
    model,
    language,
    ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
  };
}

interface Task {
  chatDir: string;
  fileStem: string;
  absOgg: string;
  cachePath: string;
  duration: number;
  fromAgent: boolean;
  chat: string;
  date: string;
}

function collectTasks(args: Args): Task[] {
  const data = JSON.parse(readFileSync(args.input, "utf8")) as TgExport;
  const root = dirname(args.input);
  const transcriptsDir = join(args.outDir, "voice", "transcripts");
  const tasks: Task[] = [];
  for (const c of data.chats.list) {
    for (const m of c.messages ?? []) {
      if (m.type !== "message" || m.media_type !== "voice_message" || !m.file) continue;
      const fromAgent = m.from_id ? args.agentIds.has(m.from_id) : false;
      if (!args.all && !fromAgent) continue;
      const parts = m.file.split("/");
      const chatDir = parts[1] ?? "chat_unknown";
      const fname = parts[parts.length - 1] ?? "";
      const stem = basename(fname, extname(fname));
      tasks.push({
        chatDir,
        fileStem: stem,
        absOgg: join(root, m.file),
        cachePath: join(transcriptsDir, `${chatDir}__${stem}.txt`),
        duration: m.duration_seconds ?? 0,
        fromAgent,
        chat: c.name ?? `chat-${c.id}`,
        date: m.date,
      });
    }
  }
  return tasks;
}

function hasFfmpeg(): boolean {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0;
}

/** Convert .ogg/opus → .wav 16kHz mono (whisper.cpp's expected input). */
function convertToWav(oggPath: string, wavPath: string): boolean {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-loglevel", "error", wavPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return r.status === 0;
}

async function importNodejsWhisper(): Promise<
  ((path: string, opts: unknown) => Promise<unknown>) | null
> {
  try {
    const mod = await import("nodejs-whisper");
    // @ts-expect-error: dynamic import shape
    return mod.nodewhisper ?? mod.default ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();

  if (!hasFfmpeg()) {
    console.error(
      "[transcribe-local] ffmpeg not found in PATH.\n" +
        "Install: brew install ffmpeg  (macOS) | apt install ffmpeg  (linux)",
    );
    process.exit(1);
  }

  const nodewhisper = await importNodejsWhisper();
  if (!nodewhisper) {
    console.error(
      "[transcribe-local] missing 'nodejs-whisper' package.\n" +
        "Install:\n" +
        "  bun add -d nodejs-whisper\n" +
        "  bun install --trust nodejs-whisper   # builds whisper.cpp via postinstall\n" +
        "Then re-run this script.",
    );
    process.exit(1);
  }

  const tasks = collectTasks(args);
  const transcriptsDir = join(args.outDir, "voice", "transcripts");
  if (!existsSync(transcriptsDir)) mkdirSync(transcriptsDir, { recursive: true });
  const tmpDir = join(args.outDir, "voice", ".wav-tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  let todo = tasks.filter((t) => !existsSync(t.cachePath));
  if (args.limit !== undefined) todo = todo.slice(0, args.limit);
  const done = tasks.length - todo.length;
  const totalSec = todo.reduce((s, t) => s + t.duration, 0);

  console.log(`[transcribe-local] voices found:    ${tasks.length}`);
  console.log(`                   already cached:  ${done}`);
  console.log(`                   to process:      ${todo.length}`);
  console.log(
    `                   queue duration:  ~${Math.round(totalSec / 60)} min (${totalSec}s)`,
  );
  console.log(`                   model:           ${args.model}    language: ${args.language}`);

  if (todo.length === 0) {
    console.log("[transcribe-local] nothing to do.");
    return;
  }

  let ok = 0;
  let fail = 0;
  const startedAt = Date.now();

  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]!;
    const tag = `[${i + 1}/${todo.length}] ${t.chat} (${t.duration}s)`;
    const wavPath = join(tmpDir, `${t.chatDir}__${t.fileStem}.wav`);

    try {
      if (!existsSync(t.absOgg)) {
        throw new Error(`source missing: ${t.absOgg}`);
      }
      if (!convertToWav(t.absOgg, wavPath)) {
        throw new Error("ffmpeg conversion failed");
      }

      // Run whisper. We don't trust the return value — across nodejs-whisper
      // versions it can include word-level timestamps and split sub-words.
      // Instead we read the plain `.txt` file whisper.cpp generates next to
      // the input WAV (because of `outputInText: true`).
      await nodewhisper(wavPath, {
        modelName: args.model,
        autoDownloadModelName: args.model,
        removeWavFileAfterTranscription: false,
        verbose: false,
        withCuda: false,
        whisperOptions: {
          outputInText: true, // produces <wavPath>.txt with clean prose
          outputInVtt: false,
          outputInSrt: false,
          outputInCsv: false,
          translateToEnglish: false,
          wordTimestamps: false,
          timestamps_length: 0,
          splitOnWord: true,
          language: args.language,
        },
      });

      const txtPath = `${wavPath}.txt`;
      let transcript = "";
      if (existsSync(txtPath)) {
        transcript = readFileSync(txtPath, "utf8");
        try {
          unlinkSync(txtPath);
        } catch {
          /* ignore */
        }
      }

      const cleaned = transcript
        // strip any timestamps that whisper.cpp may still emit
        // ("[00:00:00.000 --> 00:00:00.320]" / "[00:00.000 --> 00:00.320]")
        .replace(
          /\[\d{1,2}:\d{2}(?::\d{2})?\.\d{3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?\.\d{3}\]\s*/g,
          "",
        )
        // strip non-speech tokens
        .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|SOUND)\]/gi, "")
        // strip leading speaker tags
        .replace(/^\s*\([A-Z_0-9]+\)\s*/g, "")
        // collapse whitespace, but keep sentence-ending punctuation tight
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .trim();

      if (!cleaned) {
        // Empty audio is still a result — write empty file to mark "done"
        writeFileSync(t.cachePath, "", "utf8");
      } else {
        writeFileSync(t.cachePath, `${cleaned}\n`, "utf8");
      }
      ok++;
      const preview = cleaned.slice(0, 80);
      console.log(`  ${tag}  ✓  ${preview}${cleaned.length > 80 ? "…" : ""}`);
    } catch (err) {
      fail++;
      console.error(`  ${tag}  ✗  ${(err as Error).message}`);
    } finally {
      if (existsSync(wavPath)) {
        try {
          unlinkSync(wavPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n[transcribe-local] done in ${elapsed}s: ${ok} ok, ${fail} failed.`);
  console.log(`[transcribe-local] cache: ${transcriptsDir}`);
  console.log(
    `[transcribe-local] next: bun scripts/extract-tg.ts ${args.input} ${args.outDir}` +
      ` (will inline transcripts into dialogs/*.md).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
