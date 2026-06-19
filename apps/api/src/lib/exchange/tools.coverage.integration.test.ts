/**
 * Доп. покрытие веток exchange-lib, не задетых workflow-сценариями:
 *   - tools: stage-policy wrapper, guard-trip при создании заявки, идемпотентный
 *     повтор, операторские ветки реквизитов/выдачи, westwallet-verify, пустой
 *     business-info, hasActiveExchangeRates;
 *   - providers: verifyWestWalletInvoicePayment (все статусы);
 *   - orders: getOrderById + конфликт createOrderIdempotent;
 *   - rates: валидация computeQuote (сумма/лимиты/нет курса/network-fallback).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  exchangeRates,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { createOrderIdempotent, getOrderById, updateOrder } from "./orders.ts";
import { verifyWestWalletInvoicePayment } from "./providers.ts";
import { computeQuote } from "./rates.ts";
import { hasActiveExchangeRates, makeExchangeTools, type RateGuardAlert } from "./tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exch_tools_coverage_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;

type ToolMap = Record<
  string,
  {
    description: string;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }
>;

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let channelId = 0;
let now = 0;

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

async function makeConversation(id: string): Promise<{
  contactId: number;
  conversationId: number;
}> {
  const ts = Math.floor(Date.now() / 1000);
  return withTenant(db, tenantId, async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        displayName: `Coverage ${id}`,
        attributesJson: JSON.stringify({
          exchangeKyc: { status: "verified", verificationId: `kyc-${id}` },
        }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: contacts.id });
    const contactId = must(contact, "contact").id;
    const [conversation] = await tx
      .insert(conversations)
      .values({
        tenantId,
        userId: contactId,
        source: "bot",
        mode: "ai",
        createdAt: ts,
        lastMessageAt: ts,
      })
      .returning({ id: conversations.id });
    const conversationId = must(conversation, "conversation").id;
    await tx.insert(channelIdentities).values({
      contactId,
      channelId,
      externalUserId: `tg-cov-${id}`,
      createdAt: ts,
    });
    return { contactId, conversationId };
  });
}

function toTools(
  conversationId: number,
  extra: { stageSlug?: string; notifyRateGuard?: (a: RateGuardAlert) => void } = {},
): ToolMap {
  return Object.fromEntries(
    makeExchangeTools({
      db,
      tenantId,
      conversationId,
      masterKeyHex: MASTER_KEY,
      ...extra,
    }).map((tool) => [tool.name, tool]),
  ) as unknown as ToolMap;
}

/** Мок WestWallet invoice_transactions: отдаёт заданный список транзакций. */
function mockWestWalletTransactions(result: Array<Record<string, unknown>>): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    expect(url).toContain("westwallet.io");
    expect(url).toContain("invoice_transactions");
    return new Response(JSON.stringify({ error: "ok", count: result.length, result }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

async function setSecret(key: string, value: string): Promise<void> {
  await setEncryptedSecret({
    db,
    tenantId,
    key,
    value,
    masterKeyHex: MASTER_KEY,
    nowEpoch: Math.floor(Date.now() / 1000),
  });
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  now = Math.floor(Date.now() / 1000);
  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `exch-cov-${now}` })
    .returning({ id: schema.tenants.id });
  tenantId = must(tenant, "tenant").id;
  await withTenant(db, tenantId, async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        tenantId,
        kind: "telegram_bot",
        externalId: "mock-tg-cov",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    channelId = must(channel, "channel").id;
  });

  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(exchangeRates).values([
      {
        tenantId,
        asset: "USDT",
        quoteAsset: "THB",
        network: "trc20",
        baseRate: 31.5,
        quoteMode: "multiply",
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId,
        asset: "USDT",
        quoteAsset: "THB",
        network: "erc20",
        baseRate: 31.4,
        quoteMode: "multiply",
        createdAt: now,
        updatedAt: now,
      },
      {
        // guard-trip: eff = base*(1-50/100) → отклонение −50% > порога 35%
        tenantId,
        asset: "ETH",
        quoteAsset: "THB",
        network: "erc20",
        baseRate: 100_000,
        quoteMode: "multiply",
        marginPct: 50,
        createdAt: now,
        updatedAt: now,
      },
      {
        // кошелёк НЕ настроен → реквизиты выдаёт оператор
        tenantId,
        asset: "BTC",
        quoteAsset: "THB",
        network: "",
        baseRate: 2_000_000,
        quoteMode: "multiply",
        createdAt: now,
        updatedAt: now,
      },
      {
        // network='' при дефолтной сети tron → network-fallback; лимиты min/max
        tenantId,
        asset: "TRX",
        quoteAsset: "THB",
        network: "",
        baseRate: 1,
        quoteMode: "multiply",
        minAmountFrom: 100,
        maxAmountFrom: 1000,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });
  await setSecret("exchange_wallet_usdt_trc20", "TCoverageWallet1111111111111111111111");
  await setSecret("exchange_wallet_usdt_erc20", "0xCoverageWallet2222222222222222222222");
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("exchange tools — stage policy wrapper", () => {
  it("denies a tool outside its stage and passes allowed tools through", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("stage-policy");
    const tools = toTools(conversationId, { stageSlug: "exchange_request" });

    expect(tools.compute_exchange_quote?.description).toContain(
      "Текущая стадия exchange: exchange_request",
    );
    // Policy-блок дедуплицирован: он только на первом инструменте, не во всех ~8.
    expect(tools.get_exchange_business_info?.description).not.toContain("Текущая стадия exchange");
    expect(tools.create_exchange_order?.description).not.toContain("Текущая стадия exchange");

    const denied = (await must(tools.issue_exchange_payout, "issue_exchange_payout").execute({
      payoutMethod: "office_cash",
      location: "офис",
    })) as Record<string, unknown>;
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("action_not_allowed_for_stage");
    expect(denied.allowedTools).toContain("compute_exchange_quote");
    expect(denied.allowedTools).toContain("get_exchange_business_info");

    const quote = (await must(tools.compute_exchange_quote, "compute_exchange_quote").execute({
      asset: "USDT",
      amount: 100,
      network: "trc20",
    })) as Record<string, unknown>;
    expect(quote.amountToThb).toBeGreaterThan(0);
  });
});

