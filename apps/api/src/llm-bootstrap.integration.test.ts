/**
 * llm-bootstrap: standalone-резолверы. DB-резолверы (request-context /
 * awaiting-operator) — на изол-БД; resolveTenantStyle — фейк-repo;
 * makeSimChatResolver — InMemoryLlmRouter. Требует DATABASE_URL для DB-части;
 * без него те тесты graceful-skip.
 */
import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  directorHooks,
  exchangeOrders,
  funnels,
  leads,
  llmProviderConfigs,
  schema,
  skills,
  stageDefinitions,
  styles,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import {
  type LoadedRef,
  makeAwaitingOperatorResolver,
  makeDirectorHooksResolver,
  makeExchangePolicyStateResolver,
  makeRequestContextResolver,
  makeRerankerResolver,
  makeSimChatResolver,
  makeSkillsResolver,
  makeLeadFunnelResolver,
  makeStageGuidanceResolver,
  makeStyleResolver,
  makeToolsResolver,
  resolveTenantStyle,
} from "./llm-bootstrap.ts";

const MASTER_KEY = "0".repeat(64);

function validStyle(slug = "exch-pro") {
  return JSON.stringify({
    slug,
    displayName: "Обменник Про",
    persona: { name: "Алекс", role: "human", company: "Acme" },
    voice: { tone: "дружелюбный", language: "ru", forbid: [] },
    framework: "SPIN",
    hooks: [],
    stages: { qualify: { goal: "понять сумму", groundingRequired: false } },
    fewShot: [],
    guardrails: { noMinors: true, botDisclosureOnDirectQuestion: true, forbiddenTopics: [] },
    model: { id: "x", temperature: 0.5, maxTokens: 100 },
  });
}

const VALID_STYLE = validStyle();

describe("resolveTenantStyle (фейк-repo)", () => {
  it("default slug найден → парсит стиль", async () => {
    const repo = {
      findActiveBySlug: async () => ({ configJson: VALID_STYLE }) as never,
      listActive: async () => [],
    };
    const style = await resolveTenantStyle(repo as never, "exch-pro");
    expect(style?.slug).toBe("exch-pro");
  });

  it("нет default → fallback на самый свежий из listActive", async () => {
    const repo = {
      findActiveBySlug: async () => null,
      listActive: async () => [
        { configJson: VALID_STYLE, createdAt: 100 },
        { configJson: VALID_STYLE, createdAt: 200 },
      ],
    };
    const style = await resolveTenantStyle(repo as never, "");
    expect(style?.slug).toBe("exch-pro");
  });

  it("listActive пуст → null", async () => {
    const repo = { findActiveBySlug: async () => null, listActive: async () => [] };
    expect(await resolveTenantStyle(repo as never, "")).toBeNull();
  });

  it("битый configJson → null", async () => {
    const repo = {
      findActiveBySlug: async () => ({ configJson: "{broken" }) as never,
      listActive: async () => [],
    };
    expect(await resolveTenantStyle(repo as never, "exch-pro")).toBeNull();
  });
});

