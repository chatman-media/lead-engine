// Integration tests for admin-leads endpoints. Two tenants, contacts, leads,
// stages, field values — pagination, contactId filter, stage move, field upsert,
// cross-tenant isolation, contact search.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { DrizzleKbStore } from "@chatman-media/conversation-engine";
import { ingestText } from "@chatman-media/kb";
import { NullEmbeddingClient } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  funnels,
  leadFieldValues,
  leads,
  messages,
  outboundQueue,
  schema,
  stageDefinitions,
  stageFields,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminLeadsRoutes } from "./admin-leads.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_leads_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-leads-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;
let embedder: NullEmbeddingClient;

let contactIdA = 0;
let contactIdA2 = 0;
let funnelIdA = 0;
let stageIdA = 0;
let stageIdA2 = 0;
let stageIdA3 = 0; // slug "blocked_stage" — NOT in stageIdA.nextStages
let leadIdA = 0;
let leadIdA2 = 0;
let leadIdA3 = 0; // fresh lead on stageIdA for transition validation tests

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  embedder = new NullEmbeddingClient(1536);

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminLeadsRoutes({ db, resolveEmbedder: () => embedder }));

  // Tenant A
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "leads-a@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  tokenA = sba.token;
  tenantA = sba.admin.tenantId;

  // Tenant B
  const sb = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "leads-b@demo.io", password: "strong-pwd-12345" }),
  });
  const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
  tokenB = sbb.token;
  tenantB = sbb.admin.tenantId;

  const now = Math.floor(Date.now() / 1000);

  // Create contacts for tenant A
  const [c1] = await db
    .insert(contacts)
    .values({ tenantId: tenantA, displayName: "Alice Wonderland" })
    .returning({ id: contacts.id });
  contactIdA = c1!.id;

  const [c2] = await db
    .insert(contacts)
    .values({ tenantId: tenantA, displayName: "Bob Builder" })
    .returning({ id: contacts.id });
  contactIdA2 = c2!.id;

  // Create a contact for tenant B (to verify isolation)
  await db
    .insert(contacts)
    .values({ tenantId: tenantB, displayName: "Charlie Chaplin" })
    .returning({ id: contacts.id });

  // Create funnel + stages for tenant A
  const [funnel] = await db
    .insert(funnels)
    .values({ tenantId: tenantA, slug: "main", isActive: true, createdAt: now, updatedAt: now })
    .returning({ id: funnels.id });
  funnelIdA = funnel!.id;

  const [stage1] = await db
    .insert(stageDefinitions)
    .values({
      tenantId: tenantA,
      funnelId: funnelIdA,
      slug: "intake_pending",
      displayName: "Intake",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      nextStages: ["review"],
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: stageDefinitions.id });
  stageIdA = stage1!.id;

  const [stage2] = await db
    .insert(stageDefinitions)
    .values({
      tenantId: tenantA,
      funnelId: funnelIdA,
      slug: "review",
      displayName: "Review",
      kind: "active",
      stageType: "form_fill",
      position: 1,
      nextStages: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: stageDefinitions.id });
  stageIdA2 = stage2!.id;

  // Third stage — slug "blocked_stage", NOT listed in stageIdA.nextStages
  const [stage3] = await db
    .insert(stageDefinitions)
    .values({
      tenantId: tenantA,
      funnelId: funnelIdA,
      slug: "blocked_stage",
      displayName: "Blocked Stage",
      kind: "active",
      stageType: "form_fill",
      position: 2,
      nextStages: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: stageDefinitions.id });
  stageIdA3 = stage3!.id;

  // Create two leads for tenant A
  const [lead1] = await db
    .insert(leads)
    .values({
      tenantId: tenantA,
      userId: contactIdA,
      state: "intake_pending",
      stageDefinitionId: stageIdA,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: leads.id });
  leadIdA = lead1!.id;

  const [lead2] = await db
    .insert(leads)
    .values({
      tenantId: tenantA,
      userId: contactIdA2,
      state: "intake_pending",
      stageDefinitionId: stageIdA,
      createdAt: now - 100,
      updatedAt: now - 100,
    })
    .returning({ id: leads.id });
  leadIdA2 = lead2!.id;

  // Third contact + lead for transition validation tests
  const [c3] = await db
    .insert(contacts)
    .values({ tenantId: tenantA, displayName: "Dave Validation" })
    .returning({ id: contacts.id });
  const [lead3] = await db
    .insert(leads)
    .values({
      tenantId: tenantA,
      userId: c3!.id,
      state: "intake_pending",
      stageDefinitionId: stageIdA,
      createdAt: now - 200,
      updatedAt: now - 200,
    })
    .returning({ id: leads.id });
  leadIdA3 = lead3!.id;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("GET /api/admin/leads", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/leads");
    expect(res.status).toBe(401);
  });

  it("empty list for fresh tenant B (no leads)", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/leads");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("returns leads for tenant A ordered DESC by updatedAt", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; contactId: number; contactName: string; state: string }>;
      limit: number;
      offset: number;
    };
    expect(body.items).toHaveLength(3); // leadIdA, leadIdA2, leadIdA3 (Dave Validation)
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    // First lead should be most recent (leadIdA)
    expect(body.items[0]!.id).toBe(leadIdA);
    expect(body.items[0]!.contactName).toBe("Alice Wonderland");
    expect(body.items[0]!.state).toBe("intake_pending");
  });

  it("?contactId= filter returns only that contact's leads", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads?contactId=${contactIdA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number; contactId: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(leadIdA);
    expect(body.items[0]!.contactId).toBe(contactIdA);
  });

  it("?contactId= for contact with no leads → empty list", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads?contactId=999999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("?q= search filters leads by contact name (case-insensitive)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads?q=alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number; contactName: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(leadIdA);
    expect(body.items[0]!.contactName).toBe("Alice Wonderland");
  });

  it("?q= with no match → empty list", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads?q=zzznomatch");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("cross-tenant isolation: tenant B sees no tenant A leads", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/leads");
    const body = (await res.json()) as { items: Array<{ id: number }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).not.toContain(leadIdA);
    expect(ids).not.toContain(leadIdA2);
    expect(tenantA).not.toBe(tenantB);
  });
});

