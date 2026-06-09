// Integration tests for admin-funnel endpoints. Two tenants — funnel seed,
// stage CRUD, field CRUD, cross-tenant isolation, skills list.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminFunnelRoutes } from "./admin-funnel.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_funnel_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-funnel-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;

// IDs captured during test run (tests are sequential within describe blocks)
let funnelId = 0;
let customStageId = 0;
let customFieldId = 0;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminFunnelRoutes({ db }));

    // Tenant A
    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "funnel-a@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    tokenA = sba.token;
    tenantA = sba.admin.tenantId;

    // Tenant B
    const sb = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "funnel-b@demo.io", password: "strong-pwd-12345" }),
    });
    const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
    tokenB = sbb.token;
    tenantB = sbb.admin.tenantId;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("GET /api/admin/funnel — no funnel configured", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/funnel");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/funnel/templates → built-in presets", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        key: string;
        displayName: string;
        verticalTemplateId: string | null;
        isCreatable: boolean;
        stagesCount: number;
        fieldsCount: number;
        stages: Array<{ slug: string; displayName: string; fieldsCount: number }>;
      }>;
    };
    expect(body.items.length).toBeGreaterThan(5);
    const exchange = body.items.find((item) => item.key === "exchange");
    expect(exchange).toBeDefined();
    expect(exchange!.displayName).toBe("Обменка");
    expect(exchange!.verticalTemplateId).toBe("exchange_v1");
    expect(exchange!.stagesCount).toBe(11);
    expect(exchange!.fieldsCount).toBeGreaterThan(0);
    expect(exchange!.stages).toHaveLength(11);
    expect(exchange!.stages[0]!.slug).toBe("exchange_request");
    expect(exchange!.stages[0]!.fieldsCount).toBeGreaterThan(0);
    const catalog = body.items.find((item) => item.key === "concierge");
    expect(catalog).toBeDefined();
    expect(catalog!.isCreatable).toBe(false);
  });

  it("fresh tenant → funnel: null, stages: []", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { funnel: null; stages: unknown[] };
    expect(body.funnel).toBeNull();
    expect(body.stages).toEqual([]);
  });

  it("tenant B also has no funnel initially", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/funnel");
    const body = (await res.json()) as { funnel: null };
    expect(body.funnel).toBeNull();
  });
});

