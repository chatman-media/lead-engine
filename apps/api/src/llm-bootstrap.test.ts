// Unit tests for llm-bootstrap factories. Проверяем что:
//   1. фабрики возвращают null когда нет matching config'ов
//   2. возвращают объект когда any tenant имеет нужный purpose
//   3. resolveChat/resolveEmbed работают для tenants с config'ами

import { describe, expect, it } from "bun:test";
import {
  LlmMemoryExtractor,
  LlmReplyStrategy,
  RagReplyStrategy,
} from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { LlmStageClassifier, RegexStageClassifier } from "@chatman-media/sales";
import type { ApiConfig } from "./config.ts";
import type { LoadedLlmConfigs } from "./lib/llm-config-loader.ts";
import {
  buildExchangePolicyState,
  type LoadedRef,
  makeEmbedderResolver,
  makeMemoryExtractor,
  makeReplyStrategy,
  makeStageClassifier,
  resolveTenantStyle,
} from "./llm-bootstrap.ts";

function refWith(opts: {
  chat?: { tenantIds: number[]; provider?: "openai" | "ollama"; model?: string };
  embed?: { tenantIds: number[]; provider?: "openai" | "ollama"; model?: string; dim?: number };
}): LoadedRef {
  return {
    current: buildLoaded(opts),
    router: new InMemoryLlmRouter(),
  };
}

function buildLoaded(opts: {
  chat?: { tenantIds: number[]; provider?: "openai" | "ollama"; model?: string };
  embed?: { tenantIds: number[]; provider?: "openai" | "ollama"; model?: string; dim?: number };
}): LoadedLlmConfigs {
  // biome-ignore lint/suspicious/noExplicitAny: test helper map
  const byTenant = new Map<number, Map<string, any>>();
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const setFor = (tenantId: number, purpose: string, cfg: any): void => {
    let m = byTenant.get(tenantId);
    if (!m) {
      m = new Map();
      byTenant.set(tenantId, m);
    }
    m.set(purpose, cfg);
  };
  if (opts.chat) {
    for (const tid of opts.chat.tenantIds) {
      setFor(tid, "chat", {
        provider: opts.chat.provider ?? "openai",
        model: opts.chat.model ?? "gpt-4o-mini",
        apiKey: opts.chat.provider === "ollama" ? undefined : "sk-test-chat",
        source: "db",
      });
    }
  }
  if (opts.embed) {
    for (const tid of opts.embed.tenantIds) {
      setFor(tid, "embed", {
        provider: opts.embed.provider ?? "openai",
        model: opts.embed.model ?? "text-embedding-3-small",
        apiKey: opts.embed.provider === "ollama" ? undefined : "sk-test-embed",
        embedDim: opts.embed.dim ?? 1536,
        source: "db",
      });
    }
  }
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    byTenant: byTenant as any,
    anyTenantHasChat: !!opts.chat && opts.chat.tenantIds.length > 0,
    anyTenantHasEmbed: !!opts.embed && opts.embed.tenantIds.length > 0,
  };
}

const FAKE_DB = {} as Parameters<typeof makeReplyStrategy>[2];
const FAKE_TEMPLATES = {
  fallbackTemplate: {
    slug: "test_v1",
    displayName: "Test",
    version: 1,
    funnelStages: [],
    systemPromptFragment: "",
  },
} satisfies Parameters<typeof makeReplyStrategy>[3];
const FAKE_CFG = {
  stageClassifier: "off",
  defaultStyleSlug: "",
  experimentSlug: "",
} as unknown as ApiConfig;

