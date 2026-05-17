import { answerWithRagStream } from "./answer.ts";
import type { AnswerInput, AnswerTelemetry } from "./answer-types.ts";
import type { ChatClient } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";
import type { IKbStore } from "./types.ts";

export interface RagServerOptions {
  /** Knowledge base store. */
  kb: IKbStore;
  /** LLM chat client. */
  chat: ChatClient;
  /** Embedding client. */
  embedder: EmbeddingClient;
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** Hostname to bind to. Default: "0.0.0.0". */
  hostname?: string;
  /**
   * Path that the server listens on. Default: "/chat".
   * POST JSON `{ question, userId?, conversationId?, ... }` → SSE stream of tokens.
   */
  path?: string;
  /**
   * Extra `AnswerInput` defaults merged into every request.
   * Request body fields take precedence over these defaults.
   */
  defaults?: Partial<Omit<AnswerInput, "question" | "kb" | "chat" | "embedder">>;
  /**
   * Called after every answered request with the final telemetry.
   * Use this to log to your analytics backend.
   */
  onTelemetry?: (telemetry: AnswerTelemetry) => void;
  /**
   * CORS origin header value. Set to `"*"` to allow all origins.
   * Default: `undefined` (no CORS headers added).
   */
  cors?: string;
}

/** Shape of the JSON request body accepted by the RAG server. */
export interface RagRequestBody {
  question: string;
  [key: string]: unknown;
}

/**
 * Lightweight Bun HTTP server that exposes `answerWithRagStream` as an SSE endpoint.
 *
 * **Request** — `POST {path}` with `Content-Type: application/json`:
 * ```json
 * { "question": "What is the onboarding process?" }
 * ```
 * Any additional fields in the body are merged into `AnswerInput` (e.g. `style`,
 * `history`, `conversationSummary`, `userFacts`).
 *
 * **Response** — `text/event-stream`:
 * ```
 * data: Hello
 * data:  world
 * data: [DONE]
 * ```
 * Each `data:` line carries one streamed token. The stream ends with `data: [DONE]`.
 * On error the server emits `data: [ERROR] <message>` and closes the stream.
 *
 * @example
 * ```ts
 * import { createRagServer } from "@chatman-media/rag";
 *
 * const server = createRagServer({
 *   kb, chat, embedder,
 *   port: 3000,
 *   cors: "*",
 *   onTelemetry: (t) => console.log("path:", t.path, "ms:", t.latencyMs),
 * });
 *
 * console.log(`Listening on http://localhost:${server.port}`);
 * // server.stop() to shut down
 * ```
 */
export function createRagServer(opts: RagServerOptions): ReturnType<typeof Bun.serve> {
  const path = opts.path ?? "/chat";
  const corsOrigin = opts.cors;

  function corsHeaders(): Record<string, string> {
    if (!corsOrigin) return {};
    return {
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
  }

  return Bun.serve({
    port: opts.port ?? 3000,
    hostname: opts.hostname ?? "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (req.method !== "POST" || url.pathname !== path) {
        return new Response("Not Found", { status: 404 });
      }

      let body: RagRequestBody;
      try {
        body = (await req.json()) as RagRequestBody;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (!body.question || typeof body.question !== "string") {
        return new Response('Missing required field "question"', { status: 400 });
      }

      const { question, ...rest } = body;

      // Merge defaults → request body fields win
      const answerInput: AnswerInput = {
        ...(opts.defaults ?? {}),
        ...(rest as Partial<AnswerInput>),
        question,
        kb: opts.kb,
        chat: opts.chat,
        embedder: opts.embedder,
      };

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();

          function send(token: string) {
            controller.enqueue(enc.encode(`data: ${token}\n\n`));
          }

          try {
            for await (const token of answerWithRagStream(answerInput)) {
              send(token);
            }
            send("[DONE]");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send(`[ERROR] ${msg}`);
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    },
  });
}
