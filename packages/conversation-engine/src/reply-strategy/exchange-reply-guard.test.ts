import { describe, expect, it } from "bun:test";
import {
	EXCHANGE_SAFE_FALLBACK,
	guardExchangeReply,
} from "./exchange-reply-guard.ts";

describe("guardExchangeReply", () => {
	it("blocks concrete quote claims without quote tool trace", () => {
		const r = guardExchangeReply({ text: "Курс 31.5, получите 10553 THB." });
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("unbacked_quote");
		expect(r.text).toBe(EXCHANGE_SAFE_FALLBACK);
	});

	it("allows concrete quote claims backed by compute_exchange_quote", () => {
		const r = guardExchangeReply({
			text: "Курс 31.5, получите 10553 THB.",
			telemetry: {
				toolCalls: [
					{
						name: "compute_exchange_quote",
						args: { asset: "USDT", amount: 335 },
						result: { rate: 31.5, amountToThb: 10553 },
						cycle: 0,
					},
				],
			},
		});
		expect(r.ok).toBe(true);
	});

	it("blocks payment requisites without fetch_exchange_requisites", () => {
		const r = guardExchangeReply({
			text: "Оплатите по карте 2200 7000 1234 5678, после оплаты пришлите чек.",
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("unbacked_requisites");
	});

	it("allows requisites backed by fetch_exchange_requisites without requiring quote tool", () => {
		const r = guardExchangeReply({
			text: "Переведите USDT TRC20 на кошелек TQ7abc1234567890123456789012.",
			telemetry: {
				toolCalls: [
					{
						name: "fetch_exchange_requisites",
						args: {},
						result: {
							address: "TQ7abc1234567890123456789012",
							network: "TRC20",
						},
						cycle: 0,
					},
				],
			},
		});
		expect(r.ok).toBe(true);
	});

	it("does not treat failed requisites tool as backing", () => {
		const r = guardExchangeReply({
			text: "Оплатите по ссылке https://pay.example/test.",
			telemetry: {
				toolCalls: [
					{
						name: "fetch_exchange_requisites",
						args: {},
						result: { needsOperator: true },
						cycle: 0,
					},
				],
			},
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("unbacked_requisites");
	});

	it("allows soft process wording without concrete payment details", () => {
		const r = guardExchangeReply({
			text: "После подтверждения заявки пришлю реквизиты и срок действия.",
		});
		expect(r.ok).toBe(true);
	});

	it("allows safety disclaimers mentioning address or requisites without concrete details", () => {
		const r = guardExchangeReply({
			text: "Передаю вопрос оператору. До подтверждения человека я не буду называть неподтверждённый курс, адрес, реквизиты или статус проверки.",
		});
		expect(r.ok).toBe(true);
	});

	it("blocks payout code without issue_exchange_payout", () => {
		const r = guardExchangeReply({
			text: "Код выдачи 482913, можно снимать в банкомате.",
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("unbacked_payout_code");
	});

	it("blocks manual rate negotiation", () => {
		const r = guardExchangeReply({
			text: "Для вас сделаем курс лучше, договоримся.",
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("rate_negotiation");
	});
});
