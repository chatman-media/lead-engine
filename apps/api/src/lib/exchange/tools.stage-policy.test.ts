import { describe, expect, it } from "bun:test";
import {
	exchangeAllowedActionsBlock,
	guardExchangeToolForStage,
	isKnownExchangeStage,
} from "./tools.ts";

describe("exchange tool stage policy", () => {
	it("recognizes exchange_v1 stages", () => {
		expect(isKnownExchangeStage("exchange_request")).toBe(true);
		expect(isKnownExchangeStage("payment_verified")).toBe(true);
		expect(isKnownExchangeStage("intent_detected")).toBe(false);
		expect(isKnownExchangeStage("exchange_offer")).toBe(false);
	});

	it("allows quote calculation early in the funnel", () => {
		expect(guardExchangeToolForStage("compute_exchange_quote", "exchange_request")).toBeNull();
	});

	it("allows quote recalculation while KYC is pending", () => {
		expect(guardExchangeToolForStage("compute_exchange_quote", "kyc_collection")).toBeNull();
	});

	it("blocks requisites before order_created/requisites_sent", () => {
		const denied = guardExchangeToolForStage("fetch_exchange_requisites", "quote_calculated");
		expect(denied).toMatchObject({
			ok: false,
			needsOperator: true,
			reason: "action_not_allowed_for_stage",
			toolName: "fetch_exchange_requisites",
			stageSlug: "quote_calculated",
		});
		expect(denied?.allowedTools).toContain("create_exchange_order");
		expect(denied?.allowedTools).not.toContain("fetch_exchange_requisites");
	});

	it("blocks payment verification before requisites are sent", () => {
		const denied = guardExchangeToolForStage("verify_exchange_payment", "order_created");
		expect(denied?.reason).toBe("action_not_allowed_for_stage");
	});

	it("blocks payout until payment_verified", () => {
		const denied = guardExchangeToolForStage("issue_exchange_payout", "payment_proof_waiting");
		expect(denied?.reason).toBe("action_not_allowed_for_stage");
		expect(guardExchangeToolForStage("issue_exchange_payout", "payment_verified")).toBeNull();
	});

	it("renders allowed-actions prompt block for current stage", () => {
		const block = exchangeAllowedActionsBlock("payment_verified");
		expect(block).toContain("Текущая стадия exchange: payment_verified");
		expect(block).toContain("issue_exchange_payout");
		expect(block).not.toContain("fetch_exchange_requisites");
	});
});