describe("exchange tools — create order branches", () => {
  it("rate-guard trip blocks order creation and alerts the owner", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("create-guard");
    const alerts: RateGuardAlert[] = [];
    const tools = toTools(conversationId, {
      notifyRateGuard: (alert) => alerts.push(alert),
    });
    const res = (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "ETH",
      amount: 1,
      network: "erc20",
    })) as Record<string, unknown>;
    expect(String(res.error)).toContain("Некорректный курс");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]?.asset).toBe("ETH");
    expect(alerts[0]?.network).toBe("erc20");
  });

  it("repeat create with same args returns existing order (idempotent) and keeps payer fields", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("idempotent");
    const tools = toTools(conversationId);
    const args = {
      asset: "USDT",
      amount: 100,
      network: "trc20",
      paymentMethod: "crypto_transfer",
      payerName: "Иван Тест",
      thirdPartyApproved: true,
    };
    const first = (await must(tools.create_exchange_order, "create_exchange_order").execute(
      args,
    )) as Record<string, unknown>;
    expect(first.status).toBe("awaiting_payment");

    const second = (await must(tools.create_exchange_order, "create_exchange_order").execute(
      args,
    )) as Record<string, unknown>;
    expect(second.idempotent).toBe(true);
    expect(second.orderId).toBe(first.orderId);

    const row = await getOrderById(db, tenantId, first.orderId as number);
    expect(row?.payerName).toBe("Иван Тест");
    expect(row?.thirdPartyApproved).toBe(true);
    expect(await getOrderById(db, tenantId, 99_999_999)).toBeNull();
  });
});

describe("orders DAL — createOrderIdempotent conflict path", () => {
  it("insert conflict by idempotencyKey returns the existing row", async () => {
    if (!sql) return;
    const { conversationId, contactId } = await makeConversation("dal-conflict");
    const input = {
      conversationId,
      contactId,
      telegramId: null,
      direction: "USDT->THB",
      assetFrom: "USDT",
      network: "trc20",
      amountFrom: 50,
      rate: 31.5,
      amountToThb: 1575,
      rateExpiresAt: Math.floor(Date.now() / 1000) + 900,
      idempotencyKey: `cov-conflict-${conversationId}`,
    };
    const created = await createOrderIdempotent(db, tenantId, input);
    const repeated = await createOrderIdempotent(db, tenantId, input);
    expect(repeated.id).toBe(created.id);
    expect(repeated.status).toBe("awaiting_payment");
    expect(repeated.amountFrom).toBe(50);
  });
});

