import { PairwiseMatchesRepo } from "../../db/repos/pairwise-matches.ts";
import { json, type RouteHandler } from "../../router.ts";
import type { CandidatePersona } from "../../sales/self-play/personas.ts";
import { CANDIDATE_PERSONAS } from "../../sales/self-play/personas.ts";
import { parseIdParam, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Pairwise self-play (head-to-head A vs B) ──────────────────────────

const PERSONA_LOOKUP = new Map<string, CandidatePersona>(
  CANDIDATE_PERSONAS.map((p) => [p.slug, p]),
);

/** GET /admin/api/pairwise — recent pairwise pairs + head-to-head matrix. */
export function createListPairwiseMatchesHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ url }) => {
    const repo = new PairwiseMatchesRepo(deps.sql);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const a = url.searchParams.get("a") ?? undefined;
    const b = url.searchParams.get("b") ?? undefined;
    const personaSlug = url.searchParams.get("persona") ?? undefined;
    const winner = url.searchParams.get("winner");
    const opts: Parameters<typeof repo.list>[0] = {
      limit: Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 100,
      ...(a ? { styleASlug: a } : {}),
      ...(b ? { styleBSlug: b } : {}),
      ...(personaSlug ? { personaSlug } : {}),
      ...(winner === "a" || winner === "b" || winner === "draw" ? { winner } : {}),
    };
    const matches = await repo.list(opts);
    const matrix = await repo.matrix();
    return json({
      total: await repo.count(),
      matches: matches.map((m) => ({
        ...m,
        persona_display_name: PERSONA_LOOKUP.get(m.persona_slug)?.displayName ?? m.persona_slug,
      })),
      matrix,
      personas: CANDIDATE_PERSONAS.map((p) => ({
        slug: p.slug,
        display_name: p.displayName,
        summary: p.summary,
      })),
    });
  });
}

/** GET /admin/api/pairwise/:id — pairwise verdict + linked solo match ids
 *  (operator can drill into either transcript via /admin/self-play/:id). */
export function createGetPairwiseMatchHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const repo = new PairwiseMatchesRepo(deps.sql);
    const match = await repo.byId(id);
    if (!match) return json({ error: "not found" }, { status: 404 });
    const persona = PERSONA_LOOKUP.get(match.persona_slug);
    return json({
      match: {
        ...match,
        persona_display_name: persona?.displayName ?? match.persona_slug,
      },
    });
  });
}

/** DELETE /admin/api/pairwise/:id — clear bad pairwise verdicts. */
export function createDeletePairwiseMatchHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const repo = new PairwiseMatchesRepo(deps.sql);
    const ok = await repo.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  });
}
