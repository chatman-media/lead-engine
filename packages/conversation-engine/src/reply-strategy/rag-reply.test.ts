// Unit tests for RagReplyStrategy.generate — RAG reply orchestration. Все
// коллабораторы (chat / embed / kb / messages / conversations / suggestions)
// фейковые и собираются в RagTurnContext; answerWithRag прогоняется
// по-настоящему на фейковом KB/chat (как в kb/answer.test). Без БД и сети.

import { describe, expect, it } from "bun:test";
import { makeBookingLinkTool } from "@chatman-media/kb";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { MessageRow } from "../dal/messages.ts";
import { normalizeReplyStrategyResult } from "../process-inbound.ts";
import { EXCHANGE_PAYMENT_FALLBACK } from "./exchange-policy-guard.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";
import {
  parseStyleConfig,
  RagReplyStrategy,
  type RagReplyStrategyOpts,
  type RagTurnContext,
  type ResolvedStyleAssignment,
} from "./rag-reply.ts";

const TENANT = { tenantId: 1 };
const CHANNEL = { channelId: 10 };

// job-intent текст — не триггерит persona-shortcuts в answerWithRag.
const QUESTION = "расскажи про условия обмена usdt на баты";

function firstReplyText(result: Awaited<ReturnType<RagReplyStrategy["generate"]>>): string {
  const normalized = normalizeReplyStrategyResult(result);
  const part = normalized?.envelopes[0]?.parts[0];
  return part?.kind === "text" ? part.text : "";
}

function chatReturning(reply: string): ChatClient {
  return { complete: async () => reply } as unknown as ChatClient;
}

class CapturingRagChat implements ChatClient {
  lastCall: { messages: ChatMessage[]; opts: unknown } | null = null;

  constructor(public readonly reply: string) {}

  async complete(messages: ChatMessage[], opts?: unknown): Promise<string> {
    this.lastCall = { messages, opts };
    return this.reply;
  }
}

function chatThenFactCheck(
	reply: string,
	verdict: Record<string, unknown>,
): ChatClient {
  let calls = 0;
  return {
    complete: async () => {
      calls += 1;
      return calls === 1 ? reply : JSON.stringify(verdict);
    },
  } as unknown as ChatClient;
}

const embedder: RagTurnContext["embedder"] = {
  embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
  dim: 3,
} as never;

function kbWith(hits: unknown[]): RagTurnContext["kb"] {
  return {
    search: async () => hits,
    hybridSearch: async () => hits,
    prioritySearch: async () => hits,
  } as never;
}

const HIT = {
  chunk_id: 1,
  distance: 0.1,
  text: "USDT меняем по курсу 36.5 бат без комиссии",
  document_id: 1,
  source: "kb",
  title: "Курсы",
};

const GENERIC_TEMPLATE = {
  slug: "generic_v1",
  displayName: "Generic",
  version: 1,
  funnelStages: [],
  systemPromptFragment: "",
} as unknown as VerticalTemplate;

const EXCHANGE_TEMPLATE = {
  slug: "exchange_v1",
  displayName: "Exchange",
  version: 1,
  funnelStages: [],
  systemPromptFragment: "",
} as unknown as VerticalTemplate;

const STYLE: ResolvedStyleAssignment = {
  slug: "exch-pro",
  displayName: "Exchange Pro",
  persona: { name: "Alex", role: "human", company: "Acme" },
  voice: { tone: "friendly", language: "ru", forbid: [] },
  framework: "SPIN",
  hooks: [],
  stages: {},
  fewShot: [],
	guardrails: {
		noMinors: true,
		botDisclosureOnDirectQuestion: true,
		forbiddenTopics: [],
	},
  model: { id: "x", temperature: 0.5, maxTokens: 100 },
};