describe("exchange tools — requisites and payout operator branches", () => {
  it("unconfigured wallet → requisites needsOperator", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("btc-no-wallet");
    const tools = toTools(conversationId);
    const created = (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "BTC",
      amount: 0.01,
    })) as Record<string, unknown>;
    expect(created.status).toBe("awaiting_payment");

    const req = (await must(tools.fetch_exchange_requisites, "fetch_exchange_requisites").execute(
      {},
    )) as Record<string, unknown>;
    expect(req.needsOperator).toBe(true);
    expect(String(req.note)).toContain("оператор");
  });

  it("payout before paid → error; paid without code → needsOperator", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("payout-branches");
    const tools = toTools(conversationId);
    const created = (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "USDT",
      amount: 200,
      network: "trc20",
    })) as Record<string, unknown>;
    const orderId = created.orderId as number;

    const early = (await must(tools.issue_exchange_payout, "issue_exchange_payout").execute({
      payoutMethod: "office_cash",
      location: "офис",
    })) as Record<string, unknown>;
    expect(String(early.error)).toContain("Оплата ещё не подтверждена");

    await updateOrder(db, tenantId, orderId, { status: "paid" });
    const pendingCode = (await must(tools.issue_exchange_payout, "issue_exchange_payout").execute({
      payoutMethod: "cardless_atm",
      location: "KBank ATM",
      destination: { atmBank: "KBank" },
    })) as Record<string, unknown>;
    expect(pendingCode.needsOperator).toBe(true);
    expect(pendingCode.codeExpired).toBeUndefined();
    expect(String(pendingCode.note)).toContain("Код получения готовит оператор");

    const row = await getOrderById(db, tenantId, orderId);
    expect(row?.status).toBe("payout");
    expect(row?.payoutMethod).toBe("cardless_atm");
  });
});

describe("exchange tools — crypto payment verification branches", () => {
  it("crypto proof without tx hash → asks for hash; broken requisites json → operator", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("verify-misc");
    const tools = toTools(conversationId);
    const created = (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "USDT",
      amount: 75,
      network: "trc20",
    })) as Record<string, unknown>;
    const orderId = created.orderId as number;

    const noHash = (await must(tools.verify_exchange_payment, "verify_exchange_payment").execute({
      proof: "перевёл, чек пришлю позже",
    })) as Record<string, unknown>;
    expect(noHash.ok).toBe(false);
    expect(String(noHash.error)).toContain("tx hash");

    await updateOrder(db, tenantId, orderId, { requisitesJson: "{broken json" });
    const noAddress = (await must(tools.verify_exchange_payment, "verify_exchange_payment").execute(
      { proof: "a".repeat(64) },
    )) as Record<string, unknown>;
    expect(noAddress.ok).toBe(false);
    expect(noAddress.needsOperator).toBe(true);
    expect(String(noAddress.note)).toContain("Адрес кошелька не зафиксирован");
  });

  it("non-TRC20 network → auto-check unavailable, operator takes over", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("verify-erc20");
    const tools = toTools(conversationId);
    (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "USDT",
      amount: 90,
      network: "erc20",
    })) as Record<string, unknown>;
    const req = (await must(tools.fetch_exchange_requisites, "fetch_exchange_requisites").execute(
      {},
    )) as Record<string, unknown>;
    expect(req.kind).toBe("crypto");
    expect(req.address).toBe("0xCoverageWallet2222222222222222222222");

    const res = (await must(tools.verify_exchange_payment, "verify_exchange_payment").execute({
      proof: "b".repeat(64),
    })) as Record<string, unknown>;
    expect(res.ok).toBe(false);
    expect(res.needsOperator).toBe(true);
    expect(String(res.note)).toContain("ERC20");
  });
});

describe("exchange tools — business info and rates gate", () => {
  it("no business secrets configured → explicit operator note", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("biz-empty");
    const tools = toTools(conversationId);
    const info = (await must(
      tools.get_exchange_business_info,
      "get_exchange_business_info",
    ).execute({})) as Record<string, unknown>;
    expect(String(info.note)).toContain("не заданы оператором");
  });

  it("hasActiveExchangeRates: true for seeded tenant, false for bare tenant", async () => {
    if (!sql) return;
    expect(await hasActiveExchangeRates(db, tenantId)).toBe(true);
    const [bare] = await db
      .insert(schema.tenants)
      .values({ slug: `exch-cov-bare-${now}` })
      .returning({ id: schema.tenants.id });
    expect(await hasActiveExchangeRates(db, must(bare, "bare tenant").id)).toBe(false);
  });
});

describe("computeQuote — validation branches", () => {
  it("rejects non-positive amounts, unknown rates and min/max limits", async () => {
    if (!sql) return;
    const zero = await computeQuote(db, tenantId, { asset: "USDT", amount: 0 });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toContain("положительным числом");

    const missing = await computeQuote(db, tenantId, { asset: "LTC", amount: 1 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      // Отказ больше не тупик: несёт реальные доступные направления.
      expect(missing.error).toContain("не обслуживается");
      expect(missing.availableDirections?.length ?? 0).toBeGreaterThan(0);
    }

    const belowMin = await computeQuote(db, tenantId, { asset: "TRX", amount: 50 });
    expect(belowMin.ok).toBe(false);
    if (!belowMin.ok) expect(belowMin.error).toContain("Минимальная сумма");

    const aboveMax = await computeQuote(db, tenantId, { asset: "TRX", amount: 5000 });
    expect(aboveMax.ok).toBe(false);
    if (!aboveMax.ok) expect(aboveMax.error).toContain("Максимальная сумма");
  });

  it("target_thb conversion respects minAmountFrom; network falls back to ''", async () => {
    if (!sql) return;
    // target 50 THB при eff=1 → amountFrom=50 < min 100
    const tooSmall = await computeQuote(db, tenantId, {
      asset: "TRX",
      amount: 50,
      amountMode: "target_thb",
    });
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.error).toContain("Минимальная сумма");

    // сеть tron (дефолт TRX) точной строки не имеет → fallback на network=''
    const ok = await computeQuote(db, tenantId, { asset: "TRX", amount: 500 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.network).toBe("TRON");
      expect(ok.amountToThb).toBe(500);
    }
  });
});

