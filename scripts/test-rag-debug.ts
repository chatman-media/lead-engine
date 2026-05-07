import { config } from "../src/config.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { getDb } from "../src/db/sqlite.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";

const question = process.argv.slice(2).join(" ") || "расскажи про работу в Корее";

const db = getDb();
const kb = new KbRepo(db);
const embedder = new OllamaEmbeddingClient({
  host: config.ollama.host,
  model: config.ollama.embeddingModel,
  dim: config.ollama.embeddingDim,
});

const [vec] = await embedder.embed([question]);
if (!vec) throw new Error("no vec");

const hits = kb.search(vec, 12);
console.log(`Q: ${question}`);
console.log(`top-12 hits:`);
for (const h of hits) {
  const preview = h.text.replace(/\s+/g, " ").slice(0, 90);
  console.log(
    `  chunk=${h.chunk_id} dist=${h.distance.toFixed(4)} title="${h.title.slice(0, 50)}" :: ${preview}…`,
  );
}