describe("POST /api/admin/leads", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: contactIdA }),
    });
    expect(res.status).toBe(401);
  });

  it("missing contactId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("creates lead for existing contact, returns lead row with id", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);

    // Create a fresh contact for this test
    const [c] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "New Lead Contact" })
      .returning({ id: contacts.id });
    const freshContactId = c!.id;

    const res = await authReq(tokenA, "/api/admin/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: freshContactId, stageDefinitionId: stageIdA }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      tenantId: number;
      userId: number;
      state: string;
      stageDefinitionId: number;
    };
    expect(body.id).toBeGreaterThan(0);
    expect(body.tenantId).toBe(tenantA);
    expect(body.userId).toBe(freshContactId);
    expect(body.state).toBe("intake_pending");
    expect(body.stageDefinitionId).toBe(stageIdA);
    expect(body.id).toBeGreaterThan(0);
    // Verify lead actually landed in the list
    const listRes = await authReq(tokenA, `/api/admin/leads?contactId=${freshContactId}`);
    const listBody = (await listRes.json()) as { items: Array<{ id: number }> };
    expect(listBody.items.some((i) => i.id === body.id)).toBe(true);
  });

  it("creates lead with default state when no state provided", async () => {
    if (!sql) return;
    const [c] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "State Default Contact" })
      .returning({ id: contacts.id });

    const res = await authReq(tokenA, "/api/admin/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: c!.id }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("intake_pending");
  });
});

