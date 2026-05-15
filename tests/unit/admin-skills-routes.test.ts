// Coverage for `src/admin/routes/skills.ts` — baseline 22.56% lines.
// Six handlers: list skills with outcomes/attachments, list style-ratings,
// toggle a skill enabled, get + set per-style skill attachments, and the
// data-driven recommendation endpoint. Same risk class as ops.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { SkillsRepo, seedSkillCatalogue } from "@/db/repos/skills.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

beforeEach(async () => {
  const telegram = new TelegramClient({
    token: "t",
    fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as FetchLike,
  });
  const router = createRouter({ sql, telegram, webhookSecret: SECRET });
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

async function seedSkillsAndStyle() {
  await seedSkillCatalogue(new SkillsRepo(sql));
  await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
}

// ─── GET /admin/api/skills ────────────────────────────────────────────

describe("GET /admin/api/skills", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/skills"));
    expect(res.status).toBe(401);
  });

  test("returns DTOs for every catalogued skill with outcome+attachment counters", async () => {
    await seedSkillsAndStyle();
    const res = await fetch(url("/admin/api/skills"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{
        slug: string;
        is_enabled: boolean;
        attached_to_styles: number;
        outcomes: { count: number; win_rate: number | null };
      }>;
    };
    expect(body.skills.length).toBeGreaterThan(0);
    // No outcomes yet → win_rate is null and count is 0.
    for (const s of body.skills) {
      expect(s.outcomes.count).toBe(0);
      expect(s.outcomes.win_rate).toBeNull();
    }
  });
});

// ─── PATCH /admin/api/skills/:slug ────────────────────────────────────

