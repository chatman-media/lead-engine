import { describe, expect, it } from "bun:test";
import { WebOutboundDispatcher } from "./web-dispatcher.ts";

describe("WebOutboundDispatcher run loop", () => {
	it("logs tick errors and stops when the abort signal fires", async () => {
		const controller = new AbortController();
		const errors: Array<{ message: string; err: Error }> = [];
		const dispatcher = new WebOutboundDispatcher({} as never, { size: () => 0 } as never, {
			pollMs: 0,
			batchSize: 1,
			log: {
				error: (message: string, ctx: { err: Error }) => {
					errors.push({ message, err: ctx.err });
				},
			} as never,
		});
		let ticks = 0;
		(dispatcher as unknown as { tick: () => Promise<void> }).tick = async () => {
			ticks += 1;
			controller.abort();
			throw "tick down";
		};

		await dispatcher.run(controller.signal);

		expect(ticks).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("web dispatcher tick error");
		expect(errors[0]?.err).toBeInstanceOf(Error);
		expect(errors[0]?.err.message).toBe("tick down");
	});
});
