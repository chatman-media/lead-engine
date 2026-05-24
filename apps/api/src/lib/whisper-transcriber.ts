import type { ITranscriber } from "@chatman-media/conversation-engine";

/**
 * OpenAI Whisper STT реализация ITranscriber.
 * Использует /v1/audio/transcriptions endpoint (multipart/form-data).
 * Совместимо с Groq Whisper API (тот же формат, другой baseUrl).
 */
export class WhisperTranscriber implements ITranscriber {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: {
    apiKey: string;
    /** Для Groq: "https://api.groq.com/openai/v1" */
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.model = opts.model ?? "whisper-1";
  }

  async transcribe(audio: Uint8Array, filename: string): Promise<string | null> {
    const form = new FormData();
    form.append("file", new Blob([audio]), filename);
    form.append("model", this.model);
    form.append("response_format", "text");

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (err) {
      console.warn("[whisper] fetch failed:", (err as Error).message);
      return null;
    }

    if (!res.ok) {
      console.warn("[whisper] API error:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  }
}