describe("makeReplyStrategy", () => {
  it("no chat config anywhere → null", () => {
    const loaded = refWith({});
    expect(makeReplyStrategy(loaded, FAKE_CFG, FAKE_DB, FAKE_TEMPLATES)).toBeNull();
  });

  it("chat only → LlmReplyStrategy", () => {
    const loaded = refWith({ chat: { tenantIds: [1] } });
    const bundle = makeReplyStrategy(loaded, FAKE_CFG, FAKE_DB, FAKE_TEMPLATES);
    expect(bundle).not.toBeNull();
    expect(bundle?.strategy instanceof LlmReplyStrategy).toBe(true);
  });

  it("chat + embed → RagReplyStrategy", () => {
    const loaded = refWith({
      chat: { tenantIds: [1] },
      embed: { tenantIds: [1] },
    });
    const bundle = makeReplyStrategy(loaded, FAKE_CFG, FAKE_DB, FAKE_TEMPLATES);
    expect(bundle?.strategy instanceof RagReplyStrategy).toBe(true);
  });

  it("multi-tenant: tenant 2 имеет chat, tenant 1 — embed → RagReplyStrategy", () => {
    const loaded = refWith({
      chat: { tenantIds: [2] },
      embed: { tenantIds: [1] },
    });
    expect(
      makeReplyStrategy(loaded, FAKE_CFG, FAKE_DB, FAKE_TEMPLATES)?.strategy instanceof
        RagReplyStrategy,
    ).toBe(true);
  });
});

describe("makeMemoryExtractor", () => {
  it("no chat → null", () => {
    expect(makeMemoryExtractor(refWith({}), FAKE_DB)).toBeNull();
  });
  it("chat → LlmMemoryExtractor", () => {
    const ext = makeMemoryExtractor(refWith({ chat: { tenantIds: [1] } }), FAKE_DB);
    expect(ext instanceof LlmMemoryExtractor).toBe(true);
  });
});

describe("makeStageClassifier", () => {
  it("cfg.stageClassifier=regex → RegexStageClassifier (no LLM needed)", () => {
    const cfg = { ...FAKE_CFG, stageClassifier: "regex" } as unknown as ApiConfig;
    const cls = makeStageClassifier(refWith({}), cfg, FAKE_DB);
    expect(cls instanceof RegexStageClassifier).toBe(true);
  });
  it("cfg.stageClassifier=llm + no chat → null", () => {
    const cfg = { ...FAKE_CFG, stageClassifier: "llm" } as unknown as ApiConfig;
    expect(makeStageClassifier(refWith({}), cfg, FAKE_DB)).toBeNull();
  });
  it("cfg.stageClassifier=llm + chat config → LlmStageClassifier", () => {
    const cfg = { ...FAKE_CFG, stageClassifier: "llm" } as unknown as ApiConfig;
    const cls = makeStageClassifier(refWith({ chat: { tenantIds: [1] } }), cfg, FAKE_DB);
    expect(cls instanceof LlmStageClassifier).toBe(true);
  });
  it("cfg.stageClassifier=off → null", () => {
    expect(
      makeStageClassifier(refWith({ chat: { tenantIds: [1] } }), FAKE_CFG, FAKE_DB),
    ).toBeNull();
  });
});

describe("makeEmbedderResolver", () => {
  it("no embed → null", () => {
    expect(makeEmbedderResolver(refWith({}))).toBeNull();
  });
  it("embed config → resolver function", () => {
    const r = makeEmbedderResolver(refWith({ embed: { tenantIds: [1] } }));
    expect(typeof r).toBe("function");
    if (!r) throw new Error("expected resolver");
    const client = r(1);
    expect(client).toBeDefined();
    expect(client.dim).toBe(1536);
  });
  it("embed for tenant 2 only → resolve(2) works, resolve(1) throws", () => {
    const r = makeEmbedderResolver(refWith({ embed: { tenantIds: [2] } }));
    if (!r) throw new Error("expected resolver");
    expect(() => r(1)).toThrow(/LLM config not set/);
    expect(r(2)).toBeDefined();
  });
});

