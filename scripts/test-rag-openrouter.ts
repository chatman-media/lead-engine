import { config } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { StylesRepo } from "../src/db/repos/styles.ts";
import { renderVacanciesBlock, VacanciesRepo } from "../src/db/repos/vacancies.ts";
import { answerWithRag, NO_CONTEXT_MARKER } from "../src/rag/answer.ts";
import { OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { OpenRouterChatClient } from "../src/rag/providers/openrouter-chat.ts";
import type { Style } from "../src/sales/types.ts";

const question = process.argv.slice(2).join(" ") || "расскажи про вакансии";
const model = "google/gemini-2.0-flash-lite-001";

const kb = new KbRepo(sql);
const vacancies = new VacanciesRepo(sql);
const stylesRepo = new StylesRepo(sql);
const styleRow = await stylesRepo.bySlug("alina-infinity-v1");
const style = styleRow ? (stylesRepo.parseRow(styleRow) as Style) : undefined;

const chat = new OpenRouterChatClient({
  apiKey: config.openrouter.apiKey,
  baseUrl: config.openrouter.baseUrl,
  model,
});
const embedder = new OpenAIEmbeddingClient({
  apiKey: config.openai.apiKey,
  baseUrl: config.openai.baseUrl,
  model: config.openai.embeddingModel,
  dim: config.openai.embeddingDim,
});

const activeVacancies = await vacancies.listActive();
const vacanciesBlock = renderVacanciesBlock(activeVacancies);
console.log(`[test] model=${model}  Q: "${question}"`);
console.log(`[test] active vacancies: ${activeVacancies.length}`);

const t0 = Date.now();
const res = await answerWithRag({
  question,
  kb,
  embedder,
  chat,
  topK: config.rag.topK,
  maxDistance: config.rag.maxDistance,
  persona: config.persona,
  ...(style ? { style } : {}),
  ...(vacanciesBlock ? { vacanciesBlock } : {}),
});
const ms = Date.now() - t0;

console.log(`\n[test] hits=${res.hits.length}  (${ms}ms)`);
for (const h of res.hits.slice(0, 5)) {
  const preview = h.text.replace(/\s+/g, " ").slice(0, 100);
  console.log(
    `  chunk=${h.chunk_id} dist=${h.distance.toFixed(4)} "${h.title.slice(0, 40)}" :: ${preview}…`,
  );
}
console.log(`\n--- ОТВЕТ БОТА ---`);
if (res.text === NO_CONTEXT_MARKER) {
  console.log("[NO CONTEXT — бот бы уточнил или перевёл тему]");
} else {
  console.log(res.text);
}

await sql.end();
