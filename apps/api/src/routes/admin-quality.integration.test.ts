import {
  admins,
  applyAllMigrations,
  createIsolatedDb,
  schema,
  selfPlayMatches,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminQualityRoutes } from "./admin-quality.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_quality_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-quality-export-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tokenB = "";
let tenantA = 0;
let tenantB = 0;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  app.route("/", makeAuthRoutes({ db: db as never, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminQualityRoutes({ db }));

  tokenA = await signup("quality-a@demo.io");
  tokenB = await signup("quality-b@demo.io");
  tenantA = await tenantFor("quality-a@demo.io");
  tenantB = await tenantFor("quality-b@demo.io");

  const now = Math.floor(Date.now() / 1000);
  await db.insert(selfPlayMatches).values([
    {
      tenantId: tenantA,
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "won",
      judgeReason: "candidate committed",
      transcriptJson: JSON.stringify([
        { role: "candidate", text: "привет" },
        { role: "salesperson", text: "расскажу коротко" },
      ]),
      turns: 1,
      skillsJson: JSON.stringify(["mirroring"]),
      leadId: null,
      fabricationsCaught: 1,
      createdAt: now,
    },
    {
      tenantId: tenantA,
      styleSlug: "style-b",
      personaSlug: "price-sensitive",
      outcome: "lost",
      judgeReason: "walked away",
      transcriptJson: JSON.stringify([{ role: "candidate", text: "дорого" }]),
      turns: 1,
      skillsJson: JSON.stringify(["urgency"]),
      leadId: null,
      fabricationsCaught: 0,
      createdAt: now - 10,
    },
    {
      tenantId: tenantB,
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "draw",
      judgeReason: "tenant b only",
      transcriptJson: JSON.stringify([{ role: "candidate", text: "чужой" }]),
      turns: 1,
      skillsJson: "[]",
      leadId: null,
      fabricationsCaught: 0,
      createdAt: now,
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("admin quality JSONL export", () => {
  it("requires auth", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/quality/self-play/export.jsonl");
    expect(res.status).toBe(401);
  });

  it("returns tenant-scoped self-play summary", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/self-play/summary");
    expect(res.status).toBe(200);

    const body = (await res.json()) as QualitySummaryResponse;
    expect(body.totals).toMatchObject({
      total: 2,
      won: 1,
      lost: 1,
      draw: 0,
      winRate: 50,
      fabricationsCaught: 1,
      avgTurns: 1,
    });
    expect(body.byStyle).toHaveLength(2);
    expect(body.byStyle[0]).toMatchObject({
      styleSlug: "style-a",
      total: 1,
      won: 1,
      winRate: 100,
    });
    expect(body.byPersona.map((item) => item.personaSlug)).toEqual([
      "skeptic-anya",
      "price-sensitive",
    ]);
    expect(body.recent[0]).toMatchObject({
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "won",
      judgeReason: "candidate committed",
    });
    expect(JSON.stringify(body)).not.toContain("tenant b only");
  });

  it("exports tenant-scoped self-play matches as JSONL attachment", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/self-play/export.jsonl");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toContain("self-play-matches.jsonl");

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      kind: "self_play_match",
      source: "admin-api",
      match: {
        styleSlug: "style-a",
        personaSlug: "skeptic-anya",
        outcome: "won",
        skills: ["mirroring"],
        judge: { outcome: "won", reason: "candidate committed" },
        fabricationsCaught: 1,
        persisted: true,
      },
    });
    expect(records[0]?.match.transcript).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("tenant b only");
  });

  it("filters by style/persona/outcome and can omit transcripts", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      "/api/admin/quality/self-play/export.jsonl?styleSlug=style-b&personaSlug=price-sensitive&outcome=lost&includeTranscript=false",
    );
    expect(res.status).toBe(200);
    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect(records[0]?.match.styleSlug).toBe("style-b");
    expect(records[0]?.match.transcript).toBeUndefined();
    expect(records[0]?.match.turns).toBe(1);
  });

  it("validates outcome and limit", async () => {
    if (!sql) return;
    expect(
      (await authReq(tokenA, "/api/admin/quality/self-play/export.jsonl?outcome=bad")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/self-play/export.jsonl?limit=0")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/self-play/export.jsonl?limit=1001")).status,
    ).toBe(400);
  });

  it("keeps another tenant isolated", async () => {
    if (!sql) return;
    const records = parseJsonl(
      await (await authReq(tokenB, "/api/admin/quality/self-play/export.jsonl")).text(),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.match.judge.reason).toBe("tenant b only");

    const summary = (await (
      await authReq(tokenB, "/api/admin/quality/self-play/summary")
    ).json()) as QualitySummaryResponse;
    expect(summary.totals).toMatchObject({ total: 1, won: 0, lost: 0, draw: 1, winRate: 0 });
    expect(summary.recent[0]?.judgeReason).toBe("tenant b only");
  });
});

async function signup(email: string): Promise<string> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "strong-pwd-12345" }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function tenantFor(email: string): Promise<number> {
  const [admin] = await db
    .select({ tenantId: admins.tenantId })
    .from(admins)
    .where(eq(admins.email, email))
    .limit(1);
  if (!admin) throw new Error(`admin not found: ${email}`);
  return admin.tenantId;
}

async function authReq(token: string, path: string): Promise<Response> {
  return await app.request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

type QualityRecord = {
  schemaVersion?: number;
  kind?: string;
  source?: string;
  match: {
    styleSlug?: string;
    personaSlug?: string;
    outcome?: string;
    skills?: string[];
    transcript?: unknown[];
    turns?: number | null;
    fabricationsCaught?: number;
    persisted?: boolean;
    judge: { outcome?: string; reason: string | null };
  };
};

type QualitySummaryResponse = {
  totals: {
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
    fabricationsCaught: number;
    avgTurns: number | null;
  };
  byStyle: Array<{
    styleSlug: string;
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
  }>;
  byPersona: Array<{
    personaSlug: string;
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
  }>;
  recent: Array<{
    styleSlug: string;
    personaSlug: string;
    outcome: string;
    judgeReason: string | null;
  }>;
};

function parseJsonl(text: string): QualityRecord[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
