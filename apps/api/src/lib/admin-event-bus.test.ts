import { describe, expect, it } from "bun:test";
import { type AdminEvent, adminEventBus } from "./admin-event-bus.ts";

describe("adminEventBus", () => {
	it("delivers events only to subscribers of the matching tenant", () => {
		const seenA: AdminEvent[] = [];
		const seenB: AdminEvent[] = [];
		const offA = adminEventBus.subscribe(10_001, (event) => seenA.push(event));
		const offB = adminEventBus.subscribe(10_002, (event) => seenB.push(event));

		adminEventBus.emit({
			type: "new_message",
			tenantId: 10_001,
			conversationId: 1,
			contactId: 2,
			preview: "hello",
		});

		expect(seenA).toHaveLength(1);
		expect(seenB).toHaveLength(0);
		offA();
		offB();
	});

	it("unsubscribes and isolates handler failures", () => {
		const seen: AdminEvent[] = [];
		const offThrowing = adminEventBus.subscribe(10_003, () => {
			throw new Error("subscriber failed");
		});
		const offSeen = adminEventBus.subscribe(10_003, (event) =>
			seen.push(event),
		);

		adminEventBus.emit({
			type: "conversation_mode",
			tenantId: 10_003,
			conversationId: 5,
			mode: "human",
		});
		expect(seen).toHaveLength(1);

		offSeen();
		adminEventBus.emit({
			type: "stage_changed",
			tenantId: 10_003,
			leadId: 7,
			toStage: "done",
			toStageDisplayName: "Done",
		});
		expect(seen).toHaveLength(1);
		offThrowing();
	});
});