describe("PATCH /admin/api/skills/:slug", () => {
  test("404 unknown slug", async () => {
    const res = await fetch(
      url("/admin/api/skills/ghost-slug"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_enabled: false }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400 when is_enabled is not a boolean", async () => {
    await seedSkillsAndStyle();
    const slug = (await new SkillsRepo(sql).list())[0]!.slug;
    const res = await fetch(
      url(`/admin/api/skills/${slug}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_enabled: "yes-please" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("toggles is_enabled and returns the updated DTO", async () => {
    await seedSkillsAndStyle();
    const skills = new SkillsRepo(sql);
    const slug = (await skills.list())[0]!.slug;

    const res = await fetch(
      url(`/admin/api/skills/${slug}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skill: { slug: string; is_enabled: boolean } };
    expect(body.skill.slug).toBe(slug);
    expect(body.skill.is_enabled).toBe(false);

    // DB confirms the flip.
    const reloaded = await skills.bySlug(slug);
    expect(reloaded?.is_enabled).toBe(false);
  });
});

// ─── GET /admin/api/styles/:id/skills ─────────────────────────────────

describe("GET /admin/api/styles/:id/skills", () => {
  test("404 unknown style", async () => {
    const res = await fetch(url("/admin/api/styles/99999/skills"), authed());
    expect(res.status).toBe(404);
  });

  test("returns the attached slugs (empty when nothing attached)", async () => {
    await seedSkillsAndStyle();
    const styleId = (await new StylesRepo(sql).bySlug(flirtyBelfort.slug))!.id;
    const res = await fetch(url(`/admin/api/styles/${styleId}/skills`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slugs: string[] };
    expect(body.slugs).toEqual([]);
  });
});

// ─── PUT /admin/api/styles/:id/skills ─────────────────────────────────

describe("PUT /admin/api/styles/:id/skills", () => {
  test("404 unknown style", async () => {
    const res = await fetch(
      url("/admin/api/styles/99999/skills"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400 when slugs isn't an array", async () => {
    await seedSkillsAndStyle();
    const styleId = (await new StylesRepo(sql).bySlug(flirtyBelfort.slug))!.id;
    const res = await fetch(
      url(`/admin/api/styles/${styleId}/skills`),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs: "not-an-array" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when slugs contain values not in the catalogue", async () => {
    await seedSkillsAndStyle();
    const styleId = (await new StylesRepo(sql).bySlug(flirtyBelfort.slug))!.id;
    const res = await fetch(
      url(`/admin/api/styles/${styleId}/skills`),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs: ["ghost-skill-1", "ghost-skill-2"] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown skill slugs/);
  });

  test("attaches the slugs and reports the count", async () => {
    await seedSkillsAndStyle();
    const skills = new SkillsRepo(sql);
    const catalogue = await skills.list();
    const slugs = catalogue.slice(0, 2).map((c) => c.slug);
    const styleId = (await new StylesRepo(sql).bySlug(flirtyBelfort.slug))!.id;

    const res = await fetch(
      url(`/admin/api/styles/${styleId}/skills`),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; attached: number };
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(2);

    const attached = await skills.skillsForStyle(styleId);
    expect(new Set(attached.map((s) => s.slug))).toEqual(new Set(slugs));
  });

  test("non-string entries in slugs are silently filtered out", async () => {
    await seedSkillsAndStyle();
    const skills = new SkillsRepo(sql);
    const validSlug = (await skills.list())[0]!.slug;
    const styleId = (await new StylesRepo(sql).bySlug(flirtyBelfort.slug))!.id;

    const res = await fetch(
      url(`/admin/api/styles/${styleId}/skills`),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Numbers and nulls get filtered before the catalogue check; the
        // string slug survives.
        body: JSON.stringify({ slugs: [validSlug, 42, null] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attached: number };
    expect(body.attached).toBe(1);
  });
});

// ─── GET /admin/api/style-ratings ─────────────────────────────────────

describe("GET /admin/api/style-ratings", () => {
  test("returns an empty list when no ratings exist", async () => {
    const res = await fetch(url("/admin/api/style-ratings"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ratings: unknown[] };
    expect(body.ratings).toEqual([]);
  });

  test("reflects seeded rating rows", async () => {
    await sql`
      INSERT INTO style_ratings (style_slug, elo, wins, losses, draws)
      VALUES ('alina', 1520, 4, 1, 1), ('masha', 1490, 2, 3, 0)
    `;
    const res = await fetch(url("/admin/api/style-ratings"), authed());
    const body = (await res.json()) as { ratings: { style_slug: string; elo: number }[] };
    expect(body.ratings.length).toBe(2);
    const bySlug = Object.fromEntries(body.ratings.map((r) => [r.style_slug, r.elo]));
    expect(bySlug.alina).toBe(1520);
    expect(bySlug.masha).toBe(1490);
  });
});

// ─── GET /admin/api/skills/recommend ──────────────────────────────────

describe("GET /admin/api/skills/recommend", () => {
  test("returns ranked recommendations + the resolved params", async () => {
    await seedSkillsAndStyle();
    const res = await fetch(url("/admin/api/skills/recommend"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      params: { minSamples: number; accept: number };
      total_outcomes: number;
      recommendations: { slug: string; observed_rate: number | null }[];
    };
    expect(body.params).toEqual({ minSamples: 5, accept: 0.4 });
    expect(body.total_outcomes).toBe(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
    // No outcomes yet → observed_rate is null (NaN becomes null in the DTO).
    for (const r of body.recommendations) {
      expect(r.observed_rate).toBeNull();
    }
  });

  test("clamps minSamples + accept to their allowed ranges", async () => {
    await seedSkillsAndStyle();
    // Out-of-range values fall back to defaults; in-range values are honored.
    const out = (await (
      await fetch(url("/admin/api/skills/recommend?minSamples=-5&accept=2"), authed())
    ).json()) as { params: { minSamples: number; accept: number } };
    expect(out.params.minSamples).toBe(1); // clamped to lo=1
    expect(out.params.accept).toBe(1); // clamped to hi=1

    const inRange = (await (
      await fetch(url("/admin/api/skills/recommend?minSamples=10&accept=0.6"), authed())
    ).json()) as { params: { minSamples: number; accept: number } };
    expect(inRange.params).toEqual({ minSamples: 10, accept: 0.6 });

    const garbage = (await (
      await fetch(url("/admin/api/skills/recommend?minSamples=banana&accept=oops"), authed())
    ).json()) as { params: { minSamples: number; accept: number } };
    expect(garbage.params).toEqual({ minSamples: 5, accept: 0.4 });
  });
});
