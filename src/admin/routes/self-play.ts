import { SelfPlayMatchesRepo } from "../../db/repos/self-play-matches.ts";
import { json, type RouteHandler } from "../../router.ts";
import type { CandidatePersona } from "../../sales/self-play/personas.ts";
import { CANDIDATE_PERSONAS } from "../../sales/self-play/personas.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Self-play match transcripts ──────────────────────────────────────

const PERSONA_LOOKUP = new Map<string, CandidatePersona>(
  CANDIDATE_PERSONAS.map((p) => [p.slug, p]),
);

/** GET /admin/api/self-play — recent matches list + matrix per (style, persona). */
export function createListSelfPlayMatchesHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, url }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const repo = new SelfPlayMatchesRepo(deps.sql);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const styleSlug = url.searchParams.get("style") ?? undefined;
    const personaSlug = url.searchParams.get("persona") ?? undefined;
    const outcome = url.searchParams.get("outcome");
    const opts: Parameters<typeof repo.list>[0] = {
      limit: Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 100,
      ...(styleSlug ? { styleSlug } : {}),
      ...(personaSlug ? { personaSlug } : {}),
      ...(outcome === "won" || outcome === "lost" || outcome === "draw" ? { outcome } : {}),
    };
    const matches = await repo.list(opts);
    const matrix = await repo.matrix();
    return json({
      total: await repo.count(),
      matches,
      matrix,
      personas: CANDIDATE_PERSONAS.map((p) => ({
        slug: p.slug,
        display_name: p.displayName,
        summary: p.summary,
      })),
    });
  };
}

/** GET /admin/api/self-play/:id — full transcript of one match. */
export function createGetSelfPlayMatchHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const repo = new SelfPlayMatchesRepo(deps.sql);
    const match = await repo.byId(id);
    if (!match) return json({ error: "not found" }, { status: 404 });
    const persona = PERSONA_LOOKUP.get(match.persona_slug);
    return json({
      match: {
        id: match.id,
        style_slug: match.style_slug,
        persona_slug: match.persona_slug,
        persona_display_name: persona?.displayName ?? match.persona_slug,
        outcome: match.outcome,
        judge_reason: match.judge_reason,
        turns: match.turns,
        skills: match.skills,
        lead_id: match.lead_id,
        fabrications_caught: match.fabrications_caught ?? 0,
        created_at: match.created_at,
        transcript: match.transcript,
      },
    });
  };
}

/** DELETE /admin/api/self-play/:id — operator clears bad data points
 *  (e.g. judge mis-classified). Idempotent — 404 on missing. */
export function createDeleteSelfPlayMatchHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const repo = new SelfPlayMatchesRepo(deps.sql);
    const ok = await repo.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  };
}