describe("makeSimChatResolver", () => {
  function refWithChat(tenantIds: number[]): LoadedRef {
    const byTenant = new Map<number, Map<string, unknown>>();
    for (const t of tenantIds) {
      byTenant.set(
        t,
        new Map([["chat", { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-x", source: "db" }]]),
      );
    }
    return {
      current: {
        byTenant,
        anyTenantHasChat: tenantIds.length > 0,
        anyTenantHasEmbed: false,
      },
      router: new InMemoryLlmRouter(),
    } as unknown as LoadedRef;
  }

  it("tenant с chat-config → ChatClient; без — null", () => {
    const resolver = makeSimChatResolver(refWithChat([1]));
    expect(resolver(1)).not.toBeNull();
    expect(resolver(2)).toBeNull();
  });
});

// ── DB-резолверы ─────────────────────────────────────────────────────────────
const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_llmboot_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");
let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantId = 0;
let opContactId = 0;
let exchContactId = 0;
let plainContactId = 0;
let policyContactId = 0;
let policyConversationId = 0;

async function stage(funnelId: number, slug: string, kind: string, stageType: string, pos: number) {
  const [s] = await db
    .insert(stageDefinitions)
    .values({
      tenantId,
      funnelId,
      slug,
      displayName: slug,
      kind,
      stageType,
      position: pos,
      nextStages: [],
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: stageDefinitions.id });
  return s!.id;
}

async function contactWithLead(stageId: number, requestType: string | null): Promise<number> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, displayName: `c-${Math.random().toString(36).slice(2, 8)}`, createdAt: n })
    .returning({ id: contacts.id });
  await db.insert(leads).values({
    tenantId,
    userId: c!.id,
    state: "x",
    stageDefinitionId: stageId,
    ...(requestType ? { requestType } : {}),
    createdAt: n,
    updatedAt: n,
  });
  return c!.id;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [t] = await db.insert(tenants).values({ slug: `llmboot-${n}` }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [f] = await db
    .insert(funnels)
    .values({ tenantId, slug: "main", isActive: true, createdAt: n, updatedAt: n })
    .returning({ id: funnels.id });
  const opStage = await stage(f!.id, "op", "active", "awaiting_operator", 1);
  const normStage = await stage(f!.id, "norm", "active", "form_fill", 2);
  const policyStage = await stage(f!.id, "payment_verified", "active", "payment", 3);
  opContactId = await contactWithLead(opStage, "exchange");
  exchContactId = await contactWithLead(normStage, "transfer");
  plainContactId = await contactWithLead(normStage, null);
  policyContactId = await contactWithLead(policyStage, "exchange");
  await db
    .update(contacts)
    .set({
      attributesJson: JSON.stringify({
        exchangeKyc: { status: "verified", verificationId: "kyc-policy" },
      }),
      updatedAt: n,
    })
    .where(eq(contacts.id, policyContactId));
  const [conversation] = await db
    .insert(conversations)
    .values({
      tenantId,
      userId: policyContactId,
      source: "bot",
      mode: "ai",
      status: "open",
      createdAt: n,
    })
    .returning({ id: conversations.id });
  policyConversationId = conversation!.id;
  await db.insert(exchangeOrders).values({
    tenantId,
    contactId: policyContactId,
    conversationId: policyConversationId,
    telegramId: "tg-policy",
    verificationId: "kyc-policy",
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
    payoutMethod: "office_cash",
    payoutLocation: "Bang Tao",
    status: "payout",
    requisitesJson: "{}",
    proofJson: "{\"tx\":\"abc\"}",
    payoutCode: "CODE-1",
    createdAt: n,
    updatedAt: n,
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
});

describe("makeRequestContextResolver", () => {
  it("лид с request_type → блок с лейблом", async () => {
    if (!enabled) return;
    const r = makeRequestContextResolver(db);
    const ctx = await r({ tenantId, contactId: exchContactId });
    expect(ctx).toContain("Трансфер");
  });

  it("лид без request_type → null", async () => {
    if (!enabled) return;
    const r = makeRequestContextResolver(db);
    expect(await r({ tenantId, contactId: plainContactId })).toBeNull();
  });
});

describe("makeAwaitingOperatorResolver", () => {
  it("открытый лид на awaiting_operator → true", async () => {
    if (!enabled) return;
    const r = makeAwaitingOperatorResolver(db);
    expect(await r({ tenantId, contactId: opContactId })).toBe(true);
  });

  it("обычная стадия → false", async () => {
    if (!enabled) return;
    const r = makeAwaitingOperatorResolver(db);
    expect(await r({ tenantId, contactId: plainContactId })).toBe(false);
  });
});

describe("makeLeadFunnelResolver / makeStageGuidanceResolver (мульти-воронка)", () => {
  it("берёт воронку и guidance самого свежего ОТКРЫТОГО лида (терминальные игнорируются)", async () => {
    if (!enabled) return;
    const [tf] = await db
      .insert(funnels)
      .values({ tenantId, slug: "transfer", isActive: true, createdAt: n, updatedAt: n })
      .returning({ id: funnels.id });
    const [openStage] = await db
      .insert(stageDefinitions)
      .values({
        tenantId,
        funnelId: tf!.id,
        slug: "transfer_request",
        displayName: "Заявка на трансфер",
        kind: "intake",
        stageType: "form_fill",
        position: 0,
        nextStages: [],
        goal: "Собрать маршрут",
        guidance: "Уточняй по одному",
        createdAt: n,
        updatedAt: n,
      })
      .returning({ id: stageDefinitions.id });
    const [termStage] = await db
      .insert(stageDefinitions)
      .values({
        tenantId,
        funnelId: tf!.id,
        slug: "transfer_lost",
        displayName: "Отменено",
        kind: "terminal_lost",
        stageType: "milestone",
        position: 1,
        nextStages: [],
        goal: "терминальный goal — не должен попадать в промпт",
        createdAt: n,
        updatedAt: n,
      })
      .returning({ id: stageDefinitions.id });

    const [c] = await db
      .insert(contacts)
      .values({ tenantId, displayName: "multi-funnel", createdAt: n })
      .returning({ id: contacts.id });
    // Старый ОТКРЫТЫЙ лид в transfer + более свежий ЗАКРЫТЫЙ — резолверы
    // должны выбрать открытый, несмотря на updatedAt.
    await db.insert(leads).values({
      tenantId,
      userId: c!.id,
      state: "x",
      stageDefinitionId: openStage!.id,
      createdAt: n - 100,
      updatedAt: n - 100,
    });
    await db.insert(leads).values({
      tenantId,
      userId: c!.id,
      state: "x",
      stageDefinitionId: termStage!.id,
      createdAt: n + 50,
      updatedAt: n + 50,
    });

    const funnelR = makeLeadFunnelResolver(db);
    expect((await funnelR({ tenantId, contactId: c!.id }))?.slug).toBe("transfer");
    const guidanceR = makeStageGuidanceResolver(db);
    const guidance = await guidanceR({ tenantId, contactId: c!.id });
    expect(guidance?.goal).toBe("Собрать маршрут");
    expect(guidance?.guidance).toBe("Уточняй по одному");
  });

  it("контакт без лидов → null (guard остаётся включённым)", async () => {
    if (!enabled) return;
    const [c] = await db
      .insert(contacts)
      .values({ tenantId, displayName: "no-leads", createdAt: n })
      .returning({ id: contacts.id });
    const funnelR = makeLeadFunnelResolver(db);
    expect(await funnelR({ tenantId, contactId: c!.id })).toBeNull();
  });
});

describe("makeExchangePolicyStateResolver", () => {
  it("собирает stage, KYC и active exchange order для guard", async () => {
    if (!enabled) return;
    const resolve = makeExchangePolicyStateResolver(db);
    const state = await resolve({
      tenantId,
      conversationId: policyConversationId,
      contactId: policyContactId,
    });

    expect(state.stageSlug).toBe("payment_verified");
    expect(state.verification).toEqual({
      verified: true,
      verificationId: "kyc-policy",
      status: "verified",
      needsVerification: false,
    });
    expect(state.order).toMatchObject({
      status: "payout",
      assetFrom: "USDT",
      network: "trc20",
      amountMode: "source_amount",
      requestedAmount: 100,
      amountFrom: 100,
      rate: 36.5,
      amountToThb: 3650,
      paymentMethod: "crypto_transfer",
      paymentRail: "trc20",
      payoutMethod: "office_cash",
      payoutLocation: "Bang Tao",
      requisitesIssued: true,
      paymentProofReceived: true,
      paymentVerified: true,
      payoutReady: true,
      payoutCompleted: false,
      payoutCodeIssued: true,
      verificationId: "kyc-policy",
    });
  });
});

describe("makeSkillsResolver", () => {
  it("возвращает только enabled, парсит applicableStagesJson, кеширует", async () => {
    if (!enabled) return;
    await db.insert(skills).values([
      {
        tenantId,
        slug: "mirror",
        family: "rapport",
        displayName: "Зеркало",
        description: "d",
        promptFragment: "отражай",
        applicableStagesJson: JSON.stringify(["qualify"]),
        intent: "rapport",
        isEnabled: true,
        createdAt: n,
        updatedAt: n,
      },
      {
        tenantId,
        slug: "off-skill",
        family: "x",
        displayName: "Выкл",
        description: "d",
        promptFragment: "p",
        applicableStagesJson: "[]",
        intent: "x",
        isEnabled: false,
        createdAt: n,
        updatedAt: n,
      },
    ]);
    const resolve = makeSkillsResolver(db);
    const r = await resolve({ tenantId });
    expect(r.map((s) => s.slug)).toEqual(["mirror"]);
    expect(r[0]!.applicableStages).toEqual(["qualify"]);
    // cache: повторный вызов отдаёт тот же массив
    expect(await resolve({ tenantId })).toBe(r);
  });
});

describe("makeDirectorHooksResolver", () => {
  it("только active, отсортированы по position", async () => {
    if (!enabled) return;
    await db.insert(directorHooks).values([
      { tenantId, name: "B", body: "b", position: 1, isActive: true, createdAt: n, updatedAt: n },
      { tenantId, name: "A", body: "a", position: 0, isActive: true, createdAt: n, updatedAt: n },
      { tenantId, name: "Off", body: "x", position: 2, isActive: false, createdAt: n, updatedAt: n },
    ]);
    const resolve = makeDirectorHooksResolver(db);
    const r = await resolve({ tenantId });
    expect(r.map((h) => h.name)).toEqual(["A", "B"]);
  });
});

describe("makeRerankerResolver", () => {
  it("нет config → null (кеш)", async () => {
    if (!enabled) return;
    const resolve = makeRerankerResolver(db, MASTER_KEY);
    expect(await resolve({ tenantId })).toBeNull();
    expect(await resolve({ tenantId })).toBeNull(); // из кеша
  });

  it("cohere config + secret → Reranker", async () => {
    if (!enabled) return;
    const [t] = await db.insert(tenants).values({ slug: `rr-${n}` }).returning({ id: tenants.id });
    await setEncryptedSecret({ db, tenantId: t!.id, key: "rr_key", value: "co-key", masterKeyHex: MASTER_KEY, nowEpoch: n });
    await db.insert(llmProviderConfigs).values({
      tenantId: t!.id,
      purpose: "reranker",
      provider: "cohere",
      model: "rerank-3",
      secretRef: "rr_key",
      createdAt: n,
      updatedAt: n,
    });
    const resolve = makeRerankerResolver(db, MASTER_KEY);
    expect(await resolve({ tenantId: t!.id })).not.toBeNull();
  });

  it("unsupported provider → null", async () => {
    if (!enabled) return;
    const [t] = await db.insert(tenants).values({ slug: `rr2-${n}` }).returning({ id: tenants.id });
    await setEncryptedSecret({ db, tenantId: t!.id, key: "rr_key", value: "k", masterKeyHex: MASTER_KEY, nowEpoch: n });
    await db.insert(llmProviderConfigs).values({
      tenantId: t!.id,
      purpose: "reranker",
      provider: "openai",
      model: "m",
      secretRef: "rr_key",
      createdAt: n,
      updatedAt: n,
    });
    const resolve = makeRerankerResolver(db, MASTER_KEY);
    expect(await resolve({ tenantId: t!.id })).toBeNull();
  });
});

describe("makeStyleResolver", () => {
  it("default slug → активный стиль тенанта", async () => {
    if (!enabled) return;
    const [t] = await db.insert(tenants).values({ slug: `st-${n}` }).returning({ id: tenants.id });
    const [styleRow] = await db
      .insert(styles)
      .values({
        tenantId: t!.id,
        slug: "exch-pro",
        displayName: "Pro",
        configJson: VALID_STYLE,
        isActive: true,
        version: 1,
        createdAt: n,
      })
      .returning({ id: styles.id });
    const { resolveStyle } = makeStyleResolver(db, { defaultSlug: "exch-pro", experimentSlug: "" });
    const style = await resolveStyle({ tenantId: t!.id, contactId: 1 });
    expect(style?.slug).toBe("exch-pro");
    expect(style?.styleId).toBe(styleRow?.id);
    expect(style?.experimentId).toBeNull();
  });

  it("running experiment → deterministic variant с styleId/experimentId", async () => {
    if (!enabled) return;
    const suffix = Math.random().toString(36).slice(2, 8);
    const [t] = await db.insert(tenants).values({ slug: `st-exp-${suffix}` }).returning({ id: tenants.id });
    const [styleA, styleB] = await db
      .insert(styles)
      .values([
        {
          tenantId: t!.id,
          slug: `exch-a-${suffix}`,
          displayName: "A",
          configJson: validStyle(`exch-a-${suffix}`),
          isActive: true,
          version: 1,
          createdAt: n,
        },
        {
          tenantId: t!.id,
          slug: `exch-b-${suffix}`,
          displayName: "B",
          configJson: validStyle(`exch-b-${suffix}`),
          isActive: true,
          version: 1,
          createdAt: n + 1,
        },
      ])
      .returning({ id: styles.id, slug: styles.slug });
    if (!styleA || !styleB) throw new Error("expected style variants");
    const [exp] = await db
      .insert(schema.experiments)
      .values({
        tenantId: t!.id,
        slug: `runtime-exp-${suffix}`,
        status: "running",
        allocationJson: JSON.stringify([
          { style_slug: styleA.slug, weight: 1 },
          { style_slug: styleB.slug, weight: 1 },
        ]),
        successMetric: "won",
        startedAt: n,
        createdAt: n,
      })
      .returning({ id: schema.experiments.id, slug: schema.experiments.slug });
    if (!exp) throw new Error("expected experiment row");
    const { resolveStyle } = makeStyleResolver(db, { defaultSlug: "", experimentSlug: exp.slug });

    const first = await resolveStyle({ tenantId: t!.id, contactId: 123 });
    const second = await resolveStyle({ tenantId: t!.id, contactId: 123 });

    if (!first || !second) throw new Error("expected experiment style assignment");
    if (first.styleId == null) throw new Error("expected experiment styleId assignment");
    expect(first.slug).toBe(second.slug);
    expect([styleA.slug, styleB.slug]).toContain(first.slug);
    expect([styleA.id, styleB.id]).toContain(first.styleId);
    expect(first.experimentId).toBe(exp.id);
    expect(first.experimentSlug).toBe(exp.slug);
    expect(first.variantSlug).toBe(first.slug);
  });

  it("нет стилей → null; invalidateStyle сбрасывает кеш", async () => {
    if (!enabled) return;
    const [t] = await db.insert(tenants).values({ slug: `st2-${n}` }).returning({ id: tenants.id });
    const { resolveStyle, invalidateStyle } = makeStyleResolver(db, {
      defaultSlug: "",
      experimentSlug: "",
    });
    expect(await resolveStyle({ tenantId: t!.id, contactId: 1 })).toBeNull();
    invalidateStyle(t!.id); // не бросает
    expect(await resolveStyle({ tenantId: t!.id, contactId: 1 })).toBeNull();
  });
});

describe("makeToolsResolver", () => {
  it("booking secret → booking-tool; без него → пусто; invalidate сбрасывает", async () => {
    if (!enabled) return;
    const [t] = await db.insert(tenants).values({ slug: `tools-${n}` }).returning({ id: tenants.id });
    const [tEmpty] = await db
      .insert(tenants)
      .values({ slug: `tools-empty-${n}` })
      .returning({ id: tenants.id });
    await setEncryptedSecret({
      db,
      tenantId: t!.id,
      key: "tool_booking_url",
      value: "https://book.me/x",
      masterKeyHex: MASTER_KEY,
      nowEpoch: n,
    });
    const { resolveTools, invalidateTools } = makeToolsResolver({ db, masterKeyHex: MASTER_KEY });
    const tools = await resolveTools({ tenantId: t!.id, conversationId: 1 });
    expect(tools.length).toBeGreaterThanOrEqual(1);
    // тенант без booking-секрета и без обмена/multi-request → пусто
    const none = await resolveTools({ tenantId: tEmpty!.id, conversationId: 1 });
    expect(none).toEqual([]);
    invalidateTools(t!.id); // не бросает
    expect((await resolveTools({ tenantId: t!.id, conversationId: 1 })).length).toBeGreaterThanOrEqual(1);
  });
});
