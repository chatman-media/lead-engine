import type { VisionProvider } from "../config.ts";
import type { FetchLike } from "./chat.ts";

/**
 * Photo classification via a vision-capable model.
 *
 * The recruiting funnel collects two distinct kinds of photo from a
 * candidate — full-body shots and a photo of her international passport
 * (загранпаспорт) — plus assorted regular photos. The bot needs to tell
 * them apart so the lead intake counters are accurate (see
 * `src/leads/intake.ts`), instead of the old "total photos >= 7" guess.
 *
 * Works with either OpenRouter or OpenAI (set via `provider`). Both expose
 * an OpenAI-compatible `/chat/completions` endpoint; vision input is the
 * standard `image_url` content part with a data URL. The OpenRouter-only
 * `reasoning` request param is sent only for that provider.
 */

export const PHOTO_CLASSES = ["passport", "full_body", "portrait", "other"] as const;
export type PhotoClass = (typeof PHOTO_CLASSES)[number];

const SYSTEM_PROMPT = `Ты классифицируешь фотографию из переписки рекрутингового агентства.

Отнеси изображение РОВНО к одной из категорий и верни ТОЛЬКО одно слово:

- passport — фотография или скан страницы паспорта/загранпаспорта (видны поля документа, фото-страница, машиночитаемая зона).
- full_body — человек снят в полный рост (видно всю фигуру от головы до ног или почти всю).
- portrait — обычное фото человека: лицо, по пояс, селфи, не в полный рост.
- other — всё остальное (пейзаж, предмет, скриншот, документ, который не паспорт, и т.п.).

Ответь СТРОГО одним словом из списка: passport, full_body, portrait, other.
Без знаков препинания, без пояснений.`;

export interface ClassifyPhotoOptions {
  /** Raw image bytes (as downloaded from Telegram). */
  bytes: ArrayBuffer;
  /** MIME type, e.g. "image/jpeg". Falls back to image/jpeg when empty. */
  mimeType?: string;
  /** Vision-capable model id (OpenRouter slug or OpenAI model name). */
  model: string;
  apiKey: string;
  /** AI provider. Default: "openrouter". */
  provider?: VisionProvider;
  /** Default: https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface VisionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maps a free-form model reply onto a `PhotoClass`, defaulting to `other`. */
export function parsePhotoClass(raw: string): PhotoClass {
  const word = raw.toLowerCase().match(/passport|full_body|portrait|other/);
  if (word) return word[0] as PhotoClass;
  return "other";
}

/**
 * Downloads nothing — caller passes raw bytes. Returns the classified
 * category. Throws on transport / API errors so the caller can decide
 * to leave the photo unclassified and retry on the next turn.
 */
export async function classifyPhoto(opts: ClassifyPhotoOptions): Promise<PhotoClass> {
  if (!opts.apiKey || opts.apiKey.trim().length === 0) {
    throw new Error("classifyPhoto: apiKey required");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const mime = opts.mimeType?.trim() ? opts.mimeType : "image/jpeg";
  const base64 = Buffer.from(opts.bytes).toString("base64");

  const provider = opts.provider ?? "openrouter";

  const body = {
    model: opts.model,
    stream: false,
    temperature: 0,
    max_tokens: 512,
    // Reasoning models (Gemini 2.5 Flash et al.) spend output tokens on
    // internal thinking — a tiny cap there returns EMPTY content. Disable
    // reasoning and leave generous headroom; the answer itself is one word.
    // `reasoning` is OpenRouter-specific — OpenAI rejects unknown params.
    ...(provider === "openrouter" ? { reasoning: { enabled: false } } : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Категория этого изображения?" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  };

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  let payload: VisionResponse;
  try {
    payload = (await res.json()) as VisionResponse;
  } catch {
    throw new Error(`classifyPhoto: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || payload.error) {
    throw new Error(
      `classifyPhoto: vision API error (HTTP ${res.status}): ${payload.error?.message ?? "unknown"}`,
    );
  }
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error(`classifyPhoto: empty content (finish_reason=${choice?.finish_reason ?? "?"})`);
  }
  return parsePhotoClass(content);
}
