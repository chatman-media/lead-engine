/**
 * WS client с авто-reconnect (exponential backoff up to 30s). Без deps.
 *
 * WS protocol (см. apps/api/src/routes/ws-web.ts):
 *   In  (client → server): { type: "user_text", id, text }
 *   Out (server → client):
 *     - { type: "ready", channelId, userId }
 *     - { type: "bot_text", text }
 *     - { type: "error", code, message }
 */

export interface WsClientOpts {
  url: string;
  onOpen?: () => void;
  onReady?: (channelId: string, userId: string) => void;
  onBotText?: (text: string) => void;
  onError?: (code: string, message: string) => void;
  onClose?: () => void;
  onConnecting?: () => void;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private retryMs = MIN_RETRY_MS;
  private wantClose = false;
  private reconnectTimer: number | null = null;

  constructor(private readonly opts: WsClientOpts) {}

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.wantClose = false;
    this.opts.onConnecting?.();
    try {
      this.ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.opts.onError?.("ws_create_failed", err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("open", () => {
      this.retryMs = MIN_RETRY_MS;
      this.opts.onOpen?.();
    });
    this.ws.addEventListener("message", (ev) => this.handleFrame(ev.data));
    this.ws.addEventListener("close", () => {
      this.ws = null;
      this.opts.onClose?.();
      if (!this.wantClose) this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // Browser выбрасывает Event без подробностей; полагаемся на close handler.
    });
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: { type?: string; [k: string]: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "ready") {
      this.opts.onReady?.(String(frame.channelId ?? ""), String(frame.userId ?? ""));
    } else if (frame.type === "bot_text") {
      this.opts.onBotText?.(String(frame.text ?? ""));
    } else if (frame.type === "error") {
      this.opts.onError?.(String(frame.code ?? "unknown"), String(frame.message ?? ""));
    }
  }

  sendText(text: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const id = this.genMsgId();
    this.ws.send(JSON.stringify({ type: "user_text", id, text }));
    return true;
  }

  close(): void {
    this.wantClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, "client closed");
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.wantClose) return;
    if (this.reconnectTimer !== null) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.reconnectTimer = (setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay) as unknown) as number;
  }

  private genMsgId(): string {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