describe("GET /api/admin/leads/:id", () => {
  it("returns full lead detail with contact, fields, events, notes", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lead: { id: number; state: string; tenantId: number };
      contact: { id: number; displayName: string };
      stageDef: { id: number; slug: string } | null;
      fields: unknown[];
      fieldValues: unknown[];
      events: unknown[];
      notes: unknown[];
    };
    expect(body.lead.id).toBe(leadIdA);
    expect(body.lead.state).toBe("intake_pending");
    expect(body.lead.tenantId).toBe(tenantA);
    expect(body.contact.id).toBe(contactIdA);
    expect(body.contact.displayName).toBe("Alice Wonderland");
    expect(body.stageDef).not.toBeNull();
    expect(body.stageDef!.slug).toBe("intake_pending");
    expect(Array.isArray(body.fields)).toBe(true);
    expect(Array.isArray(body.fieldValues)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it("non-existent lead → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/999999");
    expect(res.status).toBe(404);
  });

  it("invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/not-a-number");
    expect(res.status).toBe(400);
  });

  it("cross-tenant: tenant B cannot access tenant A's lead → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, `/api/admin/leads/${leadIdA}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/leads/:id/kb-guidance", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/leads/${leadIdA}/kb-guidance`);
    expect(res.status).toBe(401);
  });

  it("returns required field state and stage-scoped KB hints", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [contact] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Guidance Contact" })
      .returning({ id: contacts.id });
    const [lead] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: contact!.id,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    const [field] = await db
      .insert(stageFields)
      .values({
        tenantId: tenantA,
        stageId: stageIdA,
        slug: "guidance_budget",
        displayName: "Client budget",
        fieldType: "number",
        required: true,
        hint: "Amount the client is ready to exchange",
        aiExtractable: true,
        position: 20,
        createdAt: now,
      })
      .returning({ id: stageFields.id });

    await ingestText(
      {
        title: "Intake rules",
        body: "На стадии intake обязательно уточнить сумму, валюту, сеть и способ выдачи. Нельзя обещать курс без расчёта.",
      },
      {
        kb: new DrizzleKbStore({ db: db as never, tenantId: tenantA }),
        embedder,
        topic: "process",
        scope: { scopeType: "stage", funnelId: funnelIdA, stageSlug: "intake_pending" },
        source: `test:lead-guidance:${lead!.id}`,
      },
    );

    const res = await authReq(tokenA, `/api/admin/leads/${lead!.id}/kb-guidance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leadId: number;
      stage: { slug: string; funnelId: number } | null;
      kbAvailable: boolean;
      requiredFields: Array<{ id: number; displayName: string; filled: boolean }>;
      missingRequiredFields: Array<{ id: number; displayName: string; filled: boolean }>;
      nextActions: string[];
      hits: Array<{ title: string; scopeType: string; stageSlug: string | null }>;
    };
    expect(body.leadId).toBe(lead!.id);
    expect(body.stage?.slug).toBe("intake_pending");
    expect(body.stage?.funnelId).toBe(funnelIdA);
    expect(body.kbAvailable).toBe(true);
    expect(body.requiredFields.find((item) => item.id === field!.id)?.filled).toBe(false);
    expect(body.missingRequiredFields.map((item) => item.displayName)).toContain("Client budget");
    expect(body.nextActions.some((action) => action.includes("Client budget"))).toBe(true);
    expect(body.hits.some((hit) => hit.title === "Intake rules")).toBe(true);
    expect(
      body.hits.every((hit) => hit.scopeType === "stage" && hit.stageSlug === "intake_pending"),
    ).toBe(true);
  });

  it("cross-tenant: tenant B cannot access tenant A guidance → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, `/api/admin/leads/${leadIdA}/kb-guidance`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/admin/leads/:id/stage", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/leads/${leadIdA}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA2 }),
    });
    expect(res.status).toBe(401);
  });

  it("missing stageDefinitionId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("non-existent lead → throws (500 from route)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/999999/stage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA2 }),
    });
    // Route throws Error("lead not found") which Hono turns into 500
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("moves lead to a different stage, returns { ok: true }", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA2}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify the lead moved in the detail view
    const detailRes = await authReq(tokenA, `/api/admin/leads/${leadIdA2}`);
    const detail = (await detailRes.json()) as {
      lead: { stageDefinitionId: number; state: string };
      events: Array<{ fromState: string; toState: string }>;
    };
    expect(detail.lead.stageDefinitionId).toBe(stageIdA2);
    expect(detail.lead.state).toBe("review");
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]!.fromState).toBe("intake_pending");
    expect(detail.events[0]!.toState).toBe("review");
  });

  it("cross-tenant: tenant B cannot move tenant A's lead", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, `/api/admin/leads/${leadIdA}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA2 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("PUT /api/admin/leads/:id/field-values", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/leads/${leadIdA}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ fieldId: 1, value: "test" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("empty values array → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("upserts field values, returns { ok, advanced }", async () => {
    if (!sql) return;
    // We need a real stage field to reference. Use the stageIdA (intake_pending).
    // Insert a field directly so we have a valid fieldId.
    const { stageFields } = await import("@chatman-media/storage");
    const now = Math.floor(Date.now() / 1000);
    const [field] = await db
      .insert(stageFields)
      .values({
        stageId: stageIdA,
        tenantId: tenantA,
        slug: "test_field",
        displayName: "Test Field",
        fieldType: "text",
        required: false,
        aiExtractable: false,
        position: 0,
        createdAt: now,
      })
      .returning({ id: stageFields.id });
    const fieldId = field!.id;

    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ fieldId, value: "hello world" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      advanced: boolean;
      newStageSlug: string | null;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.advanced).toBe("boolean");

    // Verify the field value appears in the lead detail
    const detailRes = await authReq(tokenA, `/api/admin/leads/${leadIdA}`);
    const detail = (await detailRes.json()) as {
      fieldValues: Array<{ fieldId: number; valueJson: string }>;
    };
    const savedVal = detail.fieldValues.find((fv) => fv.fieldId === fieldId);
    expect(savedVal).toBeDefined();
    expect(savedVal!.valueJson).toBe('"hello world"');
  });

  it("upsert same field twice → value updated (idempotent)", async () => {
    if (!sql) return;
    const { stageFields, leadFieldValues } = await import("@chatman-media/storage");
    const { eq, and } = await import("drizzle-orm");
    const now = Math.floor(Date.now() / 1000);
    const [field] = await db
      .insert(stageFields)
      .values({
        stageId: stageIdA,
        tenantId: tenantA,
        slug: "upsert_field",
        displayName: "Upsert Field",
        fieldType: "text",
        required: false,
        aiExtractable: false,
        position: 99,
        createdAt: now,
      })
      .returning({ id: stageFields.id });
    const fieldId = field!.id;

    // First upsert
    await authReq(tokenA, `/api/admin/leads/${leadIdA}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ fieldId, value: "original" }] }),
    });

    // Second upsert with new value
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ fieldId, value: "updated" }] }),
    });
    expect(res.status).toBe(200);

    const [stored] = await db
      .select({ valueJson: leadFieldValues.valueJson })
      .from(leadFieldValues)
      .where(and(eq(leadFieldValues.leadId, leadIdA), eq(leadFieldValues.fieldId, fieldId)));
    expect(stored!.valueJson).toBe('"updated"');
  });

  it("branch-aware auto-advance uses request_type instead of always nextStages[0]", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [contact] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Branch Admin" })
      .returning({ id: contacts.id });
    const [funnel] = await db
      .insert(funnels)
      .values({
        tenantId: tenantA,
        slug: `branch_admin_${Math.random().toString(36).slice(2, 8)}`,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: funnels.id });
    const [intake] = await db
      .insert(stageDefinitions)
      .values({
        tenantId: tenantA,
        funnelId: funnel!.id,
        slug: "request_received",
        displayName: "Request Received",
        kind: "intake",
        stageType: "form_fill",
        position: 0,
        nextStages: ["exchange_request", "transfer_request"],
        autoAdvanceCondition: JSON.stringify({ type: "all_required_fields_filled" }),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: stageDefinitions.id });
    await db.insert(stageDefinitions).values([
      {
        tenantId: tenantA,
        funnelId: funnel!.id,
        slug: "exchange_request",
        displayName: "Exchange",
        kind: "active",
        stageType: "form_fill",
        phase: "qualify",
        position: 1,
        nextStages: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId: tenantA,
        funnelId: funnel!.id,
        slug: "transfer_request",
        displayName: "Transfer",
        kind: "active",
        stageType: "form_fill",
        phase: "qualify",
        position: 2,
        nextStages: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const [field] = await db
      .insert(stageFields)
      .values({
        stageId: intake!.id,
        tenantId: tenantA,
        slug: "request_type",
        displayName: "Request Type",
        fieldType: "select",
        required: true,
        aiExtractable: true,
        optionsJson: JSON.stringify([
          { value: "exchange", label: "Exchange" },
          { value: "transfer", label: "Transfer" },
        ]),
        position: 0,
        createdAt: now,
      })
      .returning({ id: stageFields.id });

    const [lead] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: contact!.id,
        state: "request_received",
        stageDefinitionId: intake!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });

    const res = await authReq(tokenA, `/api/admin/leads/${lead!.id}/field-values`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [{ fieldId: field!.id, value: "transfer" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      advanced: boolean;
      newStageSlug: string | null;
    };
    expect(body).toEqual({ ok: true, advanced: true, newStageSlug: "transfer_request" });

    const [storedLead] = await db
      .select({
        state: leads.state,
        requestType: leads.requestType,
      })
      .from(leads)
      .where(and(eq(leads.id, lead!.id), eq(leads.tenantId, tenantA)));
    expect(storedLead).toEqual({ state: "transfer_request", requestType: "transfer" });

    const [storedValue] = await db
      .select({ valueJson: leadFieldValues.valueJson })
      .from(leadFieldValues)
      .where(and(eq(leadFieldValues.leadId, lead!.id), eq(leadFieldValues.fieldId, field!.id)));
    expect(storedValue!.valueJson).toBe('"transfer"');
  });
});

