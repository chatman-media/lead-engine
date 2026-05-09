import type { ServerWebSocket } from "bun";

export type AdminEvent =
  | {
      type: "message:new";
      conversationId: number;
      tgUserId: number;
    }
  | {
      type: "conversation:updated";
      conversationId: number;
    }
  | {
      type: "kb-suggestion:created";
      suggestionId: number;
      conversationId: number;
    }
  | {
      type: "queued:count";
      count: number;
    };

export interface AdminWsData {
  adminId: number;
}

/** Pub/sub for admin websockets. The router publishes events here; every
 *  connected admin client receives them. Keeps the websocket layer decoupled
 *  from the rest of the application. */
export class AdminBus {
  private readonly clients = new Set<ServerWebSocket<AdminWsData>>();

  add(ws: ServerWebSocket<AdminWsData>): void {
    this.clients.add(ws);
  }

  remove(ws: ServerWebSocket<AdminWsData>): void {
    this.clients.delete(ws);
  }

  size(): number {
    return this.clients.size;
  }

  publish(event: AdminEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
