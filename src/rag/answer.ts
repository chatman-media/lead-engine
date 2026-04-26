import type { KbRepo, KbSearchHit } from "../db/repos/kb.ts";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";

/** Sentinel returned when retrieval is empty; webhook layer can use this
 * to escalate to a human operator instead of inventing an answer. */
export const NO_CONTEXT_MARKER = "__NO_CONTEXT__";

const SYSTEM_PROMPT_HEADER = `You answer customer questions strictly using the CONTEXT below.
If the answer is not in the context, reply with "${NO_CONTEXT_MARKER}" exactly.
Be concise and write in the user's language.`;

export interface AnswerInput {
  question: string;
  kb: KbRepo;
  embedder: EmbeddingClient;
  chat: ChatClient;
  /** Recent dialog messages (oldest first), excluding the current question. */
  history?: ChatMessage[];
  topK?: number;
  /** Used to drop noisy hits; sqlite-vec returns L2 distance (lower=closer). */
  maxDistance?: number;
}

export interface AnswerResult {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
}

export async function answerWithRag(input: AnswerInput): Promise<AnswerResult> {
  const topK = input.topK ?? 5;
  const [questionVec] = await input.embedder.embed([input.question]);
  if (!questionVec) throw new Error("Embedder returned no vector for question");

  const allHits = input.kb.search(questionVec, topK);
  const hits =
    input.maxDistance === undefined
      ? allHits
      : allHits.filter((h) => h.distance <= input.maxDistance!);

  if (hits.length === 0) {
    return { text: NO_CONTEXT_MARKER, usedChunkIds: [], hits: [] };
  }

  const context = hits
    .map(
      (h, i) =>
        `[#${i + 1}] (source: ${h.title})\n${h.text}`,
    )
    .join("\n\n");
  const systemPrompt = `${SYSTEM_PROMPT_HEADER}\n\nCONTEXT:\n${context}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];

  const text = await input.chat.complete(messages, { temperature: 0.2 });
  return {
    text,
    usedChunkIds: hits.map((h) => h.chunk_id),
    hits,
  };
}
