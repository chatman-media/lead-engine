import { type Db } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  contacts,
  createIsolatedDb,
  funnels,
  leadEvents,
  leadNotes,
  leads,
  partners,
  partnerServices,
  schema,
  serviceCatalogItems,
  stageDefinitions,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { applyFunnelStages, SEED_TEMPLATES } from "../routes/admin-funnel.ts";
import { makeAuthRoutes } from "../routes/auth.ts";
import { makeFieldExtractor } from "./field-extractor.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_catalog_route_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const SECRET = "test-secret-service-catalog-routing";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let exchangeFunnelId = 0;
let realEstateFunnelId = 0;

function stubRef(response = "{}"): LoadedRef {
  return {
    router: {
      resolveChat() {
        return { complete: async () => response };
      },
    },
  } as unknown as LoadedRef;
}

async function freshContact(): Promise<number> {
  const [row] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
  return row!.id;
}

async function latestLead(contactId: number) {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)))
    .orderBy(desc(leads.updatedAt), desc(leads.id))
    .limit(1);
  return row;
}

async function allLeads(contactId: number) {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)))
    .orderBy(desc(leads.updatedAt), desc(leads.id));
}

async function firstStageId(funnelId: number): Promise<number> {
  const [row] = await db
    .select({ id: stageDefinitions.id })
    .from(stageDefinitions)
    .where(and(eq(stageDefinitions.tenantId, tenantId), eq(stageDefinitions.funnelId, funnelId)))
    .orderBy(stageDefinitions.position)
    .limit(1);
  return row!.id;
}

async function routeNotes(leadId: number) {
  const [event] = await db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.tenantId, tenantId), eq(leadEvents.leadId, leadId)))
    .orderBy(desc(leadEvents.id))
    .limit(1);
  const [note] = await db
    .select()
    .from(leadNotes)
    .where(and(eq(leadNotes.tenantId, tenantId), eq(leadNotes.leadId, leadId)))
    .orderBy(desc(leadNotes.id))
    .limit(1);
  return { event, note };
}

async function insertCatalogItem(input: {
  slug: string;
  name: string;
  routeType: "manual" | "funnel" | "partner_service" | "webhook";
  funnelId?: number | null;
  partnerServiceId?: number | null;
  webhookUrl?: string | null;
  sortOrder?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const [row] = await db
    .insert(serviceCatalogItems)
    .values({
      tenantId,
      slug: input.slug,
      name: input.name,
      routeType: input.routeType,
      funnelId: input.funnelId ?? null,
      partnerServiceId: input.partnerServiceId ?? null,
      webhookUrl: input.webhookUrl ?? null,
      sortOrder: input.sortOrder ?? 0,
      metadataJson: "{}",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: serviceCatalogItems.id });
  return row!.id;
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
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "catalog-route@demo.io", password: "strong-pwd-12345" }),
  });
  const body = (await res.json()) as { admin: { tenantId: number } };
  tenantId = body.admin.tenantId;

  const exchange = await applyFunnelStages(db as Db, tenantId, SEED_TEMPLATES.exchange!, "exchange", {
    targetSlug: "exchange",
  });
  const realEstate = await applyFunnelStages(db as Db, tenantId, SEED_TEMPLATES.real_estate!, "real_estate", {
    targetSlug: "real_estate",
  });
  exchangeFunnelId = exchange.funnelId;
  realEstateFunnelId = realEstate.funnelId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("field-extractor service catalog routing", () => {
  it("catalog routeType=funnel creates the lead in the catalog target funnel", async () => {
    if (!sql) return;
    await insertCatalogItem({
      slug: "vip_support",
      name: "VIP сопровождение",
      routeType: "funnel",
      funnelId: realEstateFunnelId,
    });

    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "нужно VIP сопровождение для клиента",
      db,
    });

    const lead = await latestLead(contactId);
    expect(lead?.stageDefinitionId).toBe(await firstStageId(realEstateFunnelId));
    const { event, note } = await routeNotes(lead!.id);
    expect(event?.notes).toContain('"catalogItemSlug":"vip_support"');
    expect(note?.source).toBe("service_catalog");
  });

  it("explicit simulator targetFunnelId overrides the text intent", async () => {
    if (!sql) return;
    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "хочу обменять 500 USDT на баты",
      db,
      targetFunnelId: realEstateFunnelId,
    });

    const lead = await latestLead(contactId);
    expect(lead?.stageDefinitionId).toBe(await firstStageId(realEstateFunnelId));
  });

  it("explicit simulator targetCatalogItemId routes through the selected service", async () => {
    if (!sql) return;
    const catalogItemId = await insertCatalogItem({
      slug: "property_sale_sim",
      name: "Продажа недвижимости",
      routeType: "funnel",
      funnelId: realEstateFunnelId,
    });

    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "хочу обменять 500 USDT на баты",
      db,
      targetCatalogItemId: catalogItemId,
    });

    const lead = await latestLead(contactId);
    expect(lead?.stageDefinitionId).toBe(await firstStageId(realEstateFunnelId));
    const { event } = await routeNotes(lead!.id);
    expect(event?.notes).toContain('"catalogItemSlug":"property_sale_sim"');
  });

  it("a second selected funnel creates a separate lead for the same contact", async () => {
    if (!sql) return;
    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "хочу обменять 500 USDT на баты",
      db,
    });
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "ищу квартиру в Москве",
      db,
      targetFunnelId: realEstateFunnelId,
    });

    const rows = await allLeads(contactId);
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.stageDefinitionId)).toContain(await firstStageId(exchangeFunnelId));
    expect(rows.map((row) => row.stageDefinitionId)).toContain(await firstStageId(realEstateFunnelId));
  });

  it("manual catalog route creates a default-funnel lead with auditable route context", async () => {
    if (!sql) return;
    await insertCatalogItem({
      slug: "custom_request",
      name: "Индивидуальный запрос",
      routeType: "manual",
    });

    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "индивидуальный запрос по нестандартной услуге",
      db,
    });

    const lead = await latestLead(contactId);
    expect(lead?.stageDefinitionId).toBe(await firstStageId(exchangeFunnelId));
    const { event, note } = await routeNotes(lead!.id);
    expect(event?.notes).toContain('"routeType":"manual"');
    expect(note?.body).toContain("ручная обработка");
  });

  it("partner_service catalog route uses the partner service funnel when configured", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [partner] = await db
      .insert(partners)
      .values({ tenantId, name: "Transfer Partner", createdAt: now, updatedAt: now })
      .returning({ id: partners.id });
    const [service] = await db
      .insert(partnerServices)
      .values({
        tenantId,
        partnerId: partner!.id,
        name: "Airport transfer",
        funnelId: realEstateFunnelId,
        commissionPct: 10,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: partnerServices.id });
    await insertCatalogItem({
      slug: "airport_transfer",
      name: "Аэропорт трансфер",
      routeType: "partner_service",
      partnerServiceId: service!.id,
    });

    const contactId = await freshContact();
    await makeFieldExtractor(stubRef()).extract({
      tenantId,
      contactId,
      text: "нужен аэропорт трансфер завтра",
      db,
    });

    const lead = await latestLead(contactId);
    expect(lead?.stageDefinitionId).toBe(await firstStageId(realEstateFunnelId));
    const { event, note } = await routeNotes(lead!.id);
    expect(event?.notes).toContain(`"partnerServiceId":${service!.id}`);
    expect(note?.body).toContain(`партнёрская услуга #${service!.id}`);
  });
});
