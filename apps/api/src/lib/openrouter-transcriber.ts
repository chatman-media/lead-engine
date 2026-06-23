import type { ITranscriber } from "@chatman-media/conversation-engine";

/**
 * OpenRouter STT реализация ITranscriber.
 *
 * OpenRouter отдаёт speech-to-text через POST /api/v1/audio/transcriptions,
 * но НЕ в OpenAI-формате (multipart): тело — JSON с base64-аудио
 * { model, input_audio: { data, format }, language? }. Поэтому отдельная
 * реализация, не WhisperTranscriber.
 *
 * Модели: openai/whisper-1, google/chirp-3, groq whisper и др. (через один
 * OpenRouter-ключ — тот же, что для чата).
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/stt
 */
export class OpenRouterTranscriber implements ITranscriber {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.model = opts.model ?? "openai/whisper-1";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Формат аудио из имени файла (telegram voice → ogg). */
  private formatFromFilename(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "ogg";
    // OpenRouter принимает wav/mp3/flac/m4a/ogg/webm/aac; oga → ogg.
    return ext === "oga" ? "ogg" : ext;
  }

  async transcribe(audio: Uint8Array, filename: string): Promise<string | null> {
    const body = {
      model: this.model,
      input_audio: {
        data: Buffer.from(audio).toString("base64"),
        format: this.formatFromFilename(filename),
      },
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.warn("[openrouter-stt] fetch failed:", (err as Error).message);
      return null;
    }

    if (!res.ok) {
      console.warn("[openrouter-stt] API error:", res.status, await res.text().catch(() => ""));
      return null;
    }

    try {
      const json = (await res.json()) as { text?: string };
      const text = json.text?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      console.warn("[openrouter-stt] non-JSON response");
      return null;
    }
  }
}
