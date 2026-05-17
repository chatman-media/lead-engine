// Coverage for `src/admin/routes/coach.ts` — baseline was 8.98% lines and
// the apply/rollback endpoints mutate the styles version chain destructively.
// Same risk class as the ops endpoints (where missing tests hid two SQL
// bugs, fixed in #16).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { CoachProposalsRepo } from "@/db/repos/coach-proposals.ts";
import { SkillsRepo, seedSkillCatalogue } from "@/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import type { ChatClient } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import type { CoachProposal } from "@/sales/coach.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;
let chatCalls: { messages: unknown[] }[] = [];
let chatReply: string;

function stubEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map(() => new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    },
  };
}

function stubChat(): ChatClient {
  return {
    async complete(messages) {
      chatCalls.push({ messages: messages.slice() });
      return chatReply;
    },
  };
}

beforeEach(async () => {
  chatCalls = [];
  chatReply = "default-stub-reply";
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    rag: { chat: stubChat(), embedder: stubEmbedder() },
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => {
  server.stop(true);
});

function url(path: string) {
  return `http://127.0.0.1:${server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
}

const SAMPLE_PROPOSAL: CoachProposal = {
  summary: "tighten openers",
  edits: {
    voice_tone: "warm, direct",
    hooks_add: [{ kind: "scarcity", text: "places fill fast" }],
  },
  rationale: ["openers were too soft"],
};

async function seedPendingProposal(styleSlug = flirtyBelfort.slug): Promise<number> {
  await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
  const repo = new CoachProposalsRepo(sql);
  const row = await repo.insert({
    styleSlug,
    sampleSize: 8,
    personaFilter: null,
    proposal: SAMPLE_PROPOSAL,
  });
  return row.id;
}

// Direct-INSERT a self_play_match row so proposeStyleEdits has something to
// learn from (without it, the function returns the no-data short-circuit
// response without ever calling the chat client).
async function seedLostMatch(styleSlug: string): Promise<void> {
  await sql`
    INSERT INTO self_play_matches
      (style_slug, persona_slug, outcome, transcript_json, turns, judge_reason, skills_json)
    VALUES (${styleSlug}, 'skeptic', 'lost', '[]', 0, 'sample reason', '[]')
  `;
}

// ─── GET /admin/api/coach ────────────────────────────────────────────

describe("GET /admin/api/coach", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/coach"));
    expect(res.status).toBe(401);
  });

  test("returns proposals + pending_count, default newest-first", async () => {
    const id1 = await seedPendingProposal();
    const id2 = await seedPendingProposal();

    const res = await fetch(url("/admin/api/coach"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposals: { id: number }[];
      pending_count: number;
    };
    expect(body.proposals.map((p) => p.id)).toEqual([id2, id1]);
    expect(body.pending_count).toBe(2);
  });

  test("filters by style + status; rejects unknown status", async () => {
    const adminId = await insertAdminId();
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const repo = new CoachProposalsRepo(sql);
    const a = await repo.insert({
      styleSlug: "alina",
      sampleSize: 4,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.insert({
      styleSlug: "masha",
      sampleSize: 4,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.decide({ id: a.id, status: "applied", adminId });

    const byStyle = (await (await fetch(url("/admin/api/coach?style=alina"), authed())).json()) as {
      proposals: unknown[];
    };
    expect(byStyle.proposals.length).toBe(1);

    const byStatus = (await (
      await fetch(url("/admin/api/coach?status=applied"), authed())
    ).json()) as { proposals: unknown[] };
    expect(byStatus.proposals.length).toBe(1);

    // Unknown status silently dropped — endpoint still returns all rows.
    const allBack = (await (
      await fetch(url("/admin/api/coach?status=garbage"), authed())
    ).json()) as { proposals: unknown[] };
    expect(allBack.proposals.length).toBe(2);
  });

  test("limit param is clamped to [1, 500]", async () => {
    for (let i = 0; i < 3; i++) await seedPendingProposal();
    // limit=2 honored
    const limited = (await (await fetch(url("/admin/api/coach?limit=2"), authed())).json()) as {
      proposals: unknown[];
    };
    expect(limited.proposals.length).toBe(2);
    // limit=NaN falls back to default 100
    const fallback = (await (
      await fetch(url("/admin/api/coach?limit=garbage"), authed())
    ).json()) as { proposals: unknown[] };
    expect(fallback.proposals.length).toBe(3);
  });
});

async function insertAdminId(
  email = `extra-${Math.random().toString(36).slice(2, 8)}@x`,
): Promise<number> {
  const [row] = await sql<
    { id: number }[]
  >`INSERT INTO admins (email, password_hash) VALUES (${email}, 'unused') RETURNING id`;
  return row!.id;
}

// ─── GET /admin/api/coach/:id ────────────────────────────────────────

describe("GET /admin/api/coach/:id", () => {
  test("404 unknown id", async () => {
    const res = await fetch(url("/admin/api/coach/99999"), authed());
    expect(res.status).toBe(404);
  });

  test("returns the proposal with parsed edits + rationale", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(url(`/admin/api/coach/${id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: {
        id: number;
        summary: string;
        edits: { voice_tone?: string };
        rationale: string[];
      };
    };
    expect(body.proposal.id).toBe(id);
    expect(body.proposal.edits.voice_tone).toBe("warm, direct");
    expect(body.proposal.rationale).toEqual(["openers were too soft"]);
  });
});

