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
  | { type: "conversation_mode"; tenantId: number; conversationId: number; mode: string };

type Handler = (event: AdminEvent) => void;

class AdminEventBus {
  private subs = new Map<number, Set<Handler>>();

  subscribe(tenantId: number, handler: Handler): () => void {
    if (!this.subs.has(tenantId)) this.subs.set(tenantId, new Set());
    this.subs.get(tenantId)!.add(handler);
    return () => {
      const set = this.subs.get(tenantId);
      if (set) { set.delete(handler); if (set.size === 0) this.subs.delete(tenantId); }
    };
  }

  emit(event: AdminEvent): void {
    this.subs.get(event.tenantId)?.forEach((h) => { try { h(event); } catch {} });
  }
}

export const adminEventBus = new AdminEventBus();
