import { describe, expect, it } from "bun:test";
import {
  EXCHANGE_SAFE_FALLBACK,
	exchangeGuardFindingFromResult,
  guardExchangeReply,
} from "./exchange-reply-guard.ts";

describe("guardExchangeReply", () => {
  it("blocks concrete quote claims without quote tool trace", () => {
    const r = guardExchangeReply({ text: "Курс 31.5, получите 10553 THB." });
    expect(r.ok).toBe(false);
		expect(r.action).toBe("rewrite");
    expect(r.reason).toBe("unbacked_quote");
		expect(r.reasons).toEqual(["unbacked_quote"]);
		expect(r.requiredFixes[0]).toContain("compute_exchange_quote");
		expect(r.originalText).toBe("Курс 31.5, получите 10553 THB.");
    expect(r.text).toBe(EXCHANGE_SAFE_FALLBACK);

		expect(exchangeGuardFindingFromResult(r)).toEqual({
			action: "rewrite",
			reasons: ["unbacked_quote"],
			requiredFixes: [
				"Call compute_exchange_quote or create_exchange_order before sending a concrete rate or payout amount.",
			],
			originalText: "Курс 31.5, получите 10553 THB.",
			finalText: EXCHANGE_SAFE_FALLBACK,
			blocked: false,
		});
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

  it("does not treat crypto network in a tool-backed quote as payment requisites", () => {
    const r = guardExchangeReply({
      text: "Курс: 31.5. За 500 USDT (TRC20) получите 15750 THB.",
      telemetry: {
        toolCalls: [
          {
            name: "compute_exchange_quote",
            args: { asset: "USDT", amount: 500, network: "TRC20" },
            result: { rate: 31.5, amountToThb: 15750, network: "TRC20" },
            cycle: 0,
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("does not treat THB amount plus payout options as a payout code", () => {
    const r = guardExchangeReply({
      text: "Курс: 31.5. За 500 USDT получите 15750 THB. Можно выбрать офис, банкомат или курьера.",
      telemetry: {
        toolCalls: [
          {
            name: "compute_exchange_quote",
            args: { asset: "USDT", amount: 500 },
            result: { rate: 31.5, amountToThb: 15750 },
            cycle: 0,
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("does not treat a single source amount in KYC wording as a quote", () => {
    const r = guardExchangeReply({
      text: "Да, видео нужно для проверки документов перед обменом 500 USDT.",
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

  it("blocks payout code without issue_exchange_payout", () => {
		const r = guardExchangeReply({
			text: "Код выдачи 482913, можно снимать в банкомате.",
		});
    expect(r.ok).toBe(false);
		expect(r.action).toBe("escalate");
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