describe("buildExchangePolicyState", () => {
  it("maps KYC and active payout order into deterministic guard state", () => {
    const state = buildExchangePolicyState({
      stageSlug: "payment_verified",
      verification: {
        verified: true,
        verificationId: "kyc-7",
        status: "verified",
        needsVerification: false,
      },
      order: {
        id: 7,
        status: "payout",
        direction: "sell_crypto",
        assetFrom: "USDT",
        network: "trc20",
        amountMode: "source_amount",
        requestedAmount: 100,
        amountFrom: 100,
        rate: 36.5,
        amountToThb: 3650,
        paymentMethod: "crypto_transfer",
        paymentRail: "trc20",
        sourceBank: null,
        payerName: null,
        thirdPartyApproved: false,
        payoutMethod: "office_cash",
        payoutLocation: "Bang Tao",
        payoutDestinationJson: null,
        payoutCode: "CODE-7",
        payoutCodeExpiresAt: null,
        requisitesJson: "{}",
        proofJson: '{"tx":"abc"}',
        verificationId: "kyc-7",
        rateExpiresAt: null,
        idempotencyKey: "idem-7",
        payoutPointId: null,
      },
    });

    expect(state.stageSlug).toBe("payment_verified");
    expect(state.verification).toEqual({
      verified: true,
      verificationId: "kyc-7",
      status: "verified",
      needsVerification: false,
    });
    expect(state.order).toMatchObject({
      id: 7,
      status: "payout",
      requisitesIssued: true,
      paymentProofReceived: true,
      paymentVerified: true,
      payoutReady: true,
      payoutCompleted: false,
      payoutCodeIssued: true,
      verificationId: "kyc-7",
    });
  });

  it("does not infer verification from awaiting_payment order", () => {
    const state = buildExchangePolicyState({
      stageSlug: "requisites_sent",
      verification: {
        verified: false,
        verificationId: null,
        status: "missing",
        needsVerification: true,
      },
      order: {
        id: 8,
        status: "awaiting_payment",
        direction: "sell_crypto",
        assetFrom: "USDT",
        network: "trc20",
        amountMode: "source_amount",
        requestedAmount: 100,
        amountFrom: 100,
        rate: 36.5,
        amountToThb: 3650,
        paymentMethod: "crypto_transfer",
        paymentRail: "trc20",
        sourceBank: null,
        payerName: null,
        thirdPartyApproved: false,
        payoutMethod: null,
        payoutLocation: null,
        payoutDestinationJson: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
        requisitesJson: "{}",
        proofJson: null,
        verificationId: null,
        rateExpiresAt: null,
        idempotencyKey: "idem-8",
        payoutPointId: null,
      },
    });

    expect(state.order).toMatchObject({
      requisitesIssued: true,
      paymentProofReceived: false,
      paymentVerified: false,
      payoutReady: false,
      payoutCompleted: false,
      payoutCodeIssued: false,
    });
    expect(state.verification?.needsVerification).toBe(true);
  });
});

// --- resolveTenantStyle (Phase 2 slice B): per-tenant style fallback ---

const styleJson = (slug: string): string =>
  JSON.stringify({
    slug,
    displayName: slug,
    persona: { name: "A", role: "human" },
    voice: { tone: "friendly", language: "ru", forbid: [] },
    framework: "SPIN",
    hooks: [],
    stages: { qualify: { goal: "g" } },
    fewShot: [],
    guardrails: { forbiddenTopics: [] },
    model: { id: "x", temperature: 0.5, maxTokens: 100 },
  });

function fakeStylesRepo(opts: {
  bySlug?: Record<string, string | null>;
  active?: Array<{ configJson: string; createdAt: number }>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal StylesRepo stub for the unit
}): any {
  return {
    findActiveBySlug: async (slug: string) => {
      const cj = opts.bySlug?.[slug];
      return cj ? { configJson: cj } : null;
    },
    listActive: async () => opts.active ?? [],
  };
}

describe("resolveTenantStyle", () => {
  it("default slug found → that style", async () => {
    const repo = fakeStylesRepo({
      bySlug: { def: styleJson("def") },
      active: [{ configJson: styleJson("other"), createdAt: 100 }],
    });
    expect((await resolveTenantStyle(repo, "def"))?.slug).toBe("def");
  });

  it("no default slug → most-recent active style", async () => {
    const repo = fakeStylesRepo({
      active: [
        { configJson: styleJson("old"), createdAt: 100 },
        { configJson: styleJson("new"), createdAt: 200 },
      ],
    });
    expect((await resolveTenantStyle(repo, ""))?.slug).toBe("new");
  });

  it("default slug set but unresolved → falls back to active", async () => {
    const repo = fakeStylesRepo({
      bySlug: { def: null },
      active: [{ configJson: styleJson("act"), createdAt: 5 }],
    });
    expect((await resolveTenantStyle(repo, "def"))?.slug).toBe("act");
  });

  it("no default + no active → null", async () => {
    expect(await resolveTenantStyle(fakeStylesRepo({ active: [] }), "")).toBeNull();
  });
});