describe("POST /api/admin/funnel/seed", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "visa" }),
    });
    expect(res.status).toBe(401);
  });

  it("unknown template → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "nonexistent_template" }),
    });
    expect(res.status).toBe(400);
  });

  it("seed with template 'visa' → creates funnel + 7 stages", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "visa" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      funnelId: number;
      stagesCreated: number;
    };
    expect(body.ok).toBe(true);
    expect(body.funnelId).toBeGreaterThan(0);
    expect(body.stagesCreated).toBe(7); // visa template has 7 stages
    funnelId = body.funnelId;
  });

  it("GET /api/admin/funnel after seed → returns funnel with stages and fields", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      funnel: { id: number; slug: string; isActive: boolean };
      stages: Array<{
        id: number;
        slug: string;
        displayName: string;
        kind: string;
        position: number;
        fields: Array<{ slug: string }>;
      }>;
    };
    expect(body.funnel).not.toBeNull();
    expect(body.funnel.id).toBe(funnelId);
    expect(body.funnel.slug).toBe("visa");
    expect(body.funnel.isActive).toBe(true);
    expect(body.stages).toHaveLength(7);

    // Stages should be ordered by position ascending
    for (let i = 0; i < body.stages.length - 1; i++) {
      expect(body.stages[i]!.position).toBeLessThan(body.stages[i + 1]!.position);
    }

    // First stage should be "qualification"
    expect(body.stages[0]!.slug).toBe("qualification");
    expect(body.stages[0]!.kind).toBe("intake");

    // qualification stage has 4 fields in the template
    expect(body.stages[0]!.fields.length).toBeGreaterThan(0);
    const fieldSlugs = body.stages[0]!.fields.map((f) => f.slug);
    expect(fieldSlugs).toContain("citizenship");
    expect(fieldSlugs).toContain("visa_type");

    // Last two stages should be terminal
    const lastStage = body.stages[body.stages.length - 1]!;
    expect(["terminal_won", "terminal_lost"]).toContain(lastStage.kind);
  });

  it("cross-tenant: seed in tenant A, tenant B still has no funnel", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/funnel");
    const body = (await res.json()) as { funnel: null };
    expect(body.funnel).toBeNull();
    expect(tenantA).not.toBe(tenantB);
  });

  it("re-seed with same template replaces existing stages", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "visa" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stagesCreated: number; funnelId: number };
    // Same funnel reused (isActive funnel already exists)
    expect(body.funnelId).toBe(funnelId);
    expect(body.stagesCreated).toBe(7);

    // Funnel should still have exactly 7 stages (replaced, not appended)
    const getRes = await authReq(tokenA, "/api/admin/funnel");
    const getBody = (await getRes.json()) as { stages: unknown[] };
    expect(getBody.stages).toHaveLength(7);
  });

  it("records funnel versions and rolls back through snapshot preview", async () => {
    if (!sql) return;
    const listRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}/versions`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      items: Array<{ id: number; source: string; stageCount: number; createdAt: number }>;
    };
    expect(listBody.items.length).toBeGreaterThan(0);
    expect(listBody.items[0]?.source).toBe("template_apply");
    expect(listBody.items[0]?.stageCount).toBe(7);

    const versionId = listBody.items[0]!.id;
    const previewRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}/versions/${versionId}`);
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      snapshot: {
        funnel: { slug: string };
        stages: Array<{ slug: string; displayName: string; fields: Array<{ slug: string }> }>;
      };
      validation: { errors: string[]; warnings: string[] };
    };
    expect(preview.snapshot.funnel.slug).toBe("visa");
    expect(preview.snapshot.stages).toHaveLength(7);
    expect(preview.snapshot.stages[0]?.slug).toBe("qualification");
    expect(preview.validation.errors).toEqual([]);

    const currentRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}`);
    const current = (await currentRes.json()) as {
      stages: Array<{ id: number; slug: string; displayName: string }>;
    };
    const stage = current.stages.find((item) => item.slug === "qualification");
    expect(stage).toBeDefined();
    const editedName = `${stage?.displayName} edited`;
    const patchRes = await authReq(tokenA, `/api/admin/funnel/stages/${stage?.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: editedName }),
    });
    expect(patchRes.status).toBe(200);

    const editedRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}`);
    const edited = (await editedRes.json()) as {
      stages: Array<{ slug: string; displayName: string }>;
    };
    expect(edited.stages.find((item) => item.slug === "qualification")?.displayName).toBe(editedName);

    const tenantBPreview = await authReq(tokenB, `/api/admin/funnels/${funnelId}/versions/${versionId}`);
    expect(tenantBPreview.status).toBe(404);

    const rollbackRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}/versions/${versionId}/rollback`, {
      method: "POST",
    });
    expect(rollbackRes.status).toBe(200);
    const rollback = (await rollbackRes.json()) as { ok: boolean; stagesCreated: number };
    expect(rollback.ok).toBe(true);
    expect(rollback.stagesCreated).toBe(7);

    const restoredRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}`);
    const restored = (await restoredRes.json()) as {
      stages: Array<{ slug: string; displayName: string }>;
    };
    expect(restored.stages.find((item) => item.slug === "qualification")?.displayName).toBe(
      preview.snapshot.stages[0]?.displayName,
    );

    const afterRollbackRes = await authReq(tokenA, `/api/admin/funnels/${funnelId}/versions`);
    const afterRollback = (await afterRollbackRes.json()) as { items: Array<{ source: string }> };
    expect(afterRollback.items.map((item) => item.source)).toContain("rollback");
    expect(afterRollback.items.map((item) => item.source)).toContain("manual_edit");
  });

  it("seed with template 'exchange' creates a separate exchange funnel", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "exchange" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stagesCreated: number; funnelId: number };
    expect(body.funnelId).not.toBe(funnelId);
    expect(body.stagesCreated).toBe(11);

    const listRes = await authReq(tokenA, "/api/admin/funnels");
    const listBody = (await listRes.json()) as { items: Array<{ slug: string; stagesCount: number }> };
    expect(listBody.items.map((item) => item.slug)).toContain("visa");
    expect(listBody.items.map((item) => item.slug)).toContain("exchange");

    const getRes = await authReq(tokenA, `/api/admin/funnels/${body.funnelId}`);
    const getBody = (await getRes.json()) as {
      funnel: { slug: string };
      stages: Array<{ slug: string; supportMode: boolean }>;
    };
    expect(getBody.funnel.slug).toBe("exchange");
    expect(getBody.stages.map((stage) => stage.slug)).toEqual([
      "exchange_request",
      "quote_calculated",
      "verification_check",
      "kyc_collection",
      "risk_review",
      "order_created",
      "requisites_sent",
      "payment_proof_waiting",
      "payment_verified",
      "payout_or_completion",
      "cancelled",
    ]);
    expect(
      getBody.stages.find((stage) => stage.slug === "payment_proof_waiting")
        ?.supportMode,
    ).toBe(true);

    const activeRes = await authReq(tokenA, "/api/admin/funnel?primary=1");
    const activeBody = (await activeRes.json()) as {
      funnel: { slug: string; verticalTemplateId: string | null };
      stages: Array<{ slug: string }>;
    };
    expect(activeBody.funnel.slug).toBe("exchange");
    expect(activeBody.funnel.verticalTemplateId).toBe("exchange_v1");
    expect(activeBody.stages.map((stage) => stage.slug)).toEqual(
      getBody.stages.map((stage) => stage.slug),
    );

    const analyticsRes = await authReq(tokenA, "/api/admin/funnel/analytics?primary=1");
    const analyticsBody = (await analyticsRes.json()) as { stages: Array<{ slug: string }> };
    expect(analyticsBody.stages.map((stage) => stage.slug)).toEqual(
      getBody.stages.map((stage) => stage.slug),
    );

    const reset = await authReq(tokenA, "/api/admin/funnel/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: "visa" }),
    });
    const resetBody = (await reset.json()) as { stagesCreated: number };
    expect(resetBody.stagesCreated).toBe(7);
  });
});

describe("POST /api/admin/funnels — create from preset", () => {
  it("creates a new direction from selected template and stores verticalTemplateId", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/funnels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "property", template: "real_estate" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      funnelId: number;
      stagesCreated: number;
      template: string;
      verticalTemplateId: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.template).toBe("real_estate");
    expect(body.verticalTemplateId).toBe("real_estate_v1");
    expect(body.stagesCreated).toBeGreaterThan(0);

    const getRes = await authReq(tokenB, `/api/admin/funnels/${body.funnelId}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      funnel: { slug: string; verticalTemplateId: string | null };
      stages: Array<{ slug: string }>;
    };
    expect(getBody.funnel.slug).toBe("property");
    expect(getBody.funnel.verticalTemplateId).toBe("real_estate_v1");
    expect(getBody.stages.length).toBe(body.stagesCreated);
  });

  it("rejects duplicate create for an already installed template", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/funnels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "property_2", template: "real_estate" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      slug: string;
      template: string;
      verticalTemplateId: string | null;
    };
    expect(body.error).toBe("template already installed");
    expect(body.slug).toBe("property");
    expect(body.template).toBe("real_estate");
    expect(body.verticalTemplateId).toBe("real_estate_v1");
  });

  it("rejects service catalog seed as a directly creatable direction", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/funnels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "service_catalog", template: "concierge" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("template is not creatable as a direction");
    expect(body.reason).toContain("service catalog");
  });
});

