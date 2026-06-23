import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  exchangeOrders,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { cancelOpenExchangeOrders, findActiveOrder } from "./orders.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchange_cancel_${Math.random().toString(36).slice(2, 10)}`;
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

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let tenantId = 0;
let suffix = 0;

async function createConversationFixture(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  suffix += 1;
  return withTenant(db, tenantId, async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        tenantId,
        kind: "telegram_bot",
        externalId: `exchange-cancel-${suffix}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        displayName: `Cancel Client ${suffix}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: contacts.id });
    const [conversation] = await tx
      .insert(conversations)
      .values({
        tenantId,
        userId: contact!.id,
        source: "bot",
        mode: "ai",
        createdAt: now,
        lastMessageAt: now,
      })
      .returning({ id: conversations.id });
    await tx.insert(channelIdentities).values({
      contactId: contact!.id,
      channelId: channel!.id,
      externalUserId: `cancel-client-${suffix}`,
      createdAt: now,
    });
    return conversation!.id;
  });
}

async function insertOrder(
  conversationId: number,
  status: string,
  opts?: { proofJson?: string },
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  suffix += 1;
  return withTenant(db, tenantId, async (tx) => {
    const [order] = await tx
      .insert(exchangeOrders)
      .values({
        tenantId,
        conversationId,
        direction: "RUB->PHP",
        assetFrom: "RUB",
        network: "",
        amountMode: "source_amount",
        requestedAmount: 20_000,
        amountFrom: 20_000,
        rate: 0.8,
        amountToThb: 16_000,
        status,
        proofJson: opts?.proofJson ?? null,
        idempotencyKey: `cancel-${conversationId}-${status}-${now}-${suffix}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: exchangeOrders.id });
    return order!.id;
  });
}

async function statusAndKey(orderId: number): Promise<{ status: string; key: string | null }> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: exchangeOrders.status, key: exchangeOrders.idempotencyKey })
      .from(exchangeOrders)
      .where(eq(exchangeOrders.id, orderId))
      .limit(1);
    return { status: row!.status as string, key: (row!.key as string | null) ?? null };
  });
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});

  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 3,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: `exchange-cancel-${Date.now()}` })
    .returning({ id: tenants.id });
  tenantId = tenant!.id;
  enabled = true;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
  sql = null;
});

describe("cancelOpenExchangeOrders", () => {
  it("отменяет до-оплатные заявки (quote/awaiting_payment) и освобождает idempotency_key", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    const quoteId = await insertOrder(conversationId, "quote");
    const awaitingId = await insertOrder(conversationId, "awaiting_payment");

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId);

    expect(result.cancelled.sort()).toEqual([quoteId, awaitingId].sort());
    expect(result.blockedByPayment).toEqual([]);
    expect(await statusAndKey(quoteId)).toEqual({ status: "cancelled", key: null });
    expect(await statusAndKey(awaitingId)).toEqual({ status: "cancelled", key: null });
    // Активной заявки больше нет.
    await expect(findActiveOrder(db, tenantId, conversationId)).resolves.toBeNull();
  });

  it("НЕ трогает заявки с поступившей оплатой (paid/payout) — деньги в движении", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    const paidId = await insertOrder(conversationId, "paid");
    const payoutId = await insertOrder(conversationId, "payout");

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId);

    expect(result.cancelled).toEqual([]);
    expect(result.blockedByPayment.sort()).toEqual([paidId, payoutId].sort());
    expect((await statusAndKey(paidId)).status).toBe("paid");
    expect((await statusAndKey(payoutId)).status).toBe("payout");
  });

  it("НЕ трогает awaiting_payment с присланным чеком (proofJson)", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    const withProof = await insertOrder(conversationId, "awaiting_payment", {
      proofJson: JSON.stringify({ txHash: "0xabc", verifiedOk: true }),
    });

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId);

    expect(result.cancelled).toEqual([]);
    expect(result.blockedByPayment).toEqual([withProof]);
    expect((await statusAndKey(withProof)).status).toBe("awaiting_payment");
  });

  it("отменяет невалидный чек (verifiedOk=false), но щадит валидный", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    const rejected = await insertOrder(conversationId, "awaiting_payment", {
      proofJson: JSON.stringify({ txHash: "0xbad", verifiedOk: false }),
    });

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId);

    expect(result.cancelled).toEqual([rejected]);
    expect(result.blockedByPayment).toEqual([]);
  });

  it("пропускает exceptOrderId (идемпотентно переиспользуемую заявку)", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    const keepId = await insertOrder(conversationId, "awaiting_payment");
    const otherId = await insertOrder(conversationId, "quote");

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId, {
      exceptOrderId: keepId,
    });

    expect(result.cancelled).toEqual([otherId]);
    expect((await statusAndKey(keepId)).status).toBe("awaiting_payment");
  });

  it("нет открытых заявок → пустой результат", async () => {
    if (!enabled) return;
    const conversationId = await createConversationFixture();
    await insertOrder(conversationId, "completed");
    await insertOrder(conversationId, "cancelled");

    const result = await cancelOpenExchangeOrders(db, tenantId, conversationId);

    expect(result).toEqual({ cancelled: [], blockedByPayment: [] });
  });
});