// WestWallet-тесты идут последними: включённые API-ключи меняют выбор провайдера
// реквизитов для крипты; после тестов ключи затираются пустыми значениями.
describe("westwallet invoice verification", () => {
  it("invoice requisites without keys → operator; with keys and completed tx → paid", async () => {
    if (!sql) return;
    const { conversationId } = await makeConversation("ww-invoice");
    const tools = toTools(conversationId);
    const created = (await must(tools.create_exchange_order, "create_exchange_order").execute({
      asset: "USDT",
      amount: 120,
      network: "trc20",
    })) as Record<string, unknown>;
    const orderId = created.orderId as number;
    await updateOrder(db, tenantId, orderId, {
      requisitesJson: JSON.stringify({
        provider: "westwallet",
        invoiceToken: "tok-cov-1",
      }),
    });

    // Ключи не настроены → проверит оператор.
    const noKeys = (await must(tools.verify_exchange_payment, "verify_exchange_payment").execute(
      {},
    )) as Record<string, unknown>;
    expect(noKeys.ok).toBe(false);
    expect(noKeys.needsOperator).toBe(true);
    expect(String(noKeys.note)).toContain("ключи не настроены");

    try {
      await setSecret("exchange_westwallet_api_key", "cov-api-key");
      await setSecret("exchange_westwallet_secret_key", "cov-secret-key");

      mockWestWalletTransactions([
        {
          id: 1,
          amount: "120",
          address: "TInvoiceAddr",
          currency: "USDTTRC",
          status: "completed",
          type: "receive",
        },
      ]);
      const paid = (await must(tools.verify_exchange_payment, "verify_exchange_payment").execute(
        {},
      )) as Record<string, unknown>;
      expect(paid.ok).toBe(true);
      expect(String(paid.note)).toContain("подтвердил входящий платёж");

      const row = await getOrderById(db, tenantId, orderId);
      expect(row?.status).toBe("paid");
      expect(row?.proofJson).toContain("westwallet_invoice");
    } finally {
      await setSecret("exchange_westwallet_api_key", "");
      await setSecret("exchange_westwallet_secret_key", "");
    }
  });

  it("verifyWestWalletInvoicePayment: not found / pending / insufficient / NaN amount", async () => {
    if (!sql) return;
    try {
      await setSecret("exchange_westwallet_api_key", "cov-api-key");
      await setSecret("exchange_westwallet_secret_key", "cov-secret-key");
      const opts = {
        db,
        tenantId,
        masterKeyHex: MASTER_KEY,
        token: "tok-cov-2",
        expectedAmount: 120,
      };

      mockWestWalletTransactions([]);
      const notFound = await verifyWestWalletInvoicePayment(opts);
      expect(notFound.ok).toBe(false);
      expect(notFound.transaction).toBeNull();
      expect(String(notFound.note)).toContain("пока не найден");

      mockWestWalletTransactions([
        {
          id: 2,
          amount: "120",
          address: "T",
          currency: "USDTTRC",
          status: "pending",
          type: "receive",
        },
      ]);
      const pending = await verifyWestWalletInvoicePayment(opts);
      expect(pending.ok).toBe(false);
      expect(String(pending.note)).toContain("Ждём подтверждения");

      mockWestWalletTransactions([
        {
          id: 3,
          amount: "50",
          address: "T",
          currency: "USDTTRC",
          status: "completed",
          type: "receive",
        },
      ]);
      const underpaid = await verifyWestWalletInvoicePayment(opts);
      expect(underpaid.ok).toBe(false);
      expect(underpaid.needsOperator).toBe(true);
      expect(String(underpaid.note)).toContain("ожидалось 120");

      // type!=receive → берётся result[0]; amount не число → оператор
      mockWestWalletTransactions([
        {
          id: 4,
          amount: "not-a-number",
          address: "T",
          currency: "USDTTRC",
          status: "completed",
          type: "send",
        },
      ]);
      const nanAmount = await verifyWestWalletInvoicePayment(opts);
      expect(nanAmount.ok).toBe(false);
      expect(nanAmount.needsOperator).toBe(true);
    } finally {
      await setSecret("exchange_westwallet_api_key", "");
      await setSecret("exchange_westwallet_secret_key", "");
    }
  });
});
