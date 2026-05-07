#!/usr/bin/env bun
/**
 * Extracts a knowledge-base corpus from a Telegram Desktop export
 * (`result.json`).
 *
 * Output goes into <outDir> with this structure:
 *   posts/    deduplicated long broadcast messages from the agent
 *             (vacancy posts, FAQs, application templates, etc.)
 *   dialogs/  cleaned Q&A from work-related conversations:
 *             user question(s) → agent reply(ies), grouped chronologically
 *   voice/INDEX.md     list of agent voice messages to transcribe later
 *   README.md          summary of what was extracted
 *
 * Usage:
 *   bun scripts/extract-tg.ts <result.json> <outDir> [--agent <from_id>]
 *
 * Defaults assume the agent is user8201160309 (Manager ALINA | INFINITY AGENCY).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

interface TgTextEntity {
  type?: string;
  text?: string;
}
type TgText = string | (string | TgTextEntity)[] | undefined;

interface TgMessage {
  id: number;
  type: string;
  date: string;
  date_unixtime?: string;
  from?: string;
  from_id?: string;
  text?: TgText;
  media_type?: string;
  file?: string;
  duration_seconds?: number;
  forwarded_from?: string;
}

interface TgChat {
  name?: string;
  type: string;
  id: number;
  messages: TgMessage[];
}

interface TgExport {
  chats: { list: TgChat[] };
}

const DEFAULT_AGENT_ID = "user8201160309";
const MIN_BROADCAST_LEN = 250; // chars; agent messages shorter than this are not "posts"
const SHORT_AGENT_REPLY_MIN_LEN = 8; // skip "ага", "ок", "👍"
const _MAX_GAP_SECONDS = 60 * 60 * 6; // 6h between user msg and agent reply still counts as same Q&A

const WORK_RE =
  /(агентств|работ|ваканс|зарплат|резюм|собеседован|оффер|деньг|оплат|клиент|сотрудни|команд|проект|менедж|фриланс|инфлюенс|блогер|ставк|подряд|контракт|прайс|дедлайн|infinity|инфинити|ктв|ktv|караоке|выезд|жил|билет|анкет|хостес|корея|корей|китай|саудов|дубай|ливан|шанхай|шаосинь|санья|чжэцзян|^иу$|гусан|чай|гост|клуб)/i;

function msgText(m: TgMessage): string {
  const t = m.text;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return t.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).join("");
  }
  return "";
}

function normalizeForHash(s: string): string {
  // Strip emojis-as-noise variations: collapse whitespace, lowercase. Keep the
  // gist so that the same broadcast pasted into 20 chats hashes the same.
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function safeName(s: string, fallback: string): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return (cleaned || fallback).slice(0, 50);
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function titleFromBody(body: string, fallback: string): string {
  const firstLine =
    body
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  // Strip emoji + ZWJ (U+200D) + variation selector-16 (U+FE0F) — they
  // can't sit inside the same character class as Extended_Pictographic
  // because each ZWJ-joined sequence forms a single grapheme. Doing them
  // as separate alternations sidesteps biome's noMisleadingCharacterClass.
  const noEmoji = firstLine
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/‍|️/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return noEmoji.slice(0, 80) || fallback;
}

function parseArgs(): { input: string; outDir: string; agentIds: Set<string> } {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const agentIds = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") {
      // Comma-separated list lets you pull broadcasts from a channel +
      // dialogs from a personal account in one pass:
      //   --agent user1234,channel5678
      const raw = args[++i] ?? "";
      for (const s of raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        agentIds.add(s);
      }
    } else {
      positional.push(args[i]!);
    }
  }
  if (agentIds.size === 0) agentIds.add(DEFAULT_AGENT_ID);
  const [input, outDir] = positional;
  if (!input || !outDir) {
    console.error(
      "Usage: bun scripts/extract-tg.ts <result.json> <outDir> [--agent <id1,id2,...>]",
    );
    process.exit(1);
  }
  return { input: resolve(input), outDir: resolve(outDir), agentIds };
}

interface BroadcastRecord {
  hash: string;
  text: string;
  occurrences: { chat: string; date: string }[];
}

interface Turn {
  who: "user" | "agent";
  text: string;
  date: string;
  unix: number;
  voiceFile?: string;
  voiceDuration?: number;
}

function main() {
  const { input, outDir, agentIds } = parseArgs();
  console.log(`[extract] reading ${input}`);
  console.log(`[extract] agent ids: ${[...agentIds].join(", ")}`);
  const data = JSON.parse(readFileSync(input, "utf8")) as TgExport;
  const chats = data.chats.list;

  ensureDir(outDir);
  const postsDir = join(outDir, "posts");
  const dialogsDir = join(outDir, "dialogs");
  const voiceDir = join(outDir, "voice");
  const transcriptsDir = join(voiceDir, "transcripts");
  ensureDir(postsDir);
  ensureDir(dialogsDir);
  ensureDir(voiceDir);
  ensureDir(transcriptsDir);

  // Look up cached transcript for a Telegram voice file path.
  // Mirrors the cache layout produced by scripts/transcribe.ts.
  function lookupTranscript(file: string): string | undefined {
    const parts = file.split("/");
    const chatDir = parts[1] ?? "chat_unknown";
    const fname = parts[parts.length - 1] ?? "";
    const stem = basename(fname, extname(fname));
    const path = join(transcriptsDir, `${chatDir}__${stem}.txt`);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8").trim();
  }

  const broadcasts = new Map<string, BroadcastRecord>();
  const dialogs: { chat: string; turns: Turn[]; workHits: number }[] = [];
  const voiceQueue: {
    chat: string;
    file: string;
    date: string;
    duration: number;
  }[] = [];

  let totalAgentMsgs = 0;
  let totalChatsWithAgent = 0;
  let voiceInlined = 0;
  let voiceSkippedNoCache = 0;

  for (const chat of chats) {
    const chatName = chat.name ?? `chat-${chat.id}`;
    const msgs = chat.messages ?? [];
    let agentMsgsHere = 0;
    let workHits = 0;
    const turns: Turn[] = [];

    for (const m of msgs) {
      if (m.type !== "message") continue;
      const text = msgText(m).trim();
      const isAgent = m.from_id ? agentIds.has(m.from_id) : false;

      // Voice messages from agent → queue for transcription
      if (m.media_type === "voice_message" && isAgent && m.file) {
        voiceQueue.push({
          chat: chatName,
          file: m.file,
          date: m.date,
          duration: m.duration_seconds ?? 0,
        });
      }

      // Inline transcribed voice messages (from any party) into the dialog
      // flow. If the transcript isn't cached yet, the voice message is just
      // skipped from the dialog file but still listed in voice/INDEX.md.
      if (m.media_type === "voice_message" && m.file) {
        const transcript = lookupTranscript(m.file);
        if (transcript) {
          const dur = m.duration_seconds ?? 0;
          turns.push({
            who: isAgent ? "agent" : "user",
            text: `[голосовое, ${dur}с] ${transcript}`,
            date: m.date,
            unix: parseInt(m.date_unixtime ?? "0", 10),
            voiceFile: m.file,
            voiceDuration: dur,
          });
          voiceInlined++;
          if (isAgent && transcript.length >= MIN_BROADCAST_LEN) {
            // Long agent voice → also dedupe as a "post" candidate, so a
            // monologue that explains conditions ends up in posts/ as a
            // standalone document.
            const h = createHash("sha256").update(normalizeForHash(transcript)).digest("hex");
            let rec = broadcasts.get(h);
            if (!rec) {
              rec = { hash: h, text: transcript, occurrences: [] };
              broadcasts.set(h, rec);
            }
            rec.occurrences.push({ chat: chatName, date: m.date });
          }
        } else {
          voiceSkippedNoCache++;
        }
      }

      if (!text) continue;
      if (WORK_RE.test(text)) workHits++;

      if (isAgent) {
        agentMsgsHere++;
        totalAgentMsgs++;

        // Broadcast post candidate
        if (text.length >= MIN_BROADCAST_LEN) {
          const h = createHash("sha256").update(normalizeForHash(text)).digest("hex");
          let rec = broadcasts.get(h);
          if (!rec) {
            rec = { hash: h, text, occurrences: [] };
            broadcasts.set(h, rec);
          }
          rec.occurrences.push({ chat: chatName, date: m.date });
        }
      }

      // Build dialog turns regardless — we'll filter chats later by workHits
      turns.push({
        who: isAgent ? "agent" : "user",
        text,
        date: m.date,
        unix: parseInt(m.date_unixtime ?? "0", 10),
      });
    }

    if (agentMsgsHere > 0) totalChatsWithAgent++;
    // A chat is dialog-worthy if the agent participated AND there's
    // recognizable work-related content somewhere.
    if (agentMsgsHere >= 2 && workHits >= 2) {
      dialogs.push({ chat: chatName, turns, workHits });
    }
  }

  // ── Write deduplicated broadcast posts ────────────────────────────────
  const sortedBroadcasts = [...broadcasts.values()].sort(
    (a, b) => b.occurrences.length - a.occurrences.length,
  );
  let postIdx = 0;
  for (const rec of sortedBroadcasts) {
    postIdx++;
    const title = titleFromBody(rec.text, `post-${postIdx}`);
    const slug = safeName(title, `post-${postIdx}`);
    const fname = `${String(postIdx).padStart(3, "0")}-${slug}.md`;
    const fpath = join(postsDir, fname);
    const occurrences = rec.occurrences.slice().sort((a, b) => a.date.localeCompare(b.date));
    // Keep the metadata at the END of the file so it stays visible to
    // humans but does not pollute the top of every chunk's embedding.
    // (The ingest pipeline also strips HTML comments as a safety net.)
    const body = `# ${title}\n\n${rec.text}\n`;
    const trailer = [
      "",
      `<!-- broadcast post extracted from Telegram export -->`,
      `<!-- occurrences: ${occurrences.length} -->`,
      `<!-- first seen: ${occurrences[0]?.date ?? "?"} -->`,
      `<!-- chats: ${[...new Set(occurrences.map((o) => o.chat))].slice(0, 8).join(", ")}${occurrences.length > 8 ? ", ..." : ""} -->`,
      "",
    ].join("\n");
    writeFileSync(fpath, body + trailer, "utf8");
  }

  // ── Write per-chat dialog files (compact Q&A format) ──────────────────
  // Collapse runs of consecutive same-side messages within a short window
  // into a single block, so output reads as a clean Q→A transcript.
  let dialogIdx = 0;
  for (const d of dialogs.sort((a, b) => b.workHits - a.workHits)) {
    dialogIdx++;
    const blocks: { who: "user" | "agent"; text: string; date: string }[] = [];
    for (const t of d.turns) {
      const last = blocks[blocks.length - 1];
      if (last && last.who === t.who) {
        last.text += `\n${t.text}`;
      } else {
        blocks.push({ who: t.who, text: t.text, date: t.date });
      }
    }
    // Trim leading agent monologue (no question to answer) and trailing user
    // questions (no answer recorded), keep the conversational core.
    while (blocks.length && blocks[0]!.who === "agent") blocks.shift();
    while (blocks.length && blocks[blocks.length - 1]!.who === "user") blocks.pop();
    if (blocks.length < 2) continue; // not a real Q&A

    const slug = safeName(d.chat, `chat-${dialogIdx}`);
    const fname = `${String(dialogIdx).padStart(3, "0")}-${slug}.md`;
    const fpath = join(dialogsDir, fname);
    const lines: string[] = [];
    lines.push(`# Диалог: ${d.chat}`);
    lines.push("");
    lines.push(`<!-- ${blocks.length} реплик, work-релевантность: ${d.workHits} -->`);
    lines.push("");
    for (const b of blocks) {
      const label = b.who === "user" ? "**Кандидат**" : "**Агент**";
      // Skip extremely short agent acks unless they directly answer
      if (
        b.who === "agent" &&
        b.text.replace(/\s+/g, " ").trim().length < SHORT_AGENT_REPLY_MIN_LEN
      ) {
        continue;
      }
      lines.push(`${label} (${b.date.slice(0, 16).replace("T", " ")}):`);
      lines.push("");
      lines.push(b.text);
      lines.push("");
    }
    writeFileSync(fpath, lines.join("\n"), "utf8");
  }

  // ── Voice index ───────────────────────────────────────────────────────
  voiceQueue.sort((a, b) => a.date.localeCompare(b.date));
  const voiceIndex: string[] = [];
  voiceIndex.push("# Голосовые сообщения агента");
  voiceIndex.push("");
  voiceIndex.push(
    `Всего: ${voiceQueue.length}, общая длительность: ${Math.round(voiceQueue.reduce((s, v) => s + v.duration, 0) / 60)} мин.`,
  );
  voiceIndex.push("");
  voiceIndex.push(
    "Эти файлы нужно расшифровать (см. scripts/transcribe.ts) и затем добавить контент к соответствующему диалогу или вынести в `posts/`.",
  );
  voiceIndex.push("");
  voiceIndex.push("| # | Дата | Длит. | Чат | Файл |");
  voiceIndex.push("|---|------|-------|-----|------|");
  voiceQueue.forEach((v, i) => {
    voiceIndex.push(
      `| ${i + 1} | ${v.date.slice(0, 16).replace("T", " ")} | ${v.duration}s | ${v.chat} | \`${v.file}\` |`,
    );
  });
  writeFileSync(join(voiceDir, "INDEX.md"), voiceIndex.join("\n"), "utf8");

  // ── README summary ────────────────────────────────────────────────────
  const summary: string[] = [];
  summary.push("# kb/extracted");
  summary.push("");
  summary.push(`Источник: \`${input}\``);
  summary.push(`Агент(ы): \`${[...agentIds].join(", ")}\``);
  summary.push("");
  summary.push("## Статистика");
  summary.push("");
  summary.push(`- Всего чатов в экспорте: **${chats.length}**`);
  summary.push(`- Чатов с участием агента: **${totalChatsWithAgent}**`);
  summary.push(`- Сообщений агента: **${totalAgentMsgs}**`);
  summary.push(`- Уникальных «постов» агента (длинных, дедуплицированы): **${broadcasts.size}**`);
  summary.push(`- Извлечено диалогов с Q&A: **${dialogs.length}**`);
  summary.push(`- Голосовых от агента к расшифровке: **${voiceQueue.length}**`);
  summary.push("");
  summary.push("## Что дальше");
  summary.push("");
  summary.push(
    "1. Просмотри `posts/` — это твоя готовая база знаний с дедупликацией. Удали мусор, объедини похожее в тематические файлы.",
  );
  summary.push(
    "2. Просмотри `dialogs/` — там реальные Q&A с кандидатами. Хорошие пары вопрос→ответ можно вынести в отдельный файл `faq.md`.",
  );
  summary.push(
    "3. Запусти транскрипцию голосовых: `bun scripts/transcribe.ts kb/extracted/voice` (когда напишем скрипт).",
  );
  summary.push(
    "4. Скопируй курированные .md в `kb/curated/` и проиндексируй: `bun scripts/ingest.ts kb/curated/`.",
  );
  writeFileSync(join(outDir, "README.md"), summary.join("\n"), "utf8");

  console.log(`[extract] done`);
  console.log(`  chats total:               ${chats.length}`);
  console.log(`  chats w/ agent:            ${totalChatsWithAgent}`);
  console.log(`  agent messages:            ${totalAgentMsgs}`);
  console.log(`  broadcast posts (unique):  ${broadcasts.size}`);
  console.log(`  dialog files written:      ${dialogIdx}`);
  console.log(`  voice msgs from agent:     ${voiceQueue.length}`);
  console.log(`  voice transcripts inlined: ${voiceInlined}`);
  if (voiceSkippedNoCache > 0) {
    console.log(
      `  voice w/o transcript:      ${voiceSkippedNoCache}  (run scripts/transcribe.ts first)`,
    );
  }
  console.log(`  output:                    ${outDir}`);
}

main();