/** Минимальный messagesRepo с recent/countByConversation/insert. */
function fakeMessages(
	opts: { recent?: unknown[]; count?: number } = {},
): RagTurnContext["messages"] {
  const rows = () =>
    (opts.recent ?? []).map((item, index) => {
      const row = item as Partial<MessageRow>;
      return {
        id: row.id ?? index + 1,
        tenantId: row.tenantId ?? 1,
        conversationId: row.conversationId ?? 100,
        role: row.role ?? "user",
        text: row.text ?? "",
        tgMessageId: row.tgMessageId ?? null,
        metaJson: row.metaJson ?? null,
        createdAt: row.createdAt ?? 1700000000 + index,
        stage: row.stage ?? null,
        deletedAt: row.deletedAt ?? null,
      } as MessageRow;
    });
  return {
    recent: async (_conversationId: number, limit: number) => rows().slice(-limit),
    countByConversation: async () => opts.count ?? rows().length,
    forConversationSummary: async (
      _conversationId: number,
      summaryOpts: {
        afterMessageId?: number | null;
        beforeMessageId: number;
        limit: number;
      },
    ) =>
      rows()
        .filter(
          (item) =>
            item.id < summaryOpts.beforeMessageId &&
            (summaryOpts.afterMessageId == null ||
              item.id > summaryOpts.afterMessageId) &&
            item.deletedAt == null &&
            item.role !== "system",
        )
        .slice(0, summaryOpts.limit),
    insert: async () => ({ id: 1 }),
  } as never;
}

const baseInput = () => ({
  tenant: TENANT,
  channel: CHANNEL,
  conversationId: 100,
  contactId: 5,
  inbound: { externalUserId: "u1" },
  userMessageText: QUESTION,
});

/** Контекст хода с дефолтами; тесты переопределяют только нужные поля. */
function ctxWith(partial: Partial<RagTurnContext>): RagTurnContext {
  return {
    template: GENERIC_TEMPLATE,
    chat: chatReturning("x"),
    embedder,
    kb: kbWith([]),
    messages: fakeMessages(),
    ...partial,
  };
}

function mk(
	ctx: RagTurnContext,
	opts: Partial<RagReplyStrategyOpts> = {},
): RagReplyStrategy {
  return new RagReplyStrategy({ loadTurnContext: () => ctx, ...opts });
}

