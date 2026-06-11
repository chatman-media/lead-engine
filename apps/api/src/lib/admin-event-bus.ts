export type AdminEvent =
  | {
      type: "new_message";
      tenantId: number;
      conversationId: number;
      contactId: number;
      preview: string | null;
      role: "user" | "assistant" | "human";
    }
  | { type: "stage_changed"; tenantId: number; leadId: number; toStage: string; toStageDisplayName: string }
  | { type: "conversation_mode"; tenantId: number; conversationId: number; mode: string }
  | {
      type: "admin_notification";
      tenantId: number;
      notification: {
        id: number;
        topic: string;
        severity: string;
        kind: string;
        title: string;
        body: string;
        deliveredAt: number | null;
        readAt: number | null;
        createdAt: number;
      };
    };

type Handler = (event: AdminEvent) => void;

class AdminEventBus {
  private subs = new Map<number, Set<Handler>>();

  subscribe(tenantId: number, handler: Handler): () => void {
    let set = this.subs.get(tenantId);
    if (!set) {
      set = new Set();
      this.subs.set(tenantId, set);
    }
    set.add(handler);
    return () => {
      const current = this.subs.get(tenantId);
      if (current) { current.delete(handler); if (current.size === 0) this.subs.delete(tenantId); }
    };
  }

  emit(event: AdminEvent): void {
    this.subs.get(event.tenantId)?.forEach((h) => { try { h(event); } catch {} });
  }
}

export const adminEventBus = new AdminEventBus();
