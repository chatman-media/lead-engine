import {
  admins,
  applyAllMigrations,
  coachProposals,
  createIsolatedDb,
  pairwiseMatches,
  schema,
  selfPlayMatches,
  shadowEvaluations,
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
  const insertedSelfPlay = await db.insert(selfPlayMatches).values([
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
  ]).returning({
    id: selfPlayMatches.id,
    tenantId: selfPlayMatches.tenantId,
    styleSlug: selfPlayMatches.styleSlug,
  });

  const matchA = insertedSelfPlay.find(
    (row) => row.tenantId === tenantA && row.styleSlug === "style-a",
  );
  const matchB = insertedSelfPlay.find(
    (row) => row.tenantId === tenantA && row.styleSlug === "style-b",
  );
  const matchOther = insertedSelfPlay.find((row) => row.tenantId === tenantB);
  if (!matchA || !matchB || !matchOther) throw new Error("self-play fixture mismatch");

  await db.insert(pairwiseMatches).values([
    {
      tenantId: tenantA,
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      winner: "a",
      judgeReason: "A closed cleaner",
      matchAId: matchA.id,
      matchBId: matchB.id,
      eloAAfter: 1516,
      eloBAfter: 1484,
      createdAt: now + 5,
    },
    {
      tenantId: tenantA,
      styleASlug: "style-b",
      styleBSlug: "style-a",
      personaSlug: "price-sensitive",
      winner: "b",
      judgeReason: "B recovered better",
      matchAId: matchB.id,
      matchBId: matchA.id,
      eloAAfter: 1478,
      eloBAfter: 1522,
      createdAt: now - 20,
    },
    {
      tenantId: tenantB,
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      winner: "draw",
      judgeReason: "tenant b pairwise only",
      matchAId: matchOther.id,
      matchBId: null,
      eloAAfter: 1500,
      eloBAfter: 1500,
      createdAt: now,
    },
  ]);

  const insertedProposals = await db.insert(coachProposals).values([
    {
      tenantId: tenantA,
      styleSlug: "style-b",
      sampleSize: 8,
      personaFilter: "price-sensitive",
      summary: "Handle price objections earlier",
      editsJson: JSON.stringify({
        voice_tone: "warmer and specific",
        stage_guidance: { objection: "Anchor savings before quoting the price." },
      }),
      rationaleJson: JSON.stringify(["The candidate walked away after an unanchored price answer."]),
      rawOutput: '{"summary":"Handle price objections earlier"}',
      status: "pending",
      createdAt: now + 15,
    },
    {
      tenantId: tenantA,
      styleSlug: "style-a",
      sampleSize: 5,
      personaFilter: null,
      summary: "Tighten close on skeptical personas",
      editsJson: JSON.stringify({ hooks_add: [{ kind: "social_proof", text: "Recent peer result." }] }),
      rationaleJson: JSON.stringify(["Skeptical persona asked for proof before committing."]),
      rawOutput: null,
      status: "applied",
      createdAt: now - 25,
      decidedAt: now - 5,
    },
    {
      tenantId: tenantB,
      styleSlug: "style-a",
      sampleSize: 3,
      personaFilter: null,
      summary: "tenant b coach only",
      editsJson: JSON.stringify({ voice_tone: "tenant-b" }),
      rationaleJson: JSON.stringify(["tenant b rationale"]),
      status: "pending",
      createdAt: now,
    },
  ]).returning({
    id: coachProposals.id,
    tenantId: coachProposals.tenantId,
    summary: coachProposals.summary,
  });

  const proposalAPending = insertedProposals.find(
    (row) => row.tenantId === tenantA && row.summary === "Handle price objections earlier",
  );
  const proposalAApplied = insertedProposals.find(
    (row) => row.tenantId === tenantA && row.summary === "Tighten close on skeptical personas",
  );
  const proposalBOther = insertedProposals.find((row) => row.tenantId === tenantB);
  if (!proposalAPending || !proposalAApplied || !proposalBOther) {
    throw new Error("coach proposal fixture mismatch");
  }

  await db.insert(shadowEvaluations).values([
    {
      tenantId: tenantA,
      proposalId: proposalAPending.id,
      parentStyleSlug: "style-b",
      parentStyleId: 201,
      newStyleSlug: "style-b-coach-v2",
      newStyleId: 202,
      pairsPlanned: 4,
      pairsDone: 4,
      aWins: 1,
      bWins: 3,
      draws: 0,
      winRateLb: 0.62,
      status: "complete",
      decision: "keep",
      startedAt: now + 16,
      completedAt: now + 18,
    },
    {
      tenantId: tenantA,
      proposalId: proposalAApplied.id,
      parentStyleSlug: "style-a",
      parentStyleId: 101,
      newStyleSlug: "style-a-coach-v2",
      newStyleId: 102,
      pairsPlanned: 4,
      pairsDone: 2,
      aWins: 1,
      bWins: 0,
      draws: 1,
      winRateLb: null,
      status: "failed",
      decision: null,
      errorMessage: "judge unavailable",
      startedAt: now - 12,
      completedAt: null,
    },
    {
      tenantId: tenantB,
      proposalId: proposalBOther.id,
      parentStyleSlug: "style-a",
      parentStyleId: 301,
      newStyleSlug: "style-a-tenant-b-v2",
      newStyleId: 302,
      pairsPlanned: 2,
      pairsDone: 2,
      aWins: 2,
      bWins: 0,
      draws: 0,
      winRateLb: 0.05,
      status: "complete",
      decision: "rollback",
      startedAt: now,
      completedAt: now + 1,
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

  it("returns tenant-scoped pairwise summary", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/pairwise/summary");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PairwiseSummaryResponse;
    expect(body.totals).toMatchObject({
      total: 2,
      aWins: 1,
      bWins: 1,
      draws: 0,
      aWinRate: 50,
      bWinRate: 50,
    });
    expect(body.byPair[0]).toMatchObject({
      styleASlug: "style-a",
      styleBSlug: "style-b",
      total: 1,
      aWins: 1,
      aWinRate: 100,
    });
    expect(body.recent[0]).toMatchObject({
      styleASlug: "style-a",
      styleBSlug: "style-b",
      winner: "a",
      judgeReason: "A closed cleaner",
      eloAAfter: 1516,
      eloBAfter: 1484,
    });
    expect(JSON.stringify(body)).not.toContain("tenant b pairwise only");
  });

  it("returns tenant-scoped coach proposal and shadow summary", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/coach/summary");
    expect(res.status).toBe(200);

    const body = (await res.json()) as QualityCoachSummaryResponse;
    expect(body.totals.proposals).toMatchObject({
      total: 2,
      pending: 1,
      applied: 1,
      dismissed: 0,
    });
    expect(body.totals.shadows).toMatchObject({
      total: 2,
      complete: 1,
      failed: 1,
      keep: 1,
      rollback: 0,
    });
    expect(body.proposals[0]).toMatchObject({
      styleSlug: "style-b",
      sampleSize: 8,
      personaFilter: "price-sensitive",
      summary: "Handle price objections earlier",
      edits: {
        voice_tone: "warmer and specific",
        stage_guidance: { objection: "Anchor savings before quoting the price." },
      },
      rationale: ["The candidate walked away after an unanchored price answer."],
      status: "pending",
    });
    expect(body.shadows[0]).toMatchObject({
      parentStyleSlug: "style-b",
      newStyleSlug: "style-b-coach-v2",
      pairsPlanned: 4,
      pairsDone: 4,
      bWins: 3,
      winRateLb: 0.62,
      status: "complete",
      decision: "keep",
    });
    expect(JSON.stringify(body)).not.toContain("tenant b coach only");
  });

  it("updates coach proposal decision status without crossing tenants", async () => {
    if (!sql) return;
    const before = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    const pending = before.proposals.find((item) => item.status === "pending");
    const applied = before.proposals.find((item) => item.status === "applied");
    expect(pending).toBeTruthy();
    expect(applied).toBeTruthy();
    if (!pending || !applied) return;

    const crossTenant = await authJsonReq(
      tokenB,
      `/api/admin/quality/coach/proposals/${pending.id}/status`,
      { status: "dismissed" },
    );
    expect(crossTenant.status).toBe(404);

    const dismiss = await authJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${pending.id}/status`,
      { status: "dismissed" },
    );
    expect(dismiss.status).toBe(200);
    const dismissedBody = (await dismiss.json()) as QualityCoachProposalStatusResponse;
    expect(dismissedBody.proposal).toMatchObject({
      id: pending.id,
      status: "dismissed",
      decidedByAdminId: expect.any(Number),
    });
    expect(dismissedBody.proposal.decidedAt).toBeGreaterThan(0);

    const afterDismiss = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    expect(afterDismiss.totals.proposals).toMatchObject({
      total: 2,
      pending: 0,
      applied: 1,
      dismissed: 1,
    });

    const invalid = await authJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${pending.id}/status`,
      { status: "applied" },
    );
    expect(invalid.status).toBe(400);

    const appliedChange = await authJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${applied.id}/status`,
      { status: "dismissed" },
    );
    expect(appliedChange.status).toBe(409);

    const restore = await authJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${pending.id}/status`,
      { status: "pending" },
    );
    expect(restore.status).toBe(200);
    const restoredBody = (await restore.json()) as QualityCoachProposalStatusResponse;
    expect(restoredBody.proposal).toMatchObject({
      id: pending.id,
      status: "pending",
      decidedAt: null,
      decidedByAdminId: null,
    });
  });

  it("exports tenant-scoped pairwise matches as JSONL attachment", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/pairwise/export.jsonl");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toContain("pairwise-matches.jsonl");

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      kind: "pairwise_match",
      source: "admin-api",
      styleASlug: "style-a",
      styleBSlug: "style-b",
      winner: "a",
      reason: "A closed cleaner",
      persisted: true,
      elo: { aAfter: 1516, bAfter: 1484 },
      matchA: { styleSlug: "style-a", outcome: "won", persisted: true },
      matchB: { styleSlug: "style-b", outcome: "lost", persisted: true },
    });
    expect(records[0]?.matchA?.transcript).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("tenant b pairwise only");
  });

  it("filters pairwise exports and can omit transcripts", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      "/api/admin/quality/pairwise/export.jsonl?styleASlug=style-b&styleBSlug=style-a&personaSlug=price-sensitive&winner=b&includeTranscript=false",
    );
    expect(res.status).toBe(200);
    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "pairwise_match",
      styleASlug: "style-b",
      styleBSlug: "style-a",
      winner: "b",
    });
    expect(records[0]?.matchA?.transcript).toBeUndefined();
    expect(records[0]?.matchB?.transcript).toBeUndefined();
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
    expect(
      (await authReq(tokenA, "/api/admin/quality/pairwise/export.jsonl?winner=bad")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/pairwise/export.jsonl?limit=0")).status,
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

    const pairwiseRecords = parseJsonl(
      await (await authReq(tokenB, "/api/admin/quality/pairwise/export.jsonl")).text(),
    );
    expect(pairwiseRecords).toHaveLength(1);
    expect(pairwiseRecords[0]?.reason).toBe("tenant b pairwise only");

    const pairwiseSummary = (await (
      await authReq(tokenB, "/api/admin/quality/pairwise/summary")
    ).json()) as PairwiseSummaryResponse;
    expect(pairwiseSummary.totals).toMatchObject({
      total: 1,
      aWins: 0,
      bWins: 0,
      draws: 1,
    });

    const coachSummary = (await (
      await authReq(tokenB, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    expect(coachSummary.totals.proposals).toMatchObject({ total: 1, pending: 1 });
    expect(coachSummary.totals.shadows).toMatchObject({ total: 1, complete: 1, rollback: 1 });
    expect(coachSummary.proposals[0]?.summary).toBe("tenant b coach only");
    expect(coachSummary.shadows[0]?.decision).toBe("rollback");
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

async function authJsonReq(token: string, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  pairwiseId?: number;
  styleASlug?: string;
  styleBSlug?: string;
  winner?: string;
  reason?: string;
  persisted?: boolean;
  elo?: { aAfter?: number; bAfter?: number };
  matchA?: {
    styleSlug?: string;
    outcome?: string;
    persisted?: boolean;
    transcript?: unknown[];
  };
  matchB?: {
    styleSlug?: string;
    outcome?: string;
    persisted?: boolean;
    transcript?: unknown[];
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

type PairwiseSummaryResponse = {
  totals: {
    total: number;
    aWins: number;
    bWins: number;
    draws: number;
    aWinRate: number;
    bWinRate: number;
  };
  byPair: Array<{
    styleASlug: string;
    styleBSlug: string;
    total: number;
    aWins: number;
    bWins: number;
    draws: number;
    aWinRate: number;
    bWinRate: number;
  }>;
  recent: Array<{
    styleASlug: string;
    styleBSlug: string;
    winner: string;
    judgeReason: string | null;
    eloAAfter: number;
    eloBAfter: number;
  }>;
};

type QualityCoachSummaryResponse = {
  totals: {
    proposals: {
      total: number;
      pending: number;
      applied: number;
      dismissed: number;
    };
    shadows: {
      total: number;
      running: number;
      complete: number;
      failed: number;
      keep: number;
      rollback: number;
      inconclusive: number;
    };
  };
  proposals: Array<{
    id: number;
    styleSlug: string;
    sampleSize: number;
    personaFilter: string | null;
    summary: string;
    editsJson: string;
    rationaleJson: string;
    rawOutput: string | null;
    edits: unknown;
    rationale: string[];
    status: string;
    createdAt: number;
    decidedAt: number | null;
    decidedByAdminId: number | null;
  }>;
  shadows: Array<{
    parentStyleSlug: string;
    newStyleSlug: string;
    pairsPlanned: number;
    pairsDone: number;
    bWins: number;
    winRateLb: number | null;
    status: string;
    decision: string | null;
  }>;
};

type QualityCoachProposalStatusResponse = {
  ok: boolean;
  proposal: QualityCoachSummaryResponse["proposals"][number];
};

function parseJsonl(text: string): QualityRecord[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
