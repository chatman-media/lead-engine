export type AdminEvent =
  | {
      type: "message:new";
      conversationId: number;
      tgUserId: number;
      direction: "in" | "out";
      preview?: string;
    }
  | { type: "conversation:updated"; conversationId: number }
  | { type: "kb-suggestion:created"; suggestionId: number; conversationId: number }
  | { type: "queued:count"; count: number };

type Listener = (evt: AdminEvent) => void;

export class AdminWs {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private dead = false;

  connect() {
    if (this.dead) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/admin/api/ws`;
    const ws = new WebSocket(url);

    ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data as string) as AdminEvent;
        for (const l of this.listeners) l(evt);
      } catch {}
    };

    ws.onclose = () => {
      if (!this.dead) setTimeout(() => this.connect(), 2000);
    };

    this.ws = ws;
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.dead = true;
    this.ws?.close();
  }
}
