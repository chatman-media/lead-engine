/**
 * Гейт миграции «сбор данных обмена → универсальный движок»: проверяет, что
 * универсальный field-extractor РЕАЛЬНО заполняет leadFieldValues для exchange
 * и авто-двигает лида exchange_request → quote_calculated, а
 * readExchangeCollectedFields (#647) читает собранное в формате тулов.
 *
 * Без DATABASE_URL мягко скипается (как прочие *.integration.test.ts).
 */

import type { NotificationService } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { LoadedRef } from "../../llm-bootstrap.ts";
import { applyFunnelStages, SEED_TEMPLATES } from "../../routes/admin-funnel.ts";
import { makeAuthRoutes } from "../../routes/auth.ts";
import { makeFieldExtractor } from "../field-extractor.ts";
import { readExchangeCollectedFields } from "./tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exch_universal_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-exchange-universal-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;

function stubRef(response: string): LoadedRef {
  return {
    router: {
      resolveChat() {
        return { complete: async () => response };
      },
    },
  } as unknown as LoadedRef;
}

async function freshContactWithConversation(): Promise<{
  contactId: number;
  conversationId: number;
}> {
  const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
  const contactId = c!.id;
  const [conv] = await db
    .insert(conversations)
    .values({ tenantId, userId: contactId })
    .returning({ id: conversations.id });
  return { contactId, conversationId: conv!.id };
}

async function leadOf(contactId: number) {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)));
  return lead;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "exchange-universal@demo.io",
      password: "strong-pwd-12345",
    }),
  });
  const sba = (await sa.json()) as { admin: { tenantId: number } };
  tenantId = sba.admin.tenantId;

  await applyFunnelStages(db as never, tenantId, SEED_TEMPLATES.exchange!, "exchange");
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("exchange: универсальный сбор данных + авто-переход", () => {
  it("USDT: asset_from+amount_from → лид авто-уходит на quote_calculated, поля читаются", async () => {
    if (!sql) return;
    const { contactId, conversationId } = await freshContactWithConversation();
    const extractor = makeFieldExtractor(
      stubRef('{"asset_from":"usdt","amount_from":2000,"network":"trc20","payout_method":"atm"}'),
    );

    await extractor.extract({
      tenantId,
      contactId,
      text: "хочу обменять 2000 usdt trc20, выдача в банкомате",
      db,
    });

    // Авто-переход по all_required_fields_filled (asset_from + amount_from).
    const lead = await leadOf(contactId);
    expect(lead?.state).toBe("quote_calculated");

    // Тулы видят собранное в своём формате.
    const collected = await readExchangeCollectedFields(db as never, tenantId, conversationId);
    expect(collected).toEqual({
      asset: "usdt",
      amount: 2000,
      network: "trc20",
      payoutMethod: "atm",
    });
  });

  it("RUB: payment_method собирается универсально (sbp_qr/card)", async () => {
    if (!sql) return;
    const { contactId, conversationId } = await freshContactWithConversation();
    const extractor = makeFieldExtractor(
      stubRef(
        '{"asset_from":"rub","amount_from":20000,"payout_method":"atm","payment_method":"card_transfer"}',
      ),
    );

    await extractor.extract({
      tenantId,
      contactId,
      text: "меняю 20000 рублей, выдача в банкомате, внесу переводом со счёта",
      db,
    });

    const lead = await leadOf(contactId);
    expect(lead?.state).toBe("quote_calculated");

    const collected = await readExchangeCollectedFields(db as never, tenantId, conversationId);
    expect(collected.asset).toBe("rub");
    expect(collected.amount).toBe(20000);
    expect(collected.paymentMethod).toBe("card_transfer");
    expect(collected.payoutMethod).toBe("atm");
  });

  it("мультитёрн: сеть/выдача, названные ПОСЛЕ авто-перехода, всё равно собираются", async () => {
    if (!sql) return;
    const { contactId, conversationId } = await freshContactWithConversation();

    // Ход 1: asset+amount → авто-переход на quote_calculated.
    await makeFieldExtractor(stubRef('{"asset_from":"usdt","amount_from":2000}')).extract({
      tenantId,
      contactId,
      text: "хочу обменять 2000 usdt",
      db,
    });
    expect((await leadOf(contactId))?.state).toBe("quote_calculated");

    // Ход 2: клиент называет сеть и выдачу УЖЕ на quote_calculated — поля
    // продублированы на эту стадию, поэтому экстрактор их соберёт.
    await makeFieldExtractor(stubRef('{"network":"trc20","payout_method":"atm"}')).extract({
      tenantId,
      contactId,
      text: "trc20, выдача в банкомате",
      db,
    });

    const collected = await readExchangeCollectedFields(db as never, tenantId, conversationId);
    expect(collected.asset).toBe("usdt");
    expect(collected.amount).toBe(2000);
    expect(collected.network).toBe("trc20");
    expect(collected.payoutMethod).toBe("atm");
  });

  it("re-quote: смена сделки на quote_calculated обновляет asset/amount (не старое)", async () => {
    if (!sql) return;
    const { contactId, conversationId } = await freshContactWithConversation();

    // Ход 1: RUB 20000 → авто-переход на quote_calculated.
    await makeFieldExtractor(
      stubRef('{"asset_from":"rub","amount_from":20000,"payout_method":"office"}'),
    ).extract({ tenantId, contactId, text: "хочу 20000 рублей", db });
    expect((await leadOf(contactId))?.state).toBe("quote_calculated");

    // Ход 2: клиент ПЕРЕДУМАЛ уже на quote_calculated — 500 USDT. asset_from/
    // amount_from продублированы на эту стадию → re-extract обновляет сделку.
    await makeFieldExtractor(
      stubRef('{"asset_from":"usdt","amount_from":500,"network":"trc20"}'),
    ).extract({ tenantId, contactId, text: "передумал, 500 usdt", db });

    const collected = await readExchangeCollectedFields(db as never, tenantId, conversationId);
    // Должна быть НОВАЯ сделка (USDT 500), а не старая (RUB 20000).
    expect(collected.asset).toBe("usdt");
    expect(collected.amount).toBe(500);
    expect(collected.network).toBe("trc20");
  });
});