describe("GET /api/admin/contacts", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/contacts");
    expect(res.status).toBe(401);
  });

  it("returns contacts for tenant A", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/contacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; displayName: string }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    // All items should be tenant A contacts
    const names = body.items.map((i) => i.displayName);
    // Bob Builder and Alice Wonderland should be present
    expect(names.some((n) => n.includes("Alice"))).toBe(true);
    expect(names.some((n) => n.includes("Bob"))).toBe(true);
    // Tenant B's contact should not appear
    expect(names).not.toContain("Charlie Chaplin");
  });

  it("?q= search returns matching contacts only", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/contacts?q=Alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; displayName: string }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.displayName.toLowerCase()).toContain("alice");
    }
  });

  it("?q= with no match → empty items", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/contacts?q=zzznomatch");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("cross-tenant: tenant B sees only its own contacts", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/contacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; displayName: string }>;
    };
    // Only Charlie Chaplin (tenant B's contact)
    for (const item of body.items) {
      expect(item.displayName).not.toContain("Alice");
      expect(item.displayName).not.toContain("Bob");
    }
  });
});

describe("PATCH /api/admin/leads/:id/stage — transition validation", () => {
  it("allowed transition (slug in nextStages) → 200", async () => {
    if (!sql) return;
    // leadIdA3 is on stageIdA (nextStages: ["review"]); moving to stageIdA2 (slug:"review") is allowed
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA3}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("disallowed transition (slug not in nextStages) → 422", async () => {
    if (!sql) return;
    // leadIdA is on stageIdA (nextStages: ["review"]); "blocked_stage" is NOT in the list
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA3 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("transition_not_allowed");
  });

  it("disallowed transition with force:true → 200 (admin override)", async () => {
    if (!sql) return;
    // Same disallowed move, but force:true bypasses the check
    const res = await authReq(tokenA, `/api/admin/leads/${leadIdA}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA3, force: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("lead with no stageDefinitionId (legacy) → skip validation → 200", async () => {
    if (!sql) return;
    // Create a legacy lead without a stage
    const [c] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Legacy Lead Contact" })
      .returning({ id: contacts.id });
    const now = Math.floor(Date.now() / 1000);
    const [legacyLead] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: c!.id,
        state: "intake_pending",
        stageDefinitionId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });

    const res = await authReq(tokenA, `/api/admin/leads/${legacyLead!.id}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageDefinitionId: stageIdA3 }),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/leads/:id", () => {
  it("deletes lead and returns 200 { ok: true }", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [c] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Deletable Lead" })
      .returning({ id: contacts.id });
    const [newLead] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: c!.id,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });

    const res = await authReq(tokenA, `/api/admin/leads/${newLead!.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify lead is gone
    const check = await authReq(tokenA, `/api/admin/leads/${newLead!.id}`);
    expect(check.status).toBe(404);
  });

  it("cross-tenant: cannot delete another tenant's lead", async () => {
    if (!sql) return;
    // leadIdA belongs to tenantA — tenant B should get 200 but not actually delete it
    const res = await authReq(tokenB, `/api/admin/leads/${leadIdA}`, { method: "DELETE" });
    // 200 is returned (no lead found in tenantB ctx → no-op)
    expect(res.status).toBe(200);
    // But lead should still exist for tenant A
    const check = await authReq(tokenA, `/api/admin/leads/${leadIdA}`);
    expect(check.status).toBe(200);
  });
});

describe("send-offer — awaiting_operator advance (R5)", () => {
  let opLeadId = 0;
  let normLeadId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const now = Math.floor(Date.parse("2026-06-06T05:00:00Z") / 1000);
    // fulfill + awaiting_operator offer-стадии в воронке tenantA
    const [fulfill] = await db
      .insert(stageDefinitions)
      .values({
        tenantId: tenantA,
        funnelId: funnelIdA,
        slug: "op_fulfill",
        displayName: "Fulfill",
        kind: "active",
        stageType: "milestone",
        position: 10,
        nextStages: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: stageDefinitions.id });
    void fulfill;
    const [offer] = await db
      .insert(stageDefinitions)
      .values({
        tenantId: tenantA,
        funnelId: funnelIdA,
        slug: "op_offer",
        displayName: "Offer (operator)",
        kind: "active",
        stageType: "awaiting_operator",
        phase: "offer",
        position: 9,
        nextStages: ["op_fulfill"],
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: stageDefinitions.id });
    // канал + identity для contactIdA — иначе send-offer вернёт 409 no_channel
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId: tenantA,
        kind: "telegram_bot",
        externalId: "op-bot",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    await db.insert(channelIdentities).values({
      contactId: contactIdA,
      channelId: ch!.id,
      externalUserId: "tg-op-1",
      createdAt: now,
    });
    const [l1] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: contactIdA,
        state: "op_offer",
        stageDefinitionId: offer!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    opLeadId = l1!.id;
    // лид того же контакта на обычной стадии (канал есть) — для негатива
    const [l2] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: contactIdA,
        state: "review",
        stageDefinitionId: stageIdA2,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    normLeadId = l2!.id;
  });

  it("лид на awaiting_operator → /send-offer двигает в nextStages[0]", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/leads/${opLeadId}/send-offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ text: "Курс 36.5, подача 9:00. Подтвердить?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advancedTo: string | null };
    expect(body.advancedTo).toBe("op_fulfill");
    const { and, eq } = await import("drizzle-orm");
    const { leadEvents } = await import("@chatman-media/storage");
    const [l] = await db.select({ state: leads.state }).from(leads).where(eq(leads.id, opLeadId));
    expect(l!.state).toBe("op_fulfill");
    const [event] = await db
      .select({ notes: leadEvents.notes })
      .from(leadEvents)
      .where(
        and(
          eq(leadEvents.tenantId, tenantA),
          eq(leadEvents.leadId, opLeadId),
          eq(leadEvents.toState, "op_fulfill"),
        ),
      );
    expect(event?.notes).toContain('"workflowEvent":"operator_sent_offer"');
  });

  it("лид на обычной стадии → /send-offer не двигает (advancedTo null)", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/leads/${normLeadId}/send-offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ text: "Просто сообщение" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advancedTo: string | null };
    expect(body.advancedTo).toBe(null);
  });
});

describe("POST /api/admin/leads/:id/advance", () => {
  let freshLeadId = 0;
  beforeAll(async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [l] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: contactIdA,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    freshLeadId = l!.id;
  });

  it("invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/abc/advance", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("happy: двигает на nextStages[0] (intake_pending → review)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${freshLeadId}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "переводим в ревью" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; from: string; to: string };
    expect(body.ok).toBe(true);
    expect(body.to).toBe("review");
  });

  it("пустое тело допустимо (note optional)", async () => {
    if (!sql) return;
    // lead now on "review" (nextStages: []) → no further stage → 409
    const res = await authReq(tokenA, `/api/admin/leads/${freshLeadId}/advance`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

describe("GET /api/admin/leads/export.csv", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/leads/export.csv");
    expect(res.status).toBe(401);
  });

  it("отдаёт CSV с BOM, заголовками и строками лидов tenant A", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("leads.csv");
    const text = await res.text();
    expect(text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    const headerLine = text.replace(/^﻿/, "").split("\r\n")[0] ?? "";
    expect(headerLine).toContain("id");
    expect(headerLine).toContain("contactName");
    expect(text).toContain("Alice Wonderland");
  });

  it("экранирует CSV-ячейки с запятыми/кавычками (через имя контакта)", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [qc] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: 'Quote "Comma", Inc' })
      .returning({ id: contacts.id });
    await db.insert(leads).values({
      tenantId: tenantA,
      userId: qc!.id,
      state: "intake_pending",
      stageDefinitionId: stageIdA,
      createdAt: now,
      updatedAt: now,
    });
    const res = await authReq(tokenA, "/api/admin/leads/export.csv");
    const text = await res.text();
    // CSV-quoting удваивает внутренние кавычки и оборачивает ячейку
    expect(text).toContain('"Quote ""Comma"", Inc"');
  });
});

describe("POST /api/admin/leads/import", () => {
  it("text/csv body → импортирует строки", async () => {
    if (!sql) return;
    const csv = "name,phone,email,stage_slug\nИмпорт Один,+100,one@x.io,review\nИмпорт Два,,,";
    const res = await authReq(tokenA, "/api/admin/leads/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number; skipped: number; errors: string[] };
    expect(body.imported).toBe(2);
  });

  it("multipart form file → импортирует", async () => {
    if (!sql) return;
    const form = new FormData();
    form.set("file", new File(["name\nИз Файла"], "leads.csv", { type: "text/csv" }));
    const res = await authReq(tokenA, "/api/admin/leads/import", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number };
    expect(body.imported).toBe(1);
  });

  it("multipart без файла → 400", async () => {
    if (!sql) return;
    const form = new FormData();
    form.set("notfile", "x");
    const res = await authReq(tokenA, "/api/admin/leads/import", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("без колонки name → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: "phone,email\n+1,a@b.io",
    });
    expect(res.status).toBe(400);
  });

  it("только заголовок (нет данных) → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: "name,phone",
    });
    expect(res.status).toBe(400);
  });

  it("строки без name пропускаются (skipped)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: 'name,phone\n"",+1\nВалид,+2',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number; skipped: number };
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
  });
});

describe("POST /api/admin/leads/:id/send-photo", () => {
  let photoContactId = 0;
  let photoLeadId = 0;
  let maxLeadId = 0;
  let noChannelLeadId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [pc] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Photo Target" })
      .returning({ id: contacts.id });
    photoContactId = pc!.id;
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId: tenantA,
        kind: "telegram_bot",
        externalId: "photo-bot",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    await db.insert(channelIdentities).values({
      contactId: photoContactId,
      channelId: ch!.id,
      externalUserId: "tg-photo-1",
      createdAt: now,
    });
    await db.insert(conversations).values({
      tenantId: tenantA,
      userId: photoContactId,
      lastMessageAt: now,
      createdAt: now,
    });
    const [l] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: photoContactId,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    photoLeadId = l!.id;

    const [maxContact] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "MAX Photo Target" })
      .returning({ id: contacts.id });
    const [maxChannel] = await db
      .insert(channels)
      .values({
        tenantId: tenantA,
        kind: "max",
        externalId: "max-photo-bot",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    await db.insert(channelIdentities).values({
      contactId: maxContact!.id,
      channelId: maxChannel!.id,
      externalUserId: "max-user-555",
      createdAt: now,
    });
    await db.insert(conversations).values({
      tenantId: tenantA,
      userId: maxContact!.id,
      lastMessageAt: now,
      createdAt: now,
    });
    const [maxLead] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: maxContact!.id,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    maxLeadId = maxLead!.id;

    // lead whose contact has no channel
    const [nc] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "No Channel" })
      .returning({ id: contacts.id });
    const [l2] = await db
      .insert(leads)
      .values({
        tenantId: tenantA,
        userId: nc!.id,
        state: "intake_pending",
        stageDefinitionId: stageIdA,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });
    noChannelLeadId = l2!.id;
  });

  it("bad id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/notanumber/send-photo", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${photoLeadId}/send-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });

  it("без photoRef → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${photoLeadId}/send-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: "no ref" }),
    });
    expect(res.status).toBe(400);
  });

  it("несуществующий лид → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/leads/99999999/send-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoRef: "file-123" }),
    });
    expect(res.status).toBe(404);
  });

  it("лид без активного канала → 409", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${noChannelLeadId}/send-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoRef: "file-123" }),
    });
    expect(res.status).toBe(409);
  });

  it("MAX text-only канал → 409 без enqueue фото", async () => {
    if (!sql) return;
    const before = await db
      .select({ id: outboundQueue.id })
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantA));
    const res = await authReq(tokenA, `/api/admin/leads/${maxLeadId}/send-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoRef: "https://example.com/max.jpg", caption: "фото" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; channelKind?: string };
    expect(body.error).toBe("channel does not support photo delivery");
    expect(body.channelKind).toBe("max");
    const after = await db
      .select({ id: outboundQueue.id })
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantA));
    expect(after.length).toBe(before.length);
  });

  it("happy: ставит фото в outbound_queue + пишет сообщение", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/leads/${photoLeadId}/send-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoRef: "https://example.com/p.jpg", caption: "вот фото" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channelKind: string };
    expect(body.ok).toBe(true);
    expect(body.channelKind).toBe("telegram_bot");
    const { eq } = await import("drizzle-orm");
    const queued = await db
      .select({ id: outboundQueue.id })
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantA));
    expect(queued.length).toBeGreaterThan(0);
    void messages;
  });
});

// Referenced only to suppress unused-import warning
void tenants;
