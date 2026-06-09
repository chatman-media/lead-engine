import {
  agentToolCalls,
  admins,
  applyAllMigrations,
  coachProposals,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  pairwiseMatches,
  schema,
  selfPlayMatches,
  shadowEvaluations,
  skillOutcomes,
  skills as skillsTable,
  styleRatings,
  styleSkills,
  styles as stylesTable,
  tryConnectToPg,
} from "@chatman-media/storage";
import type { ChatClient, ChatCompletionOpts, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import type { IKbStore } from "@chatman-media/kb";
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
let toolConversationA = 0;
let toolCallOrderA = 0;
const reloads: number[] = [];
const salesReplies: string[] = [];
const candidateReplies: string[] = [];
const judgeReplies: string[] = [];
const salesCalls: ChatMessage[][] = [];

const salesChat: ChatClient = {
  complete: async (messages: ChatMessage[], _opts?: ChatCompletionOpts) => {
    salesCalls.push(messages);
    return salesReplies.shift() ?? "расскажу коротко";
  },
};
const candidateChat: ChatClient = {
  complete: async () => candidateReplies.shift() ?? "ок, давай оформляться",
};
const judgeChat: ChatClient = {
  complete: async () => judgeReplies.shift() ?? '{"outcome":"draw","reason":"no queued verdict"}',
};
const fakeEmbedder: EmbeddingClient = {
  dim: 1536,
  embed: async (inputs: string[]) => inputs.map(() => Array.from({ length: 1536 }, () => 0)),
};
const fakeKb = {
  search: async () => [],
  hybridSearch: async () => [],
  prioritySearch: async () => [],
} as unknown as IKbStore;

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
  reloads.length = 0;
  app.route(
    "/",
    makeAdminQualityRoutes({
      db,
      onReload: (tenantId) => reloads.push(tenantId),
      resolveChat: () => salesChat,
      resolveCandidateChat: () => candidateChat,
      resolveJudgeChat: () => judgeChat,
      resolveEmbedder: () => fakeEmbedder,
      resolveKb: () => fakeKb,
    }),
  );

  tokenA = await signup("quality-a@demo.io");
  tokenB = await signup("quality-b@demo.io");
  tenantA = await tenantFor("quality-a@demo.io");
  tenantB = await tenantFor("quality-b@demo.io");

  const now = Math.floor(Date.now() / 1000);
  const insertedStyles = await db.insert(stylesTable).values([
    {
      tenantId: tenantA,
      slug: "style-a",
      displayName: "Style A",
      configJson: JSON.stringify(styleConfig("style-a", "Style A", "direct")),
      isActive: true,
      version: 1,
      createdAt: now - 100,
    },
    {
      tenantId: tenantA,
      slug: "style-b",
      displayName: "Style B",
      configJson: JSON.stringify(styleConfig("style-b", "Style B", "neutral")),
      isActive: true,
      version: 1,
      createdAt: now - 90,
    },
  ]).returning({ id: stylesTable.id, slug: stylesTable.slug });

  const styleA = insertedStyles.find((style) => style.slug === "style-a");
  const styleB = insertedStyles.find((style) => style.slug === "style-b");
  if (!styleA || !styleB) throw new Error("style fixture mismatch");

  const [skill] = await db
    .insert(skillsTable)
    .values({
      tenantId: tenantA,
      slug: "mirroring",
      family: "rapport",
      displayName: "Mirroring",
      description: "Repeat the candidate concern in their own words.",
      promptFragment: "Mirror the candidate concern before answering.",
      applicableStagesJson: JSON.stringify(["qualify", "offer"]),
      intent: "quality_lab",
      isEnabled: true,
      createdAt: now - 80,
      updatedAt: now - 80,
    })
    .returning({ id: skillsTable.id });
  if (!skill) throw new Error("skill fixture mismatch");
  await db.insert(styleSkills).values([
    { tenantId: tenantA, styleId: styleA.id, skillId: skill.id },
    { tenantId: tenantA, styleId: styleB.id, skillId: skill.id },
  ]);

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

  const [toolContactA] = await db
    .insert(contacts)
    .values({
      tenantId: tenantA,
      displayName: "Tool Trace A",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: contacts.id });
  const [toolContactB] = await db
    .insert(contacts)
    .values({
      tenantId: tenantB,
      displayName: "Tool Trace B",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: contacts.id });
  if (!toolContactA || !toolContactB) throw new Error("tool contact fixture mismatch");

  const [toolConvA] = await db
    .insert(conversations)
    .values({
      tenantId: tenantA,
      userId: toolContactA.id,
      source: "bot",
      mode: "ai",
      createdAt: now,
      lastMessageAt: now,
    })
    .returning({ id: conversations.id });
  const [toolConvB] = await db
    .insert(conversations)
    .values({
      tenantId: tenantB,
      userId: toolContactB.id,
      source: "bot",
      mode: "ai",
      createdAt: now,
      lastMessageAt: now,
    })
    .returning({ id: conversations.id });
  if (!toolConvA || !toolConvB) throw new Error("tool conversation fixture mismatch");
  toolConversationA = toolConvA.id;

  const insertedToolCalls = await db.insert(agentToolCalls).values([
    {
      tenantId: tenantA,
      conversationId: toolConvA.id,
      contactId: toolContactA.id,
      source: "rag_reply",
      toolName: "compute_exchange_quote",
      argsJson: JSON.stringify({ asset: "USDT", amount: 100 }),
      resultJson: JSON.stringify({ ok: true, amountToThb: 3150 }),
      error: false,
      cycle: 0,
      toolCallIndex: 0,
      createdAt: now + 30,
    },
    {
      tenantId: tenantA,
      conversationId: toolConvA.id,
      contactId: toolContactA.id,
      source: "llm_reply",
      toolName: "create_exchange_order",
      argsJson: JSON.stringify({ quoteId: "q1" }),
      resultJson: JSON.stringify({ error: "needs verification" }),
      error: true,
      cycle: 1,
      toolCallIndex: 1,
      createdAt: now + 31,
    },
    {
      tenantId: tenantB,
      conversationId: toolConvB.id,
      contactId: toolContactB.id,
      source: "rag_reply",
      toolName: "compute_exchange_quote",
      argsJson: JSON.stringify({ asset: "USDT", amount: 999 }),
      resultJson: JSON.stringify({ ok: true, amountToThb: 1 }),
      error: false,
      cycle: 0,
      toolCallIndex: 0,
      createdAt: now + 32,
    },
  ]).returning({
    id: agentToolCalls.id,
    tenantId: agentToolCalls.tenantId,
    toolName: agentToolCalls.toolName,
  });
  const orderToolCall = insertedToolCalls.find(
    (row) => row.tenantId === tenantA && row.toolName === "create_exchange_order",
  );
  if (!orderToolCall) throw new Error("tool call fixture mismatch");
  toolCallOrderA = orderToolCall.id;
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

  it("returns tenant-scoped agentic tool-call traces with filters", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      `/api/admin/quality/tool-calls?conversationId=${toolConversationA}&limit=10`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityToolCallsResponse;
    expect(body.items.map((item) => item.toolName)).toEqual([
      "create_exchange_order",
      "compute_exchange_quote",
    ]);
    expect(body.items[0]).toMatchObject({
      source: "llm_reply",
      error: true,
      args: { quoteId: "q1" },
      result: { error: "needs verification" },
      cycle: 1,
      toolCallIndex: 1,
    });
    expect(JSON.stringify(body)).not.toContain("999");

    const filtered = (await (
      await authReq(
        tokenA,
        `/api/admin/quality/tool-calls?conversationId=${toolConversationA}&toolName=compute_exchange_quote&error=false`,
      )
    ).json()) as QualityToolCallsResponse;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.source).toBe("rag_reply");

    const crossTenant = (await (
      await authReq(
        tokenB,
        `/api/admin/quality/tool-calls?conversationId=${toolConversationA}`,
      )
    ).json()) as QualityToolCallsResponse;
    expect(crossTenant.items).toEqual([]);
  });

  it("validates tool-call query params", async () => {
    if (!sql) return;
    expect((await authReq(tokenA, "/api/admin/quality/tool-calls?limit=0")).status).toBe(400);
    expect((await authReq(tokenA, "/api/admin/quality/tool-calls?source=bad")).status).toBe(400);
    expect((await authReq(tokenA, "/api/admin/quality/tool-calls?error=maybe")).status).toBe(400);
  });

  it("records tenant-scoped feedback labels for tool-call traces", async () => {
    if (!sql) return;
    const created = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`,
      { label: "bad_args", note: "quote id should be verified before order creation" },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as QualityToolCallFeedbackCreateResponse;
    expect(createdBody.feedback).toMatchObject({
      toolCallId: toolCallOrderA,
      label: "bad_args",
      note: "quote id should be verified before order creation",
    });

    const second = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`,
      { label: "wrong_tool", note: "" },
    );
    expect(second.status).toBe(201);

    const list = await authReq(
      tokenA,
      `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`,
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as QualityToolCallFeedbackListResponse;
    expect(listBody.items.map((item) => item.label)).toEqual(["wrong_tool", "bad_args"]);
    expect(listBody.items[0]?.note).toBeNull();

    expect(
      (await authReq(tokenB, `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`)).status,
    ).toBe(404);
    expect(
      (
        await authPostJsonReq(tokenB, `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`, {
          label: "good_reply",
        })
      ).status,
    ).toBe(404);
  });

  it("summarizes tool-call feedback with filters and tenant isolation", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityToolCallFeedbackSummaryResponse;

    expect(body.totals).toMatchObject({
      total: 2,
      wrongTool: 1,
      badArgs: 1,
      errorCount: 2,
    });
    expect(body.byLabel.find((row) => row.label === "bad_args")?.total).toBe(1);
    expect(body.byLabel.find((row) => row.label === "missing_tool")?.total).toBe(0);
    expect(body.byTool).toEqual([
      expect.objectContaining({
        toolName: "create_exchange_order",
        total: 2,
        wrongTool: 1,
        badArgs: 1,
        errorCount: 2,
      }),
    ]);
    expect(body.bySource).toEqual([
      expect.objectContaining({ source: "llm_reply", total: 2 }),
    ]);
    expect(body.byError).toEqual([expect.objectContaining({ error: true, total: 2 })]);
    expect(body.recent.map((item) => item.feedback.label)).toEqual(["wrong_tool", "bad_args"]);
    expect(body.recent[0]?.toolCall).toMatchObject({
      id: toolCallOrderA,
      toolName: "create_exchange_order",
      error: true,
      args: { quoteId: "q1" },
      result: { error: "needs verification" },
    });
    expect(JSON.stringify(body)).not.toContain("999");

    const filtered = (await (
      await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?label=bad_args")
    ).json()) as QualityToolCallFeedbackSummaryResponse;
    expect(filtered.totals).toMatchObject({ total: 1, badArgs: 1, wrongTool: 0 });
    expect(filtered.recent).toHaveLength(1);

    const sourceFiltered = (await (
      await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?source=rag_reply")
    ).json()) as QualityToolCallFeedbackSummaryResponse;
    expect(sourceFiltered.totals.total).toBe(0);

    const crossTenant = (await (
      await authReq(tokenB, "/api/admin/quality/tool-call-feedback/summary")
    ).json()) as QualityToolCallFeedbackSummaryResponse;
    expect(crossTenant.totals.total).toBe(0);
    expect(crossTenant.recent).toEqual([]);
  });

  it("exports filtered tool-call feedback JSONL", async () => {
    if (!sql) return;
    const res = await authReq(
      tokenA,
      "/api/admin/quality/tool-call-feedback/export.jsonl?label=bad_args&limit=10",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toContain("tool-call-feedback.jsonl");

    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] ?? "{}") as QualityToolCallFeedbackExportRow;
    expect(row).toMatchObject({
      toolCallId: toolCallOrderA,
      label: "bad_args",
      note: "quote id should be verified before order creation",
      source: "llm_reply",
      toolName: "create_exchange_order",
      args: { quoteId: "q1" },
      result: { error: "needs verification" },
      error: true,
    });
    expect(text).not.toContain("999");
  });

  it("generates actionable tool-call improvement proposals from feedback clusters", async () => {
    if (!sql) return;
    const missingTool = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`,
      { label: "missing_tool", note: "need an explicit verification handoff tool" },
    );
    expect(missingTool.status).toBe(201);

    const res = await authReq(tokenA, "/api/admin/quality/tool-call-feedback/proposals?limit=20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityToolCallFeedbackProposalsResponse;
    expect(body.items.map((item) => item.kind).sort()).toEqual([
      "routing_prompt_fix",
      "schema_fix",
      "tool_candidate",
    ]);
    expect(body.items).toContainEqual(
      expect.objectContaining({
        kind: "schema_fix",
        label: "bad_args",
        toolName: "create_exchange_order",
        source: "llm_reply",
        feedbackCount: 1,
        errorCount: 1,
        severity: "medium",
      }),
    );
    expect(body.items).toContainEqual(
      expect.objectContaining({
        kind: "routing_prompt_fix",
        label: "wrong_tool",
        actionItems: expect.arrayContaining([
          expect.stringContaining("should and should not be selected"),
        ]),
      }),
    );
    const missingProposal = body.items.find((item) => item.kind === "tool_candidate");
    expect(missingProposal?.rationale.join(" ")).toContain("verification handoff tool");
    expect(missingProposal?.examples[0]?.toolCall.args).toEqual({ quoteId: "q1" });
    expect(JSON.stringify(body)).not.toContain("999");

    const filtered = (await (
      await authReq(tokenA, "/api/admin/quality/tool-call-feedback/proposals?label=bad_args")
    ).json()) as QualityToolCallFeedbackProposalsResponse;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.kind).toBe("schema_fix");

    const nonActionable = (await (
      await authReq(tokenA, "/api/admin/quality/tool-call-feedback/proposals?label=good_reply")
    ).json()) as QualityToolCallFeedbackProposalsResponse;
    expect(nonActionable.items).toEqual([]);

    const crossTenant = (await (
      await authReq(tokenB, "/api/admin/quality/tool-call-feedback/proposals")
    ).json()) as QualityToolCallFeedbackProposalsResponse;
    expect(crossTenant.items).toEqual([]);
  });

  it("validates tool-call feedback analytics query params", async () => {
    if (!sql) return;
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?limit=0")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?source=bad")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?label=bad")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/summary?error=maybe")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/export.jsonl?limit=0")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/export.jsonl?toolName="))
        .status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/proposals?source=bad")).status,
    ).toBe(400);
    expect(
      (await authReq(tokenA, "/api/admin/quality/tool-call-feedback/proposals?limit=0")).status,
    ).toBe(400);
  });

  it("validates tool-call feedback payloads", async () => {
    if (!sql) return;
    expect(
      (await authPostJsonReq(tokenA, "/api/admin/quality/tool-calls/0/feedback", {
        label: "good_reply",
      })).status,
    ).toBe(400);
    expect(
      (await authPostJsonReq(tokenA, `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`, {
        label: "unknown",
      })).status,
    ).toBe(400);
    expect(
      (await authPostJsonReq(tokenA, `/api/admin/quality/tool-calls/${toolCallOrderA}/feedback`, {
        label: "good_reply",
        note: 123,
      })).status,
    ).toBe(400);
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

  it("returns tenant-scoped self-play match detail", async () => {
    if (!sql) return;
    const summary = (await (
      await authReq(tokenA, "/api/admin/quality/self-play/summary")
    ).json()) as QualitySummaryResponse;
    const matchId = summary.recent[0]?.id;
    expect(matchId).toBeGreaterThan(0);
    if (!matchId) return;

    const crossTenant = await authReq(tokenB, `/api/admin/quality/self-play/matches/${matchId}`);
    expect(crossTenant.status).toBe(404);

    const res = await authReq(tokenA, `/api/admin/quality/self-play/matches/${matchId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualitySelfPlayDetailResponse;
    expect(body.match).toMatchObject({
      matchId,
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "won",
      verdict: { outcome: "won", reason: "candidate committed" },
      skillsAttributed: ["mirroring"],
      fabricationsCaught: 1,
      persisted: true,
    });
    expect(body.match.transcript).toEqual([
      { role: "candidate", text: "привет" },
      { role: "salesperson", text: "расскажу коротко" },
    ]);
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

  it("returns tenant-scoped pairwise match detail with transcripts", async () => {
    if (!sql) return;
    const summary = (await (
      await authReq(tokenA, "/api/admin/quality/pairwise/summary")
    ).json()) as PairwiseSummaryResponse;
    const pairwiseId = summary.recent[0]?.id;
    expect(pairwiseId).toBeGreaterThan(0);
    if (!pairwiseId) return;

    const crossTenant = await authReq(tokenB, `/api/admin/quality/pairwise/matches/${pairwiseId}`);
    expect(crossTenant.status).toBe(404);

    const res = await authReq(tokenA, `/api/admin/quality/pairwise/matches/${pairwiseId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityPairwiseDetailResponse;
    expect(body.pairwise).toMatchObject({
      pairwiseId,
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      verdict: { winner: "a", reason: "A closed cleaner" },
      eloAAfter: 1516,
      eloBAfter: 1484,
      persisted: true,
    });
    expect(body.pairwise.matchA.transcript).toHaveLength(2);
    expect(body.pairwise.matchB.transcript).toHaveLength(1);
    expect(body.pairwise.matchA.persisted).toBe(true);
    expect(body.pairwise.matchB.persisted).toBe(true);
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

  it("generates a tenant-scoped coach proposal from self-play failures", async () => {
    if (!sql) return;
    resetQualityQueues();
    salesReplies.push(
      JSON.stringify({
        summary: "Coach spotted a price objection gap",
        edits: {
          voice_tone: "warmer and more concrete",
          skills_attach: ["mirroring"],
        },
        rationale: ["The candidate objected to price and did not get a concrete value anchor."],
      }),
    );

    const crossTenant = await authPostJsonReq(tokenB, "/api/admin/quality/coach/proposals", {
      styleSlug: "style-b",
      sampleSize: 3,
    });
    expect(crossTenant.status).toBe(404);

    const res = await authPostJsonReq(tokenA, "/api/admin/quality/coach/proposals", {
      styleSlug: "style-b",
      sampleSize: 3,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityCoachProposalGenerateResponse;
    expect(body.proposal).toMatchObject({
      styleSlug: "style-b",
      sampleSize: 3,
      personaFilter: null,
      summary: "Coach spotted a price objection gap",
      status: "pending",
      edits: {
        voice_tone: "warmer and more concrete",
        skills_attach: ["mirroring"],
      },
      rationale: ["The candidate objected to price and did not get a concrete value anchor."],
    });

    const prompt = salesCalls.at(-1)?.map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain("currently_attached_skills");
    expect(prompt).toContain("mirroring");
    expect(prompt).toContain("дорого");
    expect(prompt).not.toContain("tenant b only");

    const summary = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    expect(summary.proposals.some((item) => item.id === body.proposal.id)).toBe(true);

    await db.delete(coachProposals).where(eq(coachProposals.id, body.proposal.id));
  });

  it("returns 503 when coach proposal generation has no chat LLM", async () => {
    if (!sql) return;
    const noChatApp = new Hono();
    noChatApp.route("/", makeAuthRoutes({ db: db as never, secret: SECRET }));
    noChatApp.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    noChatApp.route("/", makeAdminQualityRoutes({ db }));

    const res = await noChatApp.request("/api/admin/quality/coach/proposals", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ styleSlug: "style-b" }),
    });
    expect(res.status).toBe(503);
  });

  it("generates a no-op coach proposal when a style has no lost or draw matches", async () => {
    if (!sql) return;
    resetQualityQueues();
    const beforeCalls = salesCalls.length;

    const res = await authPostJsonReq(tokenA, "/api/admin/quality/coach/proposals", {
      styleSlug: "style-a",
      sampleSize: 4,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityCoachProposalGenerateResponse;
    expect(body.proposal).toMatchObject({
      styleSlug: "style-a",
      sampleSize: 4,
      personaFilter: null,
      summary: "No lost or draw matches found for this style — nothing to coach on.",
      edits: {},
      rationale: [],
      status: "pending",
    });
    expect(salesCalls.length).toBe(beforeCalls);

    await db.delete(coachProposals).where(eq(coachProposals.id, body.proposal.id));
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

  it("applies a pending coach proposal as an inactive derived style", async () => {
    if (!sql) return;
    const before = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    const pending = before.proposals.find(
      (item) => item.summary === "Handle price objections earlier",
    );
    expect(pending).toBeTruthy();
    if (!pending) return;

    const crossTenant = await authPostReq(
      tokenB,
      `/api/admin/quality/coach/proposals/${pending.id}/apply`,
    );
    expect(crossTenant.status).toBe(404);

    const apply = await authPostReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${pending.id}/apply`,
    );
    expect(apply.status).toBe(200);
    const body = (await apply.json()) as QualityCoachProposalApplyResponse;
    expect(body.proposal).toMatchObject({
      id: pending.id,
      status: "applied",
      decidedByAdminId: expect.any(Number),
    });
    expect(body.proposal.decidedAt).toBeGreaterThan(0);
    expect(body.style).toMatchObject({
      tenantId: tenantA,
      slug: `style-b-coach-${pending.id}`,
      displayName: `Style B Coach ${pending.id}`,
      isActive: false,
      version: 1,
    });
    expect(body.style.parentId).toBeGreaterThan(0);

    const [storedStyle] = await db
      .select()
      .from(stylesTable)
      .where(eq(stylesTable.id, body.style.id))
      .limit(1);
    expect(storedStyle).toBeTruthy();
    const config = JSON.parse(storedStyle?.configJson ?? "{}") as {
      slug?: string;
      voice?: { tone?: string };
      stages?: { objection?: { guidance?: string } };
    };
    expect(config.slug).toBe(`style-b-coach-${pending.id}`);
    expect(config.voice?.tone).toBe("warmer and specific");
    expect(config.stages?.objection?.guidance).toBe(
      "Anchor savings before quoting the price.",
    );
    expect(reloads).toContain(tenantA);

    const after = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    expect(after.totals.proposals).toMatchObject({
      total: 2,
      pending: 0,
      applied: 2,
      dismissed: 0,
    });

    const repeat = await authPostReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${pending.id}/apply`,
    );
    expect(repeat.status).toBe(409);
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

  it("creates a tenant-scoped shadow evaluation from existing pairwise matches", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const slugSuffix = `shadow-${now}`;
    const [parentStyle] = await db
      .insert(stylesTable)
      .values({
        tenantId: tenantA,
        slug: `style-parent-${slugSuffix}`,
        displayName: "Style Parent Shadow",
        configJson: JSON.stringify(
          styleConfig(`style-parent-${slugSuffix}`, "Style Parent Shadow", "neutral"),
        ),
        isActive: true,
        version: 1,
        createdAt: now,
      })
      .returning({ id: stylesTable.id, slug: stylesTable.slug });
    expect(parentStyle).toBeTruthy();
    if (!parentStyle) return;

    const [candidateStyle] = await db
      .insert(stylesTable)
      .values({
        tenantId: tenantA,
        slug: `style-candidate-${slugSuffix}`,
        displayName: "Style Candidate Shadow",
        configJson: JSON.stringify(
          styleConfig(`style-candidate-${slugSuffix}`, "Style Candidate Shadow", "warmer"),
        ),
        isActive: false,
        version: 1,
        parentId: parentStyle.id,
        createdAt: now + 1,
      })
      .returning({ id: stylesTable.id, slug: stylesTable.slug });
    expect(candidateStyle).toBeTruthy();
    if (!candidateStyle) return;

    const [proposal] = await db
      .insert(coachProposals)
      .values({
        tenantId: tenantA,
        styleSlug: parentStyle.slug,
        sampleSize: 10,
        personaFilter: null,
        summary: "Shadow eval candidate",
        editsJson: JSON.stringify({ voice_tone: "warmer" }),
        rationaleJson: JSON.stringify(["candidate won recent pairwise checks"]),
        status: "applied",
        createdAt: now + 2,
        decidedAt: now + 2,
      })
      .returning({ id: coachProposals.id });
    expect(proposal).toBeTruthy();
    if (!proposal) return;

    const emptyPreviewRes = await authReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-preview?limit=10`,
    );
    expect(emptyPreviewRes.status).toBe(200);
    const emptyPreview = (await emptyPreviewRes.json()) as QualityCoachShadowPreviewResponse;
    expect(emptyPreview.preview).toMatchObject({
      ready: false,
      proposalId: proposal.id,
      parentStyle: {
        id: parentStyle.id,
        slug: parentStyle.slug,
      },
      candidateStyle: {
        id: candidateStyle.id,
        slug: candidateStyle.slug,
        parentId: parentStyle.id,
      },
      pairwise: {
        limit: 10,
        total: 0,
        aWins: 0,
        bWins: 0,
        draws: 0,
        bWinsAdjusted: 0,
        winRateLb: null,
        decision: null,
        recentIds: [],
      },
      missing: {
        reason: "no_pairwise",
        nextAction: "run_shadow_eval",
        styleASlug: parentStyle.slug,
        styleBSlug: candidateStyle.slug,
      },
    });

    await db.insert(pairwiseMatches).values(
      Array.from({ length: 10 }, (_, index) => ({
        tenantId: tenantA,
        styleASlug: index % 2 === 0 ? parentStyle.slug : candidateStyle.slug,
        styleBSlug: index % 2 === 0 ? candidateStyle.slug : parentStyle.slug,
        personaSlug: `shadow-persona-${index}`,
        winner: index % 2 === 0 ? "b" : "a",
        judgeReason: "candidate style won",
        matchAId: null,
        matchBId: null,
        eloAAfter: 1500 - index,
        eloBAfter: 1500 + index,
        createdAt: now + 10 + index,
      })),
    );

    const previewRes = await authReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-preview?limit=10`,
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as QualityCoachShadowPreviewResponse;
    expect(preview.preview).toMatchObject({
      ready: true,
      proposalId: proposal.id,
      parentStyle: {
        id: parentStyle.id,
        slug: parentStyle.slug,
      },
      candidateStyle: {
        id: candidateStyle.id,
        slug: candidateStyle.slug,
        parentId: parentStyle.id,
      },
      pairwise: {
        limit: 10,
        total: 10,
        aWins: 0,
        bWins: 10,
        draws: 0,
        bWinsAdjusted: 10,
        decision: "keep",
      },
      missing: null,
    });
    expect(preview.preview.pairwise.recentIds).toHaveLength(10);
    expect(preview.preview.pairwise.winRateLb).toBeGreaterThan(0.55);

    const crossTenant = await authPostJsonReq(
      tokenB,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-evaluations`,
      { pairsPlanned: 12 },
    );
    expect(crossTenant.status).toBe(404);

    const res = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-evaluations`,
      { pairsPlanned: 12, limit: 10 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityCoachShadowCreateResponse;
    expect(body.shadow).toMatchObject({
      proposalId: proposal.id,
      parentStyleSlug: parentStyle.slug,
      parentStyleId: parentStyle.id,
      newStyleSlug: candidateStyle.slug,
      newStyleId: candidateStyle.id,
      pairsPlanned: 10,
      pairsDone: 10,
      aWins: 0,
      bWins: 10,
      draws: 0,
      status: "complete",
      decision: "keep",
    });
    expect(body.shadow.winRateLb).toBeGreaterThan(0.55);
    expect(body.shadow.completedAt).toBeGreaterThanOrEqual(body.shadow.startedAt);

    const summary = (await (
      await authReq(tokenA, "/api/admin/quality/coach/summary")
    ).json()) as QualityCoachSummaryResponse;
    expect(summary.shadows.some((item) => item.newStyleSlug === candidateStyle.slug)).toBe(true);
  });

  it("starts and completes a background shadow evaluation when pairwise coverage is missing", async () => {
    if (!sql) return;
    resetQualityQueues();
    const now = Math.floor(Date.now() / 1000);
    const slugSuffix = `shadow-run-${now}`;
    const [parentStyle] = await db
      .insert(stylesTable)
      .values({
        tenantId: tenantA,
        slug: `style-parent-${slugSuffix}`,
        displayName: "Style Parent Background",
        configJson: JSON.stringify(
          styleConfig(`style-parent-${slugSuffix}`, "Style Parent Background", "neutral"),
        ),
        isActive: true,
        version: 1,
        createdAt: now,
      })
      .returning({ id: stylesTable.id, slug: stylesTable.slug });
    expect(parentStyle).toBeTruthy();
    if (!parentStyle) return;

    const [candidateStyle] = await db
      .insert(stylesTable)
      .values({
        tenantId: tenantA,
        slug: `style-candidate-${slugSuffix}`,
        displayName: "Style Candidate Background",
        configJson: JSON.stringify(
          styleConfig(`style-candidate-${slugSuffix}`, "Style Candidate Background", "warmer"),
        ),
        isActive: false,
        version: 1,
        parentId: parentStyle.id,
        createdAt: now + 1,
      })
      .returning({ id: stylesTable.id, slug: stylesTable.slug });
    expect(candidateStyle).toBeTruthy();
    if (!candidateStyle) return;

    const [proposal] = await db
      .insert(coachProposals)
      .values({
        tenantId: tenantA,
        styleSlug: parentStyle.slug,
        sampleSize: 4,
        personaFilter: null,
        summary: "Run fresh shadow eval",
        editsJson: JSON.stringify({ voice_tone: "warmer" }),
        rationaleJson: JSON.stringify(["Needs fresh pairwise coverage."]),
        status: "applied",
        createdAt: now + 2,
        decidedAt: now + 2,
      })
      .returning({ id: coachProposals.id });
    expect(proposal).toBeTruthy();
    if (!proposal) return;

    const invalid = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-evaluations/run`,
      { personas: [] },
    );
    expect(invalid.status).toBe(400);

    const crossTenant = await authPostJsonReq(
      tokenB,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-evaluations/run`,
      { personas: ["skeptic-anya"], runs: 1, maxTurns: 1 },
    );
    expect(crossTenant.status).toBe(404);

    salesReplies.push(
      "A: договор до вылета и сопровождение, можно начать с анкеты",
      "B: давай оформим анкету сейчас, я покажу договор и условия",
    );
    candidateReplies.push("ок, давай анкету", "ок, давай анкету");
    judgeReplies.push(
      '{"outcome":"draw","reason":"A did not clearly improve"}',
      '{"outcome":"won","reason":"B closed the next step"}',
      '{"winner":"b","reason":"B gave a clearer next step"}',
    );

    const res = await authPostJsonReq(
      tokenA,
      `/api/admin/quality/coach/proposals/${proposal.id}/shadow-evaluations/run`,
      { personas: ["skeptic-anya"], runs: 1, maxTurns: 1, reflect: false },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as QualityCoachShadowCreateResponse;
    expect(body.shadow).toMatchObject({
      proposalId: proposal.id,
      parentStyleSlug: parentStyle.slug,
      parentStyleId: parentStyle.id,
      newStyleSlug: candidateStyle.slug,
      newStyleId: candidateStyle.id,
      pairsPlanned: 1,
      pairsDone: 0,
      aWins: 0,
      bWins: 0,
      draws: 0,
      status: "running",
      decision: null,
    });

    const completed = await waitForShadowEvaluation(body.shadow.id);
    expect(completed).toMatchObject({
      tenantId: tenantA,
      proposalId: proposal.id,
      status: "complete",
      pairsPlanned: 1,
      pairsDone: 1,
      aWins: 0,
      bWins: 1,
      draws: 0,
    });
    expect(completed.winRateLb).toBeGreaterThan(0);
    expect(completed.completedAt).toBeGreaterThanOrEqual(completed.startedAt);

    const [storedPairwise] = await db
      .select()
      .from(pairwiseMatches)
      .where(eq(pairwiseMatches.styleASlug, parentStyle.slug))
      .limit(1);
    expect(storedPairwise).toMatchObject({
      tenantId: tenantA,
      styleASlug: parentStyle.slug,
      styleBSlug: candidateStyle.slug,
      personaSlug: "skeptic-anya",
      winner: "b",
    });
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

  it("returns quality runner options", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/quality/run-options");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      styles: Array<{ id: number; slug: string; displayName: string }>;
      personas: Array<{ slug: string; displayName: string; summary: string }>;
    };
    expect(body.styles.map((style) => style.slug)).toContain("style-a");
    expect(body.styles.map((style) => style.slug)).toContain("style-b");
    expect(body.personas.map((persona) => persona.slug)).toContain("skeptic-anya");
  });

  it("runs and persists a tenant-scoped self-play match", async () => {
    if (!sql) return;
    resetQualityQueues();
    salesReplies.push("не развод: договор до вылета, паспорт у тебя. давай анкету?");
    candidateReplies.push("ок, я согласна, давай оформляться");
    judgeReplies.push('["mirroring"]', '{"outcome":"won","reason":"runner candidate committed"}');

    const res = await authPostJsonReq(tokenA, "/api/admin/quality/self-play/matches", {
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      maxTurns: 1,
      reflect: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualitySelfPlayRunResponse;
    expect(body.match).toMatchObject({
      styleSlug: "style-a",
      personaSlug: "skeptic-anya",
      outcome: "won",
      skillsAttributed: ["mirroring"],
      verdict: { outcome: "won", reason: "runner candidate committed" },
      persisted: true,
    });
    expect(body.match.matchId).toBeGreaterThan(0);
    expect(body.match.leadId).toBeGreaterThan(0);
    expect(body.match.transcript.map((turn) => turn.role)).toEqual([
      "candidate",
      "salesperson",
      "candidate",
    ]);

    const crossTenant = await authReq(
      tokenB,
      `/api/admin/quality/self-play/matches/${body.match.matchId}`,
    );
    expect(crossTenant.status).toBe(404);

    const [storedMatch] = await db
      .select({
        tenantId: selfPlayMatches.tenantId,
        leadId: selfPlayMatches.leadId,
        skillsJson: selfPlayMatches.skillsJson,
      })
      .from(selfPlayMatches)
      .where(eq(selfPlayMatches.id, body.match.matchId ?? 0))
      .limit(1);
    expect(storedMatch).toMatchObject({
      tenantId: tenantA,
      leadId: body.match.leadId,
      skillsJson: JSON.stringify(["mirroring"]),
    });

    const [storedLead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, body.match.leadId))
      .limit(1);
    expect(storedLead).toMatchObject({ tenantId: tenantA, state: "self_play" });

    const [storedContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, storedLead?.userId ?? 0))
      .limit(1);
    expect(storedContact?.attributesJson).toContain("self_play");

    const [storedConversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, storedLead?.userId ?? 0))
      .limit(1);
    expect(storedConversation).toMatchObject({ tenantId: tenantA, source: "self_play" });

    const outcomes = await db
      .select()
      .from(skillOutcomes)
      .where(eq(skillOutcomes.leadId, body.match.leadId));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      tenantId: tenantA,
      styleSlug: "style-a",
      skillSlug: "mirroring",
      outcome: "won",
      source: "self_play",
    });
  });

  it("runs and persists a tenant-scoped pairwise match", async () => {
    if (!sql) return;
    resetQualityQueues();
    salesReplies.push(
      "A: договор до вылета и сопровождение, можно начать с анкеты",
      "B: напишите потом, если интересно",
    );
    candidateReplies.push("ок, давай анкету", "нет, мне не подходит");
    judgeReplies.push(
      '["mirroring"]',
      '{"outcome":"won","reason":"A solo closed"}',
      '["mirroring"]',
      '{"outcome":"lost","reason":"B solo lost"}',
      '{"winner":"a","reason":"A handled the objection better"}',
    );

    const res = await authPostJsonReq(tokenA, "/api/admin/quality/pairwise/matches", {
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      maxTurns: 1,
      reflect: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QualityPairwiseRunResponse;
    expect(body.pairwise).toMatchObject({
      styleASlug: "style-a",
      styleBSlug: "style-b",
      personaSlug: "skeptic-anya",
      verdict: { winner: "a", reason: "A handled the objection better" },
      persisted: true,
    });
    expect(body.pairwise.pairwiseId).toBeGreaterThan(0);
    expect(body.pairwise.matchA.persisted).toBe(true);
    expect(body.pairwise.matchB.persisted).toBe(true);
    expect(body.pairwise.matchA.matchId).toBeGreaterThan(0);
    expect(body.pairwise.matchB.matchId).toBeGreaterThan(0);

    const crossTenant = await authReq(
      tokenB,
      `/api/admin/quality/pairwise/matches/${body.pairwise.pairwiseId}`,
    );
    expect(crossTenant.status).toBe(404);

    const [storedPairwise] = await db
      .select()
      .from(pairwiseMatches)
      .where(eq(pairwiseMatches.id, body.pairwise.pairwiseId ?? 0))
      .limit(1);
    expect(storedPairwise).toMatchObject({
      tenantId: tenantA,
      winner: "a",
      judgeReason: "A handled the objection better",
    });
    expect(storedPairwise?.matchAId).toBe(body.pairwise.matchA.matchId);
    expect(storedPairwise?.matchBId).toBe(body.pairwise.matchB.matchId);

    const ratings = await db
      .select()
      .from(styleRatings)
      .where(eq(styleRatings.tenantId, tenantA));
    expect(ratings.some((rating) => rating.styleSlug === "style-a")).toBe(true);
    expect(ratings.some((rating) => rating.styleSlug === "style-b")).toBe(true);

    const invalid = await authPostJsonReq(tokenA, "/api/admin/quality/pairwise/matches", {
      styleASlug: "style-a",
      styleBSlug: "style-a",
      personaSlug: "skeptic-anya",
      maxTurns: 1,
      reflect: false,
    });
    expect(invalid.status).toBe(400);
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

async function authPostReq(token: string, path: string): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function authPostJsonReq(token: string, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resetQualityQueues() {
  salesReplies.length = 0;
  candidateReplies.length = 0;
  judgeReplies.length = 0;
  salesCalls.length = 0;
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

type QualityToolCallsResponse = {
  items: Array<{
    id: number;
    conversationId: number;
    contactId: number | null;
    messageId: number | null;
    outboundQueueId: number | null;
    source: string;
    toolName: string;
    args: unknown;
    result: unknown;
    error: boolean;
    cycle: number;
    toolCallIndex: number;
    latencyMs: number | null;
    createdAt: number;
  }>;
};

type QualityToolCallFeedbackResponse = {
  id: number;
  toolCallId: number;
  adminId: number | null;
  label: string;
  note: string | null;
  createdAt: number;
};

type QualityToolCallFeedbackCreateResponse = {
  ok: true;
  feedback: QualityToolCallFeedbackResponse;
};

type QualityToolCallFeedbackListResponse = {
  items: QualityToolCallFeedbackResponse[];
};

type QualityToolCallFeedbackSummaryResponse = {
  totals: {
    total: number;
    goodReply: number;
    wrongTool: number;
    missingTool: number;
    badArgs: number;
    other: number;
    errorCount: number;
    lastFeedbackAt: number | null;
  };
  byLabel: Array<{
    label: string;
    total: number;
    lastFeedbackAt: number | null;
  }>;
  byTool: Array<{
    toolName: string;
    total: number;
    goodReply: number;
    wrongTool: number;
    missingTool: number;
    badArgs: number;
    other: number;
    errorCount: number;
    lastFeedbackAt: number | null;
  }>;
  bySource: Array<{
    source: string;
    total: number;
    goodReply: number;
    wrongTool: number;
    missingTool: number;
    badArgs: number;
    other: number;
    errorCount: number;
    lastFeedbackAt: number | null;
  }>;
  byError: Array<{
    error: boolean;
    total: number;
    lastFeedbackAt: number | null;
  }>;
  recent: Array<{
    feedback: QualityToolCallFeedbackResponse;
    toolCall: QualityToolCallsResponse["items"][number];
  }>;
};

type QualityToolCallFeedbackExportRow = {
  toolCallId: number;
  adminId: number | null;
  label: string;
  note: string | null;
  feedbackCreatedAt: number;
  conversationId: number;
  contactId: number | null;
  messageId: number | null;
  outboundQueueId: number | null;
  source: string;
  toolName: string;
  args: unknown;
  result: unknown;
  error: boolean;
  cycle: number;
  toolCallIndex: number;
  latencyMs: number | null;
  toolCallCreatedAt: number;
};

type QualityToolCallFeedbackProposalsResponse = {
  items: Array<{
    id: string;
    kind: "schema_fix" | "routing_prompt_fix" | "tool_candidate";
    severity: "high" | "medium" | "low";
    title: string;
    toolName: string;
    source: string;
    label: string;
    feedbackCount: number;
    errorCount: number;
    lastFeedbackAt: number | null;
    summary: string;
    rationale: string[];
    actionItems: string[];
    examples: Array<{
      feedback: QualityToolCallFeedbackResponse;
      toolCall: QualityToolCallsResponse["items"][number];
    }>;
  }>;
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
    id: number;
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
    id: number;
    styleASlug: string;
    styleBSlug: string;
    winner: string;
    judgeReason: string | null;
    eloAAfter: number;
    eloBAfter: number;
  }>;
};

type QualityTranscriptTurn = {
  role: "candidate" | "salesperson";
  text: string;
};

type QualitySelfPlayDetailResponse = {
  match: {
    styleSlug: string;
    personaSlug: string;
    turns: number;
    transcript: QualityTranscriptTurn[];
    skillsAttributed: string[];
    verdict: { outcome: string; reason: string | null };
    outcome: string;
    leadId: number;
    fabricationsCaught: number;
    matchId: number | null;
    persisted: boolean;
    warnings: string[];
  };
};

type QualitySelfPlayRunResponse = {
  ok: boolean;
  match: QualitySelfPlayDetailResponse["match"];
};

type QualityPairwiseDetailResponse = {
  pairwise: {
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    matchA: QualitySelfPlayDetailResponse["match"];
    matchB: QualitySelfPlayDetailResponse["match"];
    verdict: { winner: string; reason: string | null };
    eloAAfter: number;
    eloBAfter: number;
    pairwiseId: number | null;
    persisted: boolean;
  };
};

type QualityPairwiseRunResponse = {
  ok: boolean;
  pairwise: QualityPairwiseDetailResponse["pairwise"];
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

type QualityCoachProposalGenerateResponse = QualityCoachProposalStatusResponse;

type QualityCoachProposalApplyResponse = QualityCoachProposalStatusResponse & {
  style: {
    id: number;
    tenantId: number;
    slug: string;
    displayName: string;
    configJson: string;
    isActive: boolean;
    version: number;
    parentId: number | null;
    createdAt: number;
    deletedAt: number | null;
  };
};

type QualityCoachShadowCreateResponse = {
  ok: boolean;
  shadow: {
    id: number;
    proposalId: number;
    parentStyleSlug: string;
    parentStyleId: number;
    newStyleSlug: string;
    newStyleId: number;
    pairsPlanned: number;
    pairsDone: number;
    aWins: number;
    bWins: number;
    draws: number;
    winRateLb: number | null;
    status: string;
    decision: string | null;
    errorMessage: string | null;
    startedAt: number;
    completedAt: number | null;
  };
};

type QualityCoachShadowPreviewResponse = {
  ok: boolean;
  preview: {
    ready: boolean;
    proposalId: number;
    parentStyle: {
      id: number;
      slug: string;
    };
    candidateStyle: {
      id: number;
      slug: string;
      parentId: number | null;
    };
    pairwise: {
      limit: number;
      total: number;
      aWins: number;
      bWins: number;
      draws: number;
      bWinsAdjusted: number;
      winRateLb: number | null;
      decision: string | null;
      recentIds: number[];
    };
    missing: {
      reason: string;
      nextAction: string;
      styleASlug: string;
      styleBSlug: string;
    } | null;
  };
};

function styleConfig(slug: string, displayName: string, tone: string) {
  return {
    slug,
    displayName,
    persona: { name: "Manager", role: "human" },
    voice: { tone, language: "ru", forbid: [] },
    framework: "SPIN",
    hooks: [],
    stages: {
      opener: { goal: "Open", guidance: "Open clearly.", groundingRequired: false },
      qualify: { goal: "Qualify", guidance: "Ask relevant questions.", groundingRequired: false },
      pitch: { goal: "Pitch", guidance: "Explain value.", groundingRequired: false },
      objection: { goal: "Objection", guidance: "Handle objections.", groundingRequired: false },
      close: { goal: "Close", guidance: "Close softly.", groundingRequired: false },
    },
    fewShot: [],
    guardrails: {},
    model: {},
  };
}

function parseJsonl(text: string): QualityRecord[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForShadowEvaluation(id: number) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const [row] = await db
      .select()
      .from(shadowEvaluations)
      .where(eq(shadowEvaluations.id, id))
      .limit(1);
    if (row && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`shadow evaluation ${id} did not finish`);
}
