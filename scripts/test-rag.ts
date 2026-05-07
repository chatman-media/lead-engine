import { activeEmbeddingDim, config } from "../src/config.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { getDb } from "../src/db/sqlite.ts";
import { answerWithRag, NO_CONTEXT_MARKER } from "../src/rag/answer.ts";
import { OllamaChatClient } from "../src/rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";

const question = process.argv.slice(2).join(" ") || "расскажи про работу в Корее";

const db = getDb();
const kb = new KbRepo(db);
const chat = new OllamaChatClient({
  host: config.ollama.host,
  model: config.ollama.chatModel,
});
const embedder = new OllamaEmbeddingClient({
  host: config.ollama.host,
  model: config.ollama.embeddingModel,
  dim: config.ollama.embeddingDim,
});

console.log(
  `[test] dim=${activeEmbeddingDim()} chat=${config.ollama.chatModel} ` +
    `embed=${config.ollama.embeddingModel} maxDist=${config.rag.maxDistance ?? "none"} topK=${config.rag.topK}`,
);
console.log(
  `[test] persona=${config.persona.name}/${config.persona.role}/${config.persona.company}`,
);
console.log(`[test] Q: ${question}`);

const t0 = Date.now();
const res = await answerWithRag({
  question,
  kb,
  embedder,
  chat,
  topK: config.rag.topK,
  maxDistance: config.rag.maxDistance,
  persona: config.persona,
});
const ms = Date.now() - t0;

console.log(
  `\n[test] hits=${res.hits.length} usedChunkIds=${JSON.stringify(res.usedChunkIds)}  (${ms}ms)`,
);
for (const h of res.hits) {
  const preview = h.text.replace(/\s+/g, " ").slice(0, 120);
  console.log(
    `  - chunk=${h.chunk_id} dist=${h.distance.toFixed(4)} title="${h.title}" :: ${preview}…`,
  );
}
console.log("\n[test] ANSWER:");
if (res.text === NO_CONTEXT_MARKER) {
  console.log("(NO_CONTEXT — в Telegram текст не отправляется, режим ai без изменений.)");
} else {
  console.log(res.text);
}

const lower = res.text.toLowerCase();
const banned = [
  "оператор",
  "operator",
  "коллег",
  "ассистент",
  "as an ai",
  "я бот",
  "я ии",
  "i am an ai",
];
const found = banned.filter((w) => lower.includes(w));
console.log(
  "\n[test] banned-word check:",
  found.length === 0 ? "OK" : `LEAKED: ${found.join(", ")}`,
);