describe("RagReplyStrategy.generate", () => {
  it("пустой userMessageText → null", async () => {
    const s = mk(ctxWith({}));
    const r = await s.generate({ ...baseInput(), userMessageText: "" });
    expect(r).toBeNull();
  });

  it("isSupport=true → null (оператор ведёт вручную)", async () => {
    const s = mk(ctxWith({ kb: kbWith([HIT]), isSupport: true }));
    expect(await s.generate(baseInput())).toBeNull();
  });

  it("happy: KB-хит → envelope с текстом ответа", async () => {
    const s = mk(
      ctxWith({
        chat: chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        kb: kbWith([HIT]),
      }),
    );
    const r = await s.generate(baseInput());
    const normalized = normalizeReplyStrategyResult(r);
    expect(r).not.toBeNull();
    expect(normalized?.envelopes).toHaveLength(1);
    expect(normalized?.envelopes[0]?.channelId).toBe("10");
    expect(normalized?.envelopes[0]?.externalUserId).toBe("u1");
    expect(firstReplyText(r).toLowerCase()).toContain("курс");
  });

  it("injects brokered order context into RAG request context", async () => {
    const chat = new CapturingRagChat("По заявке есть предложение.");
    const s = mk(
      ctxWith({
        chat,
        kb: kbWith([HIT]),
        serviceOrderContext:
          "BROKERED ORDER CONTEXT\n- order #12 service=massage status=offer_ready amount=1,200 THB",
      }),
      { rewriteQueryBeforeRetrieval: false, reflect: false },
    );

    await s.generate({ ...baseInput(), userMessageText: "что по заявке?" });

    const system = chat.lastCall?.messages[0]?.content ?? "";
    expect(system).toContain("BROKERED ORDER CONTEXT");
    expect(system).toContain("order #12");
    expect(system).toContain("status=offer_ready");
  });

  it("injects rolling summary into RAG prompt and excludes current message by id", async () => {
    const chat = new CapturingRagChat("Курс 36.5 бат за USDT, без комиссии");
    let savedJson = "";
    const s = mk(
      ctxWith({
        chat,
        kb: kbWith([HIT]),
        messages: fakeMessages({
          recent: [
            { id: 1, role: "user", text: "старый вопрос" },
            { id: 2, role: "assistant", text: "старый ответ" },
            { id: 3, role: "user", text: "старое уточнение" },
            { id: 4, role: "assistant", text: "сырой ответ" },
            { id: 5, role: "user", text: "сырой вопрос" },
            { id: 6, role: "user", text: QUESTION },
          ],
          count: 6,
        }),
        conversations: {
          findById: async () => ({ summaryJson: null }),
          setSummaryJson: async (_id: number, json: string) => {
            savedJson = json;
          },
        } as never,
      }),
      { historyLimit: 2, compactAfterMessages: 3, reflect: false },
    );

    const r = await s.generate({ ...baseInput(), userMessageId: 6 });

    expect(r).not.toBeNull();
    const finalMessages = chat.lastCall?.messages ?? [];
    const system = finalMessages[0]?.content ?? "";
    expect(system).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(system).toContain("Курс 36.5 бат за USDT, без комиссии");
    expect(finalMessages).toContainEqual({
      role: "assistant",
      content: "сырой ответ",
    });
    expect(finalMessages).toContainEqual({
      role: "user",
      content: "сырой вопрос",
    });
    expect(finalMessages).toContainEqual({ role: "user", content: QUESTION });
    expect(JSON.parse(savedJson)).toMatchObject({ throughMessageId: 3 });
  });

  it("uses resolved KB scope for RAG retrieval", async () => {
    const scopes: string[] = [];
    const s = mk(
      ctxWith({
        chat: chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        kbScope: { scopeType: "stage", funnelId: 77, stageSlug: "payment" },
        kb: {
          search: async () => [],
          hybridSearch: async (input: {
            scope?: {
              scopeType: string;
              funnelId?: number | null;
              stageSlug?: string | null;
            };
          }) => {
            const scope = input.scope;
            scopes.push(
              scope
                ? `${scope.scopeType}:${scope.funnelId ?? ""}:${scope.stageSlug ?? ""}`
                : "none",
            );
            return scope?.scopeType === "stage" ? [HIT] : [];
          },
          prioritySearch: async () => [],
        } as never,
      }),
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    expect(scopes).toEqual(["stage:77:payment"]);
  });

  it("passes resolved KB scope to no-context suggestions", async () => {
    let loggedScope: unknown = null;
    const s = mk(
      ctxWith({
        chat: chatReturning("Уточню детали и вернусь!"),
        kbScope: { scopeType: "stage", funnelId: 77, stageSlug: "payment" },
        suggestions: {
          log: async (opts: { scope?: unknown }) => {
            loggedScope = opts.scope;
          },
        } as never,
      }),
      { softFallback: true },
    );

    await s.generate(baseInput());

    expect(loggedScope).toEqual({
      scopeType: "stage",
      funnelId: 77,
      stageSlug: "payment",
    });
  });

  it("tool-loop telemetry пробрасывается в recordToolCalls", async () => {
    let toolLoopCalls = 0;
    const chat = {
			complete: async () =>
				"Вот ссылка для записи: https://calendly.example/demo",
      completeWithTools: async () => {
        toolLoopCalls += 1;
        if (toolLoopCalls === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "q1",
                name: "offer_booking_link",
                args: {},
              },
            ],
          };
        }
				return {
					content: "Вот ссылка для записи: https://calendly.example/demo",
					toolCalls: [],
				};
      },
    } as unknown as ChatClient;
    const tool = makeBookingLinkTool("https://calendly.example/demo");
		const recorded: Array<
			Parameters<NonNullable<RagReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const s = mk(ctxWith({ chat, kb: kbWith([HIT]), tools: [tool] }), {
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
		});

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: 1,
      conversationId: 100,
      contactId: 5,
      userMessageText: QUESTION,
      assistantText: "Вот ссылка для записи: https://calendly.example/demo",
    });
    expect(recorded[0]?.telemetry.toolCalls?.[0]).toMatchObject({
      name: "offer_booking_link",
      args: {},
      result: { url: "https://calendly.example/demo" },
      cycle: 0,
    });
  });

  it("style assignment metadata сохраняется в conversation", async () => {
		const saved: Array<{
			conversationId: number;
			styleId?: number | null;
			experimentId?: number | null;
		}> = [];
    const s = mk(
      ctxWith({
        chat: chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        kb: kbWith([HIT]),
        style: {
          ...STYLE,
          styleId: 7,
          experimentId: 3,
          experimentSlug: "exp-a",
          variantSlug: "exch-pro",
        },
        conversations: {
          setAssignment: async (
            conversationId: number,
						assignment: {
							styleId?: number | null;
							experimentId?: number | null;
						},
          ) => {
            saved.push({ conversationId, ...assignment });
          },
        } as never,
      }),
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
		expect(saved[0]).toEqual({
			conversationId: 100,
			styleId: 7,
			experimentId: 3,
		});
  });

  it("exchange: неподкреплённый курс заменяется safe fallback", async () => {
    const s = mk(
      ctxWith({
        template: EXCHANGE_TEMPLATE,
        chat: chatReturning("Курс 31.5, получите 10553 THB."),
        kb: kbWith([HIT]),
      }),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    expect(firstReplyText(r)).toBe(EXCHANGE_SAFE_FALLBACK);
  });

	it("exchange: guard finding is recorded even without tool calls", async () => {
		const recorded: Array<
			Parameters<NonNullable<RagReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const s = mk(
			ctxWith({
				template: EXCHANGE_TEMPLATE,
				chat: chatReturning("Курс 31.5, получите 10553 THB."),
				kb: kbWith([HIT]),
			}),
			{
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
		);

		const r = await s.generate(baseInput());

		expect(r).not.toBeNull();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.guardFindings?.[0]).toMatchObject({
			action: "rewrite",
			reasons: ["unbacked_quote"],
			originalText: "Курс 31.5, получите 10553 THB.",
			finalText: EXCHANGE_SAFE_FALLBACK,
		});
	});

	it("exchange: response guard can be disabled by tenant flag", async () => {
		const recorded: Array<
			Parameters<NonNullable<RagReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const unsafeText = "Курс 31.5, получите 10553 THB.";
		const s = mk(
			ctxWith({
				template: EXCHANGE_TEMPLATE,
				chat: chatReturning(unsafeText),
				kb: kbWith([HIT]),
				exchangeResponseGuardEnabled: false,
			}),
			{
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
		);

		const r = await s.generate(baseInput());

		expect(r).not.toBeNull();
		expect(firstReplyText(r)).toBe(unsafeText);
		expect(recorded).toHaveLength(0);
	});

  it("exchange: policy guard blocks payment confirmation without verified payment state", async () => {
    const s = mk(
      ctxWith({
        template: EXCHANGE_TEMPLATE,
        chat: chatReturning("Оплата получена и подтверждена, готовлю выдачу."),
        kb: kbWith([HIT]),
        exchangePolicyState: {
          stageSlug: "payment_review",
          order: {
            id: 9,
            status: "awaiting_payment",
            requisitesIssued: true,
            paymentProofReceived: true,
            paymentVerified: false,
            payoutReady: false,
            payoutCompleted: false,
            payoutCodeIssued: false,
          },
        },
      }),
      { rewriteQueryBeforeRetrieval: false, reflect: false },
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    expect(firstReplyText(r)).toBe(EXCHANGE_PAYMENT_FALLBACK);
  });

	it("exchange: payment proof answer attaches payment-review operator handoff", async () => {
	    const s = mk(
	      ctxWith({
        template: EXCHANGE_TEMPLATE,
        chat: chatReturning("Чек получили, передаю оператору на проверку."),
        kb: kbWith([HIT]),
        exchangePolicyState: {
          stageSlug: "payment_review",
          verification: {
            verified: true,
            status: "verified",
            needsVerification: false,
          },
          order: {
            id: 77,
            status: "awaiting_payment",
            assetFrom: "RUB",
            network: "",
            amountMode: "source_amount",
            requestedAmount: 100000,
            amountFrom: 100000,
            rate: 0.38,
            amountToThb: 38000,
            paymentMethod: "bank_transfer",
            paymentRail: "sber",
            payoutMethod: "office_cash",
            payoutLocation: "Bangkok Asok",
            requisitesIssued: true,
            paymentProofReceived: true,
            paymentVerified: false,
            payoutReady: false,
            payoutCompleted: false,
            payoutCodeIssued: false,
          },
        },
      }),
      { rewriteQueryBeforeRetrieval: false, reflect: false },
    );

    const r = await s.generate(baseInput());
    const normalized = normalizeReplyStrategyResult(r);

    expect(normalized?.operatorHandoffs?.[0]).toMatchObject({
      reason: "payment_review",
      orderId: 77,
      stageSlug: "payment_review",
      pending: "operator_payment_review",
    });
	    expect(normalized?.autoTakeover).toBe(true);
	  });

	it("exchange: amount request computes quote without exposing rate", async () => {
		const chat = new CapturingRagChat("Сейчас посчитаю через RAG.");
		let seenArgs: unknown = null;
		const recorded: Array<
			Parameters<NonNullable<RagReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const s = mk(
			ctxWith({
				template: EXCHANGE_TEMPLATE,
				chat,
				kb: kbWith([HIT]),
				tools: [
					{
						name: "compute_exchange_quote",
						description: "compute quote",
						parameters: {},
						execute: async (args: unknown) => {
							seenArgs = args;
							return {
								direction: "RUB->PHP",
								asset: "RUB",
								quoteAsset: "PHP",
								amountMode: "source_amount",
								amountFrom: 10000,
								rate: 1.230575,
								amountToThb: 8126,
							};
						},
					},
				] as never,
			}),
			{
				reflect: false,
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
		);

		const r = await s.generate({
			...baseInput(),
			userMessageText: "10к рублей",
		});

		expect(firstReplyText(r)).toBe("Получите 8126 PHP.");
		expect(firstReplyText(r).toLowerCase()).not.toContain("курс");
		expect(chat.lastCall).toBeNull();
		expect(seenArgs).toMatchObject({
			asset: "RUB",
			amount: 10000,
			amountMode: "source_amount",
		});
		expect(recorded[0]?.telemetry.toolCalls?.[0]?.name).toBe(
			"compute_exchange_quote",
		);
	});

	it("exchange: «500 USDT … Какой курс» парсит сумму как 500, не 500000", async () => {
		const chat = new CapturingRagChat("Сейчас посчитаю через RAG.");
		let seenArgs: unknown = null;
		const s = mk(
			ctxWith({
				template: EXCHANGE_TEMPLATE,
				chat,
				kb: kbWith([HIT]),
				tools: [
					{
						name: "compute_exchange_quote",
						description: "compute quote",
						parameters: {},
						execute: async (args: unknown) => {
							seenArgs = args;
							return {
								direction: "USDT->PHP",
								asset: "USDT",
								quoteAsset: "PHP",
								amountMode: "source_amount",
								amountFrom: 500,
								rate: 58,
								amountToThb: 29000,
							};
						},
					},
				] as never,
			}),
			{ reflect: false },
		);

		const r = await s.generate({
			...baseInput(),
			userMessageText:
				"Хочу обменять 500 USDT (TRC20) на песо. Какой курс и сколько песо я получу на руки?",
		});

		// Регрессия: слово «Какой» обрезалось окном `after` до хвостового «к» и
		// давало ложный множитель ×1000 → 500 превращалось в 500000.
		expect(seenArgs).toMatchObject({
			asset: "USDT",
			amount: 500,
			network: "TRC20",
		});
		expect(firstReplyText(r)).toBe("Получите 29000 PHP.");
		expect(chat.lastCall).toBeNull();
	});

	it("exchange: confirmation after quote creates order preflight and asks for KYC", async () => {
		const chat = new CapturingRagChat("Сейчас снова посчитаю.");
		const instructions =
			"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.";
		let seenArgs: unknown = null;
		const recorded: Array<
			Parameters<NonNullable<RagReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const s = mk(
			ctxWith({
				template: EXCHANGE_TEMPLATE,
				chat,
				kb: kbWith([HIT]),
				messages: fakeMessages({
					recent: [
						{
							role: "user",
							text: "отдаю 10к рублей нужны песо в банкомате",
						},
						{ role: "assistant", text: "Получите 8126 PHP." },
						{ role: "user", text: "супер давай" },
					],
				}),
				exchangePolicyState: {
					stageSlug: "quote_calculated",
					verification: {
						verified: false,
						status: "missing",
						needsVerification: true,
					},
				},
				tools: [
					{
						name: "create_exchange_order",
						description: "create order",
						parameters: {},
						execute: async (args: unknown) => {
							seenArgs = args;
							return {
								ok: false,
								needsVerification: true,
								status: "missing",
								instructions,
							};
						},
					},
				] as never,
			}),
			{
				reflect: false,
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
		);

		const r = await s.generate({
			...baseInput(),
			userMessageText: "супер давай",
		});

		expect(firstReplyText(r)).toBe(instructions);
		expect(chat.lastCall).toBeNull();
		expect(seenArgs).toMatchObject({
			asset: "RUB",
			amount: 10000,
			amountMode: "source_amount",
			paymentMethod: "bank_transfer",
			payoutMethod: "atm",
		});
		expect(recorded[0]?.telemetry.toolCalls?.[0]?.name).toBe(
			"create_exchange_order",
		);
	});

	  it("exchange: no-context без softFallback возвращает safe fallback вместо null", async () => {
	    const s = mk(
      ctxWith({
        template: EXCHANGE_TEMPLATE,
        chat: chatReturning("ответ"),
      }),
      { softFallback: false },
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    expect(firstReplyText(r)).toBe(EXCHANGE_SAFE_FALLBACK);
  });

  it("exchange: reflect срезает неподкреплённый статус и возвращает safe fallback", async () => {
    const s = mk(
      ctxWith({
        template: EXCHANGE_TEMPLATE,
        chat: chatThenFactCheck("Курьер будет через 10 минут.", {
          grounded: false,
          vacancyOk: true,
          reason: "delivery ETA not in context",
        }),
        kb: kbWith([HIT]),
      }),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    expect(firstReplyText(r)).toBe(EXCHANGE_SAFE_FALLBACK);
  });

  it("no-context + softFallback → envelope с fallback-текстом + лог в suggestions", async () => {
    let logged = false;
    const s = mk(
      ctxWith({
        chat: chatReturning("Уточню детали и вернусь!"),
        suggestions: {
          log: async () => {
            logged = true;
          },
        } as never,
      }),
      { softFallback: true },
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    expect(firstReplyText(r).length).toBeGreaterThan(0);
    expect(logged).toBe(true);
  });

  it("no-context без softFallback → null", async () => {
		const s = mk(ctxWith({ chat: chatReturning("ответ") }), {
			softFallback: false,
		});
    expect(await s.generate(baseInput())).toBeNull();
  });

  it("style assignment: setAssignment падает → warn, ответ не ломается", async () => {
    const s = mk(
      ctxWith({
        chat: chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        kb: kbWith([HIT]),
        style: { ...STYLE, styleId: 7 },
        conversations: {
          setAssignment: async () => {
            throw new Error("assignment save down");
          },
        } as never,
      }),
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    expect(firstReplyText(r).toLowerCase()).toContain("курс");
  });

  it("compaction: ошибка LLM при сжатии глотается, ответ всё равно генерится", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
    }));
    let calls = 0;
    const chat = {
      complete: async () => {
        calls += 1;
        // Первый вызов — compactConversation; падает только он.
        if (calls === 1) throw new Error("compactor down");
        return "Курс 36.5 бат за USDT, без комиссии";
      },
    } as unknown as ChatClient;
    let summarySaved = false;
    const s = mk(
      ctxWith({
        chat,
        kb: kbWith([HIT]),
        messages: fakeMessages({ recent: many, count: 20 }),
        conversations: {
          findById: async () => ({ id: 100, summaryJson: null }),
          setSummaryJson: async () => {
            summarySaved = true;
          },
        } as never,
      }),
      { compactAfterMessages: 20 },
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    expect(calls).toBeGreaterThan(1);
    expect(summarySaved).toBe(false); // компакция упала — нечего сохранять
  });

  it("compaction: setSummaryJson падает → warn, ответ не ломается", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
    }));
    const s = mk(
      ctxWith({
        chat: chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        kb: kbWith([HIT]),
        messages: fakeMessages({ recent: many, count: 20 }),
        conversations: {
          findById: async () => ({ id: 100, summaryJson: null }),
          setSummaryJson: async () => {
            throw new Error("summary save down");
          },
        } as never,
      }),
      { compactAfterMessages: 20 },
    );

    const r = await s.generate(baseInput());

    expect(r).not.toBeNull();
    // fire-and-forget reject обрабатывается catch'ем — даём микротаску добежать
    await new Promise((res) => setTimeout(res, 0));
  });

  it("compaction: при превышении порога грузит/пересчитывает summary", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
    }));
    let savedSummary: string | null = null;
    const s = mk(
      ctxWith({
        chat: chatReturning("краткое резюме диалога"),
        kb: kbWith([HIT]),
        messages: fakeMessages({ recent: many, count: 21 }),
        conversations: {
          findById: async () => ({ id: 100, summaryJson: null }),
          setSummaryJson: async (_id: number, json: string) => {
            savedSummary = json;
          },
        } as never,
      }),
      { compactAfterMessages: 20 },
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    // summary пересчитан и сохранён (fire-and-forget) — даём микротаск завершиться
    await new Promise((res) => setTimeout(res, 0));
    expect(savedSummary).not.toBeNull();
  });
});

describe("parseStyleConfig", () => {
  it("валидный config → типизированный Style", () => {
    const parsed = parseStyleConfig(JSON.stringify(STYLE));
    expect(parsed?.slug).toBe("exch-pro");
    expect(parsed?.persona.name).toBe("Alex");
  });

  it("битый JSON → null", () => {
    expect(parseStyleConfig("{nope")).toBeNull();
  });

  it("валидный JSON, но не Style → null", () => {
    expect(parseStyleConfig('{"slug":1}')).toBeNull();
  });
});
