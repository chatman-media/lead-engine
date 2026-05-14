import { config } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { buildSystemPrompt } from "../src/rag/answer.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";

const question = process.argv.slice(2).join(" ") || "расскажи про работу в Корее";

const kb = new KbRepo(sql);
const embedder = new OllamaEmbeddingClient({
  host: config.ollama.host,
  model: config.ollama.embeddingModel,
  dim: config.ollama.embeddingDim,
});

const [vec] = await embedder.embed([question]);
if (!vec) throw new Error("no vec");
const allHits = await kb.search(vec, config.rag.topK);
const hits = allHits.filter((h) =>
  config.rag.maxDistance === undefined ? true : h.distance <= config.rag.maxDistance,
);
const context = hits.map((h, i) => `[#${i + 1}] (source: ${h.title})\n${h.text}`).join("\n\n");
const systemPrompt = buildSystemPrompt(config.persona, context);

const t0 = Date.now();
const url = `${config.ollama.host.replace(/\/+$/, "")}/api/chat`;
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: config.ollama.chatModel,
    messages: [
      { role: "system", content: `/no_think\n\n${systemPrompt}` },
      { role: "user", content: question },
    ],
    stream: false,
    think: false,
    options: { temperature: 0.2, num_predict: 250 },
  }),
});
const ms = Date.now() - t0;
const j = (await res.json()) as Record<string, unknown>;

const msg = (j.message as { content?: string } | undefined)?.content ?? "";
console.log(`[raw] hits=${hits.length} ms=${ms}`);
console.log(
  `[raw] prompt_eval=${j.prompt_eval_count}t/${Math.round(((j.prompt_eval_duration as number) ?? 0) / 1e6)}ms ` +
    `eval=${j.eval_count}t/${Math.round(((j.eval_duration as number) ?? 0) / 1e6)}ms ` +
    `total=${Math.round(((j.total_duration as number) ?? 0) / 1e6)}ms`,
);
console.log(`[raw] CONTAINS <think>: ${msg.includes("<think>")}`);
console.log(`\n--- raw content (first 600 chars): ---\n${msg.slice(0, 600)}\n---`);

await sql.end();