describe("POST /api/admin/funnel/stages — add custom stage", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/funnel/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        funnelId,
        slug: "custom_stage",
        displayName: "Custom Stage",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("missing required fields → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ funnelId }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a custom stage and returns the new stage row", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        funnelId,
        slug: "custom_review",
        displayName: "Custom Review Stage",
        kind: "active",
        stageType: "form_fill",
        position: 99,
        color: "#ff0000",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      slug: string;
      displayName: string;
      funnelId: number;
      tenantId: number;
      kind: string;
    };
    expect(body.id).toBeGreaterThan(0);
    expect(body.slug).toBe("custom_review");
    expect(body.displayName).toBe("Custom Review Stage");
    expect(body.funnelId).toBe(funnelId);
    expect(body.tenantId).toBe(tenantA);
    expect(body.kind).toBe("active");
    customStageId = body.id;
  });

  it("GET /api/admin/funnel after adding custom stage → 8 stages total", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel");
    const body = (await res.json()) as { stages: Array<{ id: number }> };
    expect(body.stages).toHaveLength(8);
    expect(body.stages.some((s) => s.id === customStageId)).toBe(true);
  });
});

describe("PATCH /api/admin/funnel/stages/:stageId — update stage", () => {
  it("updates displayName and returns { ok: true }", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/funnel/stages/${customStageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed Custom Stage" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify via GET
    const getRes = await authReq(tokenA, "/api/admin/funnel");
    const getBody = (await getRes.json()) as {
      stages: Array<{ id: number; displayName: string }>;
    };
    const updated = getBody.stages.find((s) => s.id === customStageId);
    expect(updated!.displayName).toBe("Renamed Custom Stage");
  });

  it("bad stageId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/stages/not-a-number", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/funnel/stages/${customStageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/funnel/stages/:stageId/fields — add field", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/funnel/stages/${customStageId}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "test_field", displayName: "Test Field" }),
    });
    expect(res.status).toBe(401);
  });

  it("missing slug or displayName → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/funnel/stages/${customStageId}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "only_slug" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates field and returns field row", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/funnel/stages/${customStageId}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "custom_field_1",
        displayName: "Custom Field One",
        fieldType: "text",
        required: true,
        aiExtractable: true,
        hint: "Enter some text",
        position: 0,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      stageId: number;
      tenantId: number;
      slug: string;
      displayName: string;
      fieldType: string;
      required: boolean;
    };
    expect(body.id).toBeGreaterThan(0);
    expect(body.stageId).toBe(customStageId);
    expect(body.tenantId).toBe(tenantA);
    expect(body.slug).toBe("custom_field_1");
    expect(body.displayName).toBe("Custom Field One");
    expect(body.fieldType).toBe("text");
    expect(body.required).toBe(true);
    customFieldId = body.id;
  });

  it("field appears in GET /api/admin/funnel stages", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel");
    const body = (await res.json()) as {
      stages: Array<{ id: number; fields: Array<{ id: number; slug: string }> }>;
    };
    const customStage = body.stages.find((s) => s.id === customStageId);
    expect(customStage).toBeDefined();
    expect(customStage!.fields.some((f) => f.id === customFieldId)).toBe(true);
    expect(customStage!.fields.find((f) => f.id === customFieldId)!.slug).toBe("custom_field_1");
  });
});

