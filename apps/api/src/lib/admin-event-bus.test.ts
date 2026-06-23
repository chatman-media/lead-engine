import { describe, expect, it } from "bun:test";
import { type AdminEvent, adminEventBus } from "./admin-event-bus.ts";

function newMessageEvent(tenantId: number, conversationId = 1): AdminEvent {
  return {
    type: "new_message",
    tenantId,
    conversationId,
    contactId: 10,
    preview: "hello",
    role: "user",
  };
}

describe("adminEventBus", () => {
  it("delivers events only to subscribers of the same tenant and unsubscribes cleanly", () => {
    const tenantId = Date.now();
    const received: AdminEvent[] = [];
    const unsubscribe = adminEventBus.subscribe(tenantId, (event) => {
      received.push(event);
    });

    try {
      const event = newMessageEvent(tenantId);
      adminEventBus.emit(event);
      adminEventBus.emit(newMessageEvent(tenantId + 1, 2));

      expect(received).toEqual([event]);

      unsubscribe();
      adminEventBus.emit(newMessageEvent(tenantId, 3));
      expect(received).toHaveLength(1);

      unsubscribe();
    } finally {
      unsubscribe();
    }
  });

  it("keeps notifying other handlers when one subscriber throws", () => {
    const tenantId = Date.now() + 1000;
    const received: AdminEvent[] = [];
    const unsubscribeThrowing = adminEventBus.subscribe(tenantId, () => {
      throw new Error("handler failed");
    });
    const unsubscribeReceiving = adminEventBus.subscribe(tenantId, (event) => {
      received.push(event);
    });

    try {
      const event: AdminEvent = {
        type: "stage_changed",
        tenantId,
        leadId: 5,
        toStage: "qualified",
        toStageDisplayName: "Qualified",
      };

      expect(() => adminEventBus.emit(event)).not.toThrow();
      expect(received).toEqual([event]);
    } finally {
      unsubscribeThrowing();
      unsubscribeReceiving();
    }
  });
});
