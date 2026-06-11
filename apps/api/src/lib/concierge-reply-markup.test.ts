import { describe, expect, it, mock } from "bun:test";
import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import { normalizeReplyStrategyResult } from "@chatman-media/conversation-engine";
import {
  CONCIERGE_INTAKE_STAGE,
  expandCallbackQuery,
  SERVICE_BUTTON_PREFIX,
  SERVICE_LABEL,
  wrapWithConciergeButtons,
} from "./concierge-reply-markup.ts";

// ── expandCallbackQuery ────────────────────────────────────────────────────────

function makeCallbackInbound(data: string, rawCbId = "cb123"): Inbound {
  return {
    channelId: "ch1",
    externalMessageId: "msg42",
    externalUserId: "u1",
    parts: [{ kind: "callback_query", data, originalMessageId: "msg42" }],
    receivedAt: 0,
    raw: { callback_query: { id: rawCbId, data, from: {}, message: { message_id: 42 } } },
  };
}

function makeTextInbound(text: string): Inbound {
  return {
    channelId: "ch1",
    externalMessageId: "msg1",
    externalUserId: "u1",
    parts: [{ kind: "text", text }],
    receivedAt: 0,
    raw: {},
  };
}

describe("expandCallbackQuery", () => {
  it("returns null for text inbound", () => {
    expect(expandCallbackQuery(makeTextInbound("hello"))).toBeNull();
  });

  it("returns null for unrelated callback_query data", () => {
    expect(expandCallbackQuery(makeCallbackInbound("unrelated:data"))).toBeNull();
  });

  it("returns null for callback_query without srv: prefix", () => {
    expect(expandCallbackQuery(makeCallbackInbound("exchange"))).toBeNull();
  });

  for (const [key, label] of Object.entries(SERVICE_LABEL)) {
    it(`expands srv:${key} → text "${label}"`, () => {
      const result = expandCallbackQuery(makeCallbackInbound(`${SERVICE_BUTTON_PREFIX}${key}`));
      expect(result).not.toBeNull();
      expect(result!.serviceLabel).toBe(label);
      expect(result!.syntheticInbound.parts).toEqual([{ kind: "text", text: label }]);
      expect(result!.callbackQueryId).toBe("cb123");
    });
  }

  it("synthetic inbound has deduplication-safe externalMessageId", () => {
    const result = expandCallbackQuery(makeCallbackInbound(`${SERVICE_BUTTON_PREFIX}transfer`));
    expect(result!.syntheticInbound.externalMessageId).not.toBe("msg42");
    expect(result!.syntheticInbound.externalMessageId).toContain("transfer");
  });

  it("uses inbound.externalMessageId as callbackQueryId fallback when raw absent", () => {
    const inbound: Inbound = {
      ...makeCallbackInbound(`${SERVICE_BUTTON_PREFIX}food`),
      raw: {},
    };
    const result = expandCallbackQuery(inbound);
    expect(result!.callbackQueryId).toBe("msg42");
  });
});

// ── wrapWithConciergeButtons ───────────────────────────────────────────────────

const MOCK_ENVELOPE: OutboundEnvelope = {
	channelId: "ch1",
	externalUserId: "u1",
	parts: [{ kind: "text", text: "Здравствуйте!" }],
};

function makeStrategy(envelopes: OutboundEnvelope[]) {
	return { generate: mock(async () => envelopes) };
}

async function makeDbWithStage(slug: string | null) {
  // Minimal db mock: select returns slug
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () =>
                slug ? [{ slug, kind: "lead" }] : [],
            }),
          }),
        }),
      }),
    }),
  } as never;
}

const MOCK_OPTS = {
  tenant: { tenantId: 1, slug: "t", llmBillingMode: "byok" as const },
  channel: { channelId: 1, kind: "telegram_bot" as never, externalId: "bot" },
  conversationId: 1,
  contactId: 2,
  inbound: makeTextInbound("hi"),
  userMessageText: "hi",
};

function resultEnvelopes(
	result: Parameters<typeof normalizeReplyStrategyResult>[0],
) {
	return normalizeReplyStrategyResult(result)?.envelopes ?? [];
}

describe("wrapWithConciergeButtons", () => {
  it("does not add buttons when stage is not request_received", async () => {
    const inner = makeStrategy([MOCK_ENVELOPE]);
		const db = await makeDbWithStage("exchange_request");
		const wrapped = wrapWithConciergeButtons(inner, db);
		const result = await wrapped.generate(MOCK_OPTS);
		expect(resultEnvelopes(result)[0]?.replyMarkup).toBeUndefined();
	});

  it("adds inline buttons when stage is request_received", async () => {
    const inner = makeStrategy([MOCK_ENVELOPE]);
		const db = await makeDbWithStage(CONCIERGE_INTAKE_STAGE);
		const wrapped = wrapWithConciergeButtons(inner, db);
		const result = await wrapped.generate(MOCK_OPTS);
		const envelopes = resultEnvelopes(result);
		expect(envelopes[0]?.replyMarkup).toBeDefined();
		const buttons = envelopes[0]?.replyMarkup?.inlineButtons ?? [];
		const allData = buttons.flat().map((b) => b.callbackData);
    expect(allData).toContain(`${SERVICE_BUTTON_PREFIX}exchange`);
    expect(allData).toContain(`${SERVICE_BUTTON_PREFIX}transfer`);
    expect(allData).toContain(`${SERVICE_BUTTON_PREFIX}food`);
    expect(allData).toContain(`${SERVICE_BUTTON_PREFIX}housekeeping`);
    expect(allData).toContain(`${SERVICE_BUTTON_PREFIX}tour`);
  });

  it("adds buttons only to last envelope when multiple", async () => {
    const inner = makeStrategy([MOCK_ENVELOPE, MOCK_ENVELOPE]);
		const db = await makeDbWithStage(CONCIERGE_INTAKE_STAGE);
		const wrapped = wrapWithConciergeButtons(inner, db);
		const result = await wrapped.generate(MOCK_OPTS);
		const envelopes = resultEnvelopes(result);
		expect(envelopes.length).toBe(2);
		expect(envelopes[0]?.replyMarkup).toBeUndefined();
		expect(envelopes[1]?.replyMarkup).toBeDefined();
	});

  it("returns null/empty when inner strategy does", async () => {
    const inner = makeStrategy([]);
		const db = await makeDbWithStage(CONCIERGE_INTAKE_STAGE);
		const wrapped = wrapWithConciergeButtons(inner, db);
		const result = await wrapped.generate(MOCK_OPTS);
		expect(resultEnvelopes(result)).toHaveLength(0);
	});

  it("returns inner result unchanged when db throws", async () => {
    const inner = makeStrategy([MOCK_ENVELOPE]);
    const badDb = {
      select: () => { throw new Error("db error"); },
	    } as never;
	    const wrapped = wrapWithConciergeButtons(inner, badDb);
	    const result = await wrapped.generate(MOCK_OPTS);
	    expect(resultEnvelopes(result)[0]?.replyMarkup).toBeUndefined();
	  });
});