describe("PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId — update field", () => {
  it("updates field displayName and required, returns { ok: true }", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      `/api/admin/funnel/stages/${customStageId}/fields/${customFieldId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Renamed Custom Field", required: false }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify via GET
    const getRes = await authReq(tokenA, "/api/admin/funnel");
    const getBody = (await getRes.json()) as {
      stages: Array<{ id: number; fields: Array<{ id: number; displayName: string; required: boolean }> }>;
    };
    const stage = getBody.stages.find((s) => s.id === customStageId);
    const field = stage!.fields.find((f) => f.id === customFieldId);
    expect(field!.displayName).toBe("Renamed Custom Field");
    expect(field!.required).toBe(false);
  });

  it("bad fieldId → 400", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      `/api/admin/funnel/stages/${customStageId}/fields/not-a-number`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "x" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(
      `/api/admin/funnel/stages/${customStageId}/fields/${customFieldId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "x" }),
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId — delete field", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(
      `/api/admin/funnel/stages/${customStageId}/fields/${customFieldId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });

  it("deletes field, returns { ok: true }", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      `/api/admin/funnel/stages/${customStageId}/fields/${customFieldId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Field should no longer appear
    const getRes = await authReq(tokenA, "/api/admin/funnel");
    const getBody = (await getRes.json()) as {
      stages: Array<{ id: number; fields: Array<{ id: number }> }>;
    };
    const stage = getBody.stages.find((s) => s.id === customStageId);
    expect(stage!.fields.some((f) => f.id === customFieldId)).toBe(false);
  });
});

describe("DELETE /api/admin/funnel/stages/:stageId — delete stage", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request(`/api/admin/funnel/stages/${customStageId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("bad stageId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/funnel/stages/not-a-number", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("deletes the custom stage, returns { ok: true }", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, `/api/admin/funnel/stages/${customStageId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Back to 7 stages
    const getRes = await authReq(tokenA, "/api/admin/funnel");
    const getBody = (await getRes.json()) as { stages: Array<{ id: number }> };
    expect(getBody.stages).toHaveLength(7);
    expect(getBody.stages.some((s) => s.id === customStageId)).toBe(false);
  });
});

describe("GET /api/admin/skills", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/skills");
    expect(res.status).toBe(401);
  });

  it("returns items array (may be empty for fresh tenant)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("cross-tenant: tenant B skills are isolated from tenant A", async () => {
    if (!sql) return;
    const resA = await authReq(tokenA, "/api/admin/skills");
    const resB = await authReq(tokenB, "/api/admin/skills");
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Both return arrays — tenant isolation is maintained
    const bodyA = (await resA.json()) as { items: Array<{ tenantId: number }> };
    const bodyB = (await resB.json()) as { items: Array<{ tenantId: number }> };
    for (const item of bodyA.items) {
      expect(item.tenantId).toBe(tenantA);
    }
    for (const item of bodyB.items) {
      expect(item.tenantId).toBe(tenantB);
    }
  });
});

// Referenced only to suppress unused-import warning
void tenants;