// ─── POST /admin/api/coach/run ───────────────────────────────────────

describe("POST /admin/api/coach/run", () => {
  test("503 when LLM is not configured", async () => {
    // Spin up a no-rag server scoped to this test so the default beforeEach
    // server (with rag) doesn't interfere.
    server.stop(true);
    const telegram = new TelegramClient({
      token: "t",
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const router = createRouter({ sql, telegram, webhookSecret: SECRET });
    server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ style_slug: "alina" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  test("400 missing style_slug", async () => {
    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 invalid JSON body", async () => {
    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("404 unknown style slug", async () => {
    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ style_slug: "ghost-style" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("happy path inserts a proposal and returns it", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    // proposeStyleEdits short-circuits if there are no lost/draw matches to
    // learn from — seed one so the chat-client path actually runs.
    await seedLostMatch(flirtyBelfort.slug);
    chatReply = JSON.stringify({
      summary: "from stub",
      edits: { voice_tone: "snappy" },
      rationale: ["coach said so"],
    });

    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ style_slug: flirtyBelfort.slug, sample: 2 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { id: number; sample_size: number } };
    expect(body.proposal.id).toBeGreaterThan(0);
    expect(body.proposal.sample_size).toBe(2);

    // sanity: chat client was actually called
    expect(chatCalls.length).toBeGreaterThan(0);
  });

  test("sample is clamped: out-of-range falls back to default 8", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    chatReply = JSON.stringify({ summary: "", edits: {}, rationale: [] });

    const res = await fetch(
      url("/admin/api/coach/run"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ style_slug: flirtyBelfort.slug, sample: 999 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { sample_size: number } };
    expect(body.proposal.sample_size).toBe(8);
  });
});

// ─── POST /admin/api/coach/:id/decide ────────────────────────────────

describe("POST /admin/api/coach/:id/decide", () => {
  test("400 on bad status field", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(
      url(`/admin/api/coach/${id}/decide`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "garbage" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(
      url(`/admin/api/coach/${id}/decide`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("404 unknown id", async () => {
    const res = await fetch(
      url("/admin/api/coach/99999/decide"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("happy path flips status to dismissed", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(
      url(`/admin/api/coach/${id}/decide`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { status: string } };
    expect(body.proposal.status).toBe("dismissed");
  });

  test("409 when already decided (idempotency guard)", async () => {
    const id = await seedPendingProposal();
    // First decide succeeds.
    await fetch(
      url(`/admin/api/coach/${id}/decide`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
    );
    // Second one bounces with 409 + helpful message.
    const res = await fetch(
      url(`/admin/api/coach/${id}/decide`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "applied" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already dismissed/);
  });
});

// ─── POST /admin/api/coach/:id/apply ─────────────────────────────────

describe("POST /admin/api/coach/:id/apply", () => {
  test("404 unknown proposal id", async () => {
    const res = await fetch(url("/admin/api/coach/99999/apply"), authed({ method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("409 when proposal is not pending", async () => {
    const id = await seedPendingProposal();
    const adminId = await insertAdminId();
    await new CoachProposalsRepo(sql).decide({ id, status: "dismissed", adminId });

    const res = await fetch(url(`/admin/api/coach/${id}/apply`), authed({ method: "POST" }));
    expect(res.status).toBe(409);
  });

  test("404 when proposal's style was removed/inactive", async () => {
    // Create proposal referencing a slug that has no active style row.
    const repo = new CoachProposalsRepo(sql);
    const row = await repo.insert({
      styleSlug: "ghost-style",
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });

    const res = await fetch(url(`/admin/api/coach/${row.id}/apply`), authed({ method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("happy path forks new style version + marks proposal applied", async () => {
    const id = await seedPendingProposal();

    const res = await fetch(url(`/admin/api/coach/${id}/apply`), authed({ method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { status: string };
      new_style: { id: number; slug: string; version: number };
    };
    expect(body.proposal.status).toBe("applied");
    expect(body.new_style.version).toBe(2);
    expect(body.new_style.slug).toBe(flirtyBelfort.slug);

    // The new version is the current active row; v1 was deactivated.
    const stylesRepo = new StylesRepo(sql);
    const active = await stylesRepo.bySlug(flirtyBelfort.slug);
    expect(active?.id).toBe(body.new_style.id);
    expect(active?.parent_id).not.toBeNull();
  });

  test("happy path applies skills_attach / skills_detach to the new row", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const skillsRepo = new SkillsRepo(sql);
    await seedSkillCatalogue(skillsRepo);
    const stylesRepo = new StylesRepo(sql);
    const stylesRow = (await stylesRepo.bySlug(flirtyBelfort.slug))!;
    // Seed the parent with one skill attached so we can verify it carries over,
    // and use a real cataloged slug for the attach test.
    const catalogue = await skillsRepo.list();
    expect(catalogue.length).toBeGreaterThanOrEqual(2);
    const keepSlug = catalogue[0]!.slug;
    const attachSlug = catalogue[1]!.slug;
    await skillsRepo.setSkillsForStyle(stylesRow.id, [keepSlug]);

    // Insert a proposal that adds the second skill.
    const proposalsRepo = new CoachProposalsRepo(sql);
    const proposal = await proposalsRepo.insert({
      styleSlug: flirtyBelfort.slug,
      sampleSize: 8,
      personaFilter: null,
      proposal: {
        summary: "add a skill",
        edits: { skills_attach: [attachSlug] },
        rationale: [],
      },
    });

    const res = await fetch(
      url(`/admin/api/coach/${proposal.id}/apply`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_style: { id: number } };

    const newAttached = (await skillsRepo.skillsForStyle(body.new_style.id)).map((r) => r.slug);
    expect(newAttached).toContain(keepSlug);
    expect(newAttached).toContain(attachSlug);
  });

  test("skip_skills=true short-circuits the skills carry-over", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const skillsRepo = new SkillsRepo(sql);
    await seedSkillCatalogue(skillsRepo);
    const stylesRepo = new StylesRepo(sql);
    const stylesRow = (await stylesRepo.bySlug(flirtyBelfort.slug))!;
    const catalogue = await skillsRepo.list();
    const skillSlug = catalogue[0]!.slug;
    await skillsRepo.setSkillsForStyle(stylesRow.id, [skillSlug]);

    const proposalsRepo = new CoachProposalsRepo(sql);
    const proposal = await proposalsRepo.insert({
      styleSlug: flirtyBelfort.slug,
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });

    const res = await fetch(
      url(`/admin/api/coach/${proposal.id}/apply`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skip_skills: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_style: { id: number } };
    // With skip_skills=true the new row has NO skills attached at all.
    const newAttached = await skillsRepo.skillsForStyle(body.new_style.id);
    expect(newAttached.length).toBe(0);
  });

  test("empty body is accepted (no required fields)", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(
      url(`/admin/api/coach/${id}/apply`),
      authed({ method: "POST", headers: { "content-type": "application/json" }, body: "" }),
    );
    expect(res.status).toBe(200);
  });
});

// ─── POST /admin/api/coach/:id/rollback ──────────────────────────────

describe("POST /admin/api/coach/:id/rollback", () => {
  test("404 unknown proposal", async () => {
    const res = await fetch(url("/admin/api/coach/99999/rollback"), authed({ method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("409 when proposal is still pending (only applied can be rolled back)", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(url(`/admin/api/coach/${id}/rollback`), authed({ method: "POST" }));
    expect(res.status).toBe(409);
  });

  test("409 when applied proposal's style chain has no parent", async () => {
    // Skip the "apply" flow; directly seed an applied proposal pointing at a
    // brand-new v1 row (no parent) — rollback should refuse.
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const adminId = await insertAdminId();
    const repo = new CoachProposalsRepo(sql);
    const proposal = await repo.insert({
      styleSlug: flirtyBelfort.slug,
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE_PROPOSAL,
    });
    await repo.decide({ id: proposal.id, status: "applied", adminId });

    const res = await fetch(
      url(`/admin/api/coach/${proposal.id}/rollback`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(409);
  });

  test("happy path swaps is_active back to the parent version", async () => {
    // First, apply a proposal — that forks v1 → v2 and marks v1 inactive.
    const id = await seedPendingProposal();
    const applyRes = await fetch(url(`/admin/api/coach/${id}/apply`), authed({ method: "POST" }));
    const applyBody = (await applyRes.json()) as { new_style: { id: number } };

    const stylesRepo = new StylesRepo(sql);
    const v2Before = await stylesRepo.byId(applyBody.new_style.id);
    expect(v2Before?.is_active).toBe(true);
    const v1Id = v2Before!.parent_id!;

    const res = await fetch(url(`/admin/api/coach/${id}/rollback`), authed({ method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deactivated: { id: number };
      reactivated: { id: number };
    };
    expect(body.deactivated.id).toBe(applyBody.new_style.id);
    expect(body.reactivated.id).toBe(v1Id);

    // is_active flipped on both rows in the same transaction.
    const v1After = await stylesRepo.byId(v1Id);
    const v2After = await stylesRepo.byId(applyBody.new_style.id);
    expect(v1After?.is_active).toBe(true);
    expect(v2After?.is_active).toBe(false);
  });
});

// ─── DELETE /admin/api/coach/:id ─────────────────────────────────────

describe("DELETE /admin/api/coach/:id", () => {
  test("404 unknown id", async () => {
    const res = await fetch(url("/admin/api/coach/99999"), authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  test("deletes the row and returns ok", async () => {
    const id = await seedPendingProposal();
    const res = await fetch(url(`/admin/api/coach/${id}`), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body).toEqual({ ok: true, deleted: id });
    expect(await new CoachProposalsRepo(sql).byId(id)).toBeNull();
  });
});
