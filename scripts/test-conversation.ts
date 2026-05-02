/**
 * Прогоняет несколько вопросов через тот же RAG-пайплайн что и webhook,
 * печатает диалог как пользователь увидел бы его в Telegram + быстрая
 * аналитика (latency, KB-hits, banned-word check).
 *
 * Запуск: bun run scripts/test-conversation.ts
 */
import { activeEmbeddingDim, config } from "../src/config.ts";
import { getDb } from "../src/db/sqlite.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { OllamaChatClient } from "../src/rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";
import {
  answerWithRag,
  isPersonaSmalltalkQuestion,
  NO_CONTEXT_MARKER,
} from "../src/rag/answer.ts";

const QUESTIONS = [
  "Расскажи про работу в Китае",
  "skldjfslkdjf",                 // мусор / typo
  "Как зовут?",                   // smalltalk — должно вернуть Алина
  "Ты человек?",                  // bot-presence
];

const db = getDb();
const kb = new KbRepo(db);
const chat = new OllamaChatClient({
  host: config.ollama.host,
  model: config.ollama.chatModel,
  // 12B-class модель на CPU — 5-минутный дефолтный таймаут не хватает.
  // Ставим час, чтобы тест точно дождался ответа.
  timeoutMs: 60 * 60_000,
});

// В Telegram реплики короткие — нет смысла ждать 256-токенный ответ
// 5 минут на CPU. Кап-ом до 100 ровняем на формат мессенджера и быстрее
// получаем feedback по тону/контенту. Прод webhook использует дефолт 256
// (см. src/rag/providers/ollama-chat.ts).
const COMPLETE_OPTS = { numPredict: 60 } as const;
const embedder = new OllamaEmbeddingClient({
  host: config.ollama.host,
  model: config.ollama.embeddingModel,
  dim: config.ollama.embeddingDim,
  // Дефолт 2 мин маловато когда CPU делит несколько моделей.
  timeoutMs: 30 * 60_000,
});

const banned = [
  /\bоператор/i,
  /\bколлег/i,
  /\bассистент/i,
  /\baI\b/,
  /я\s+(ИИ|ии)\b/,
  /я\s+бот\b/i,
  /\bнейросет/i,
  /языковая\s+модель/i,
];

console.log("=".repeat(70));
console.log("CONFIG");
console.log("=".repeat(70));
console.log(`provider:      ${config.llm.provider}`);
console.log(`chat model:    ${config.ollama.chatModel}`);
console.log(`embed model:   ${config.ollama.embeddingModel} (dim=${activeEmbeddingDim()})`);
console.log(`max distance:  ${config.rag.maxDistance ?? "(off)"}`);
console.log(`top-K:         ${config.rag.topK}`);
console.log(`persona:       ${config.persona.name} / ${config.persona.role} / ${config.persona.company}`);
console.log(`stage classifier: ${config.sales.stageClassifier}`);
console.log(`forced style:  ${config.sales.forcedStyleSlug || "(none — legacy persona path)"}`);
console.log("");

interface TurnReport {
  q: string;
  reply: string;
  hits: number;
  durationMs: number;
  source: "smalltalk-shortcut" | "rag-with-kb" | "no-context-escalation";
  bannedHits: string[];
  topHits: Array<{ title: string; distance: number; preview: string }>;
}

const reports: TurnReport[] = [];

for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i]!;
  console.log("-".repeat(70));
  console.log(`Q${i + 1}/${QUESTIONS.length}: ${q}`);
  console.log("-".repeat(70));
  process.stdout.write("(идёт запрос…) ");

  const t0 = Date.now();
  const res = await answerWithRag({
    question: q,
    kb,
    embedder,
    chat,
    topK: config.rag.topK,
    maxDistance: config.rag.maxDistance,
    persona: config.persona,
    numPredict: COMPLETE_OPTS.numPredict,
  });
  const durationMs = Date.now() - t0;
  process.stdout.write(`${(durationMs / 1000).toFixed(1)}s\n`);

  let userVisible: string;
  let source: TurnReport["source"];
  if (res.text === NO_CONTEXT_MARKER) {
    // Как webhook: при NO_CONTEXT в Telegram не пишем, режим ai не меняем.
    userVisible = "(в Telegram сообщение не отправляется)";
    source = "no-context-escalation";
  } else if (isPersonaSmalltalkQuestion(q)) {
    userVisible = res.text;
    source = "smalltalk-shortcut";
  } else {
    userVisible = res.text;
    source = "rag-with-kb";
  }

  const bannedHits = banned
    .filter((re) => re.test(userVisible))
    .map((re) => re.source);

  console.log(`\nALINA: ${userVisible}`);
  console.log("");
  console.log(`  source       : ${source}`);
  console.log(`  duration     : ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  kb hits      : ${res.hits.length}`);
  if (res.hits.length > 0) {
    for (const h of res.hits.slice(0, 3)) {
      const preview = h.text.replace(/\s+/g, " ").slice(0, 90);
      console.log(`    [${h.distance.toFixed(3)}] ${h.title}`);
      console.log(`        ${preview}…`);
    }
  }
  if (bannedHits.length > 0) {
    console.log(`  ⚠ banned     : ${bannedHits.join(", ")}`);
  }
  console.log("");

  reports.push({
    q,
    reply: userVisible,
    hits: res.hits.length,
    durationMs,
    source,
    bannedHits,
    topHits: res.hits.slice(0, 3).map((h) => ({
      title: h.title,
      distance: h.distance,
      preview: h.text.replace(/\s+/g, " ").slice(0, 90),
    })),
  });
}

console.log("=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));
const totalSec = reports.reduce((s, r) => s + r.durationMs, 0) / 1000;
console.log(`total turns: ${reports.length}, total time: ${totalSec.toFixed(1)}s`);
console.log("");
for (const r of reports) {
  const banner = r.bannedHits.length > 0 ? "⚠" : "✓";
  console.log(
    `${banner} ${r.source.padEnd(28)} ${r.durationMs.toString().padStart(7)}ms  hits=${r.hits}  Q="${r.q.slice(0, 40)}"`,
  );
}

db.close();
