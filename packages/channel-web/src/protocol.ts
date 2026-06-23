// JSON-protocol на WebSocket-wire. Минималистичный: text-only, message id
// генерится клиентом (например, crypto.randomUUID()) для дедупа.
//
// Поток:
//   Server → Client: { type: "ready", channelId, userId }  при accept'е
//   Client → Server: { type: "user_text", id, text }
//   Server → Client: { type: "bot_text", id, text, replyTo? }
//   Server → Client: { type: "error", code, message }

export type ClientFrame = { type: "user_text"; id: string; text: string };

export type ServerFrame =
  | { type: "ready"; channelId: string; userId: string }
  | { type: "bot_text"; id: string; text: string; replyTo?: string }
  | { type: "error"; code: string; message: string };

/** Безопасный парсер: возвращает null если frame не валиден. */
export function parseClientFrame(raw: string): ClientFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const f = obj as Record<string, unknown>;
  if (f.type === "user_text") {
    if (typeof f.id !== "string" || typeof f.text !== "string") return null;
    if (f.text.length === 0 || f.text.length > 8_000) return null;
    return { type: "user_text", id: f.id, text: f.text };
  }
  return null;
}

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
