import { SkillOutcomesRepo, StyleRatingsRepo } from "../../db/repos/skill-outcomes.ts";
import { SkillsRepo } from "../../db/repos/skills.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { json, type RouteHandler } from "../../router.ts";
import { rankSkillRecommendations } from "../../sales/skill-recommendations.ts";
import { SKILL_BY_SLUG } from "../../sales/skills/catalogue.ts";
import { parseIdParam, parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Skills (catalogue + per-style attachments) ──────────────────────

interface SkillDto {
  id: number;
  slug: string;
  family: string;
  display_name: string;
  description: string;
  prompt_fragment: string;
  applicable_stages: string[];
  intent: string;
  is_enabled: boolean;
  attached_to_styles: number;
  outcomes: {
    count: number;
    wins: number;
    losses: number;
    draws: number;
    win_rate: number | null;
  };
}

function rowToSkillDto(
  row: Awaited<ReturnType<SkillsRepo["bySlug"]>>,
  attachmentCount: number,
  outcomes: { count: number; wins: number; losses: number; draws: number; win_rate: number },
): SkillDto | null {
  if (!row) return null;
  let stages: string[] = [];
  try {
    const parsed = JSON.parse(row.applicable_stages_json);
    if (Array.isArray(parsed)) stages = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* malformed JSON → empty stages list */
  }
  return {
    id: row.id,
    slug: row.slug,
    family: row.family,
    display_name: row.display_name,
    description: row.description,
    prompt_fragment: row.prompt_fragment,
    applicable_stages: stages,
    intent: row.intent,
    is_enabled: row.is_enabled,
    attached_to_styles: attachmentCount,
    outcomes: {
      count: outcomes.count,
      wins: outcomes.wins,
      losses: outcomes.losses,
      draws: outcomes.draws,
      win_rate: Number.isFinite(outcomes.win_rate) ? outcomes.win_rate : null,
    },
  };
}

const EMPTY_OUTCOME = { count: 0, wins: 0, losses: 0, draws: 0, win_rate: Number.NaN };

export function createListSkillsHandler(deps: AdminApiDeps): RouteHandler {
  const skills = new SkillsRepo(deps.sql);
  const outcomesRepo = new SkillOutcomesRepo(deps.sql);
  return withAdmin(deps.sql, async () => {
    const counts = await skills.attachmentCounts();
    const aggregates = new Map((await outcomesRepo.aggregate()).map((a) => [a.skill_slug, a]));
    const rows = await skills.list();
    const dtos = rows
      .map((r) =>
        rowToSkillDto(r, counts.get(r.slug) ?? 0, aggregates.get(r.slug) ?? EMPTY_OUTCOME),
      )
      .filter((d): d is SkillDto => d !== null);
    return json({ skills: dtos });
  });
}

export function createListStyleRatingsHandler(deps: AdminApiDeps): RouteHandler {
  const repo = new StyleRatingsRepo(deps.sql);
  return withAdmin(deps.sql, async () => {
    return json({ ratings: await repo.list() });
  });
}

export function createUpdateSkillHandler(deps: AdminApiDeps): RouteHandler {
  const skills = new SkillsRepo(deps.sql);
  const outcomesRepo = new SkillOutcomesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const slug = params.slug;
    const row = await skills.bySlug(slug);
    if (!row) return json({ error: "skill not found" }, { status: 404 });

    const body = await parseJsonBody<{ is_enabled?: unknown }>(req);
    if (body instanceof Response) return body;
    if (typeof body.is_enabled !== "boolean") {
      return json({ error: "is_enabled (boolean) required" }, { status: 400 });
    }
    await skills.setEnabled(row.id, body.is_enabled);
    const updated = await skills.bySlug(slug);
    const counts = await skills.attachmentCounts();
    const outcomes =
      (await outcomesRepo.aggregate()).find((a) => a.skill_slug === slug) ?? EMPTY_OUTCOME;
    return json({ skill: rowToSkillDto(updated, counts.get(slug) ?? 0, outcomes) });
  });
}

export function createGetStyleSkillsHandler(deps: AdminApiDeps): RouteHandler {
  const skills = new SkillsRepo(deps.sql);
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    if (!(await styles.byId(id))) return json({ error: "style not found" }, { status: 404 });
    const rows = await skills.skillsForStyle(id);
    return json({ slugs: rows.map((r) => r.slug) });
  });
}

export function createSetStyleSkillsHandler(deps: AdminApiDeps): RouteHandler {
  const skills = new SkillsRepo(deps.sql);
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    if (!(await styles.byId(id))) return json({ error: "style not found" }, { status: 404 });

    const body = await parseJsonBody<{ slugs?: unknown }>(req);
    if (body instanceof Response) return body;
    if (!Array.isArray(body.slugs)) {
      return json({ error: "slugs (array) required" }, { status: 400 });
    }
    const slugs = body.slugs.filter((s): s is string => typeof s === "string");
    const unknown = slugs.filter((s) => !SKILL_BY_SLUG.has(s));
    if (unknown.length > 0) {
      return json({ error: `unknown skill slugs: ${unknown.join(", ")}` }, { status: 400 });
    }
    const r = await skills.setSkillsForStyle(id, slugs);
    return json({ ok: true, attached: r.attached });
  });
}

// ─── Skill recommendations (data-driven picker) ──────────────────────

/**
 * GET /admin/api/skills/recommend?minSamples=5&accept=0.4
 *
 * Returns skills ranked by Wilson lower-bound confidence on win-rate.
 * The /admin/styles/:id picker uses this to auto-select a "best
 * performers" subset based on real outcome data — operators can then
 * tweak before saving.
 *
 * Query params:
 *   minSamples (int, default 5)  — below this `confidence_lower` is 0
 *   accept     (float, default 0.4) — Wilson lb above this → recommended=true
 */
export function createRecommendSkillsHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ url }) => {
    const minSamples = clampInt(url.searchParams.get("minSamples"), 1, 1000, 5);
    const accept = clampFloat(url.searchParams.get("accept"), 0, 1, 0.4);
    const skillsRepoLocal = new SkillsRepo(deps.sql);
    const outcomesRepoLocal = new SkillOutcomesRepo(deps.sql);
    const catalogue = await skillsRepoLocal.list();
    const aggregates = await outcomesRepoLocal.aggregate();
    const ranked = rankSkillRecommendations(catalogue, aggregates, {
      minSamples,
      acceptThreshold: accept,
    });
    return json({
      params: { minSamples, accept },
      total_outcomes: aggregates.reduce((s, a) => s + a.count, 0),
      recommendations: ranked.map((r) => ({
        ...r,
        observed_rate: Number.isFinite(r.observed_rate) ? r.observed_rate : null,
      })),
    });
  });
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampFloat(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
