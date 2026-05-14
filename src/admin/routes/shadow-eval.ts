import { CoachProposalsRepo } from "../../db/repos/coach-proposals.ts";
import { ConversationsRepo } from "../../db/repos/conversations.ts";
import { KbRepo } from "../../db/repos/kb.ts";
import { LeadsRepo } from "../../db/repos/leads.ts";
import { ShadowEvaluationsRepo } from "../../db/repos/shadow-evaluations.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "../../db/repos/skill-outcomes.ts";
import { SkillsRepo } from "../../db/repos/skills.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { UsersRepo } from "../../db/repos/users.ts";
import { renderVacanciesBlock, VacanciesRepo } from "../../db/repos/vacancies.ts";
import { json, type RouteHandler } from "../../router.ts";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "../../sales/self-play/personas.ts";
import { runShadowEval } from "../../sales/shadow-eval.ts";
import type { Style } from "../../sales/types.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Shadow A/B evaluations ────────────────────────────────────────────

/**
 * POST /admin/api/coach/:id/shadow-eval — kicks off pairwise A/B between
 * the parent style version (A) and the freshly-forked new version (B).
 * Body: { runs?, personas?, max_turns? }. Returns the row immediately;
 * the runner writes incremental progress in the background. Caller polls
 * GET /admin/api/coach/:id/shadow-eval until status changes.
 */
export function createStartShadowEvalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    if (!deps.rag?.chat || !deps.rag?.embedder) {
      return json({ error: "LLM not configured" }, { status: 503 });
    }
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    let body: { runs?: number; personas?: string[]; max_turns?: number } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      // Empty body OK.
    }

    const proposalsRepo = new CoachProposalsRepo(deps.sql);
    const proposal = await proposalsRepo.byId(id);
    if (!proposal) return json({ error: "proposal not found" }, { status: 404 });
    if (proposal.status !== "applied") {
      return json(
        { error: `proposal must be applied first (current: ${proposal.status})` },
        { status: 409 },
      );
    }

    const stylesRepo = new StylesRepo(deps.sql);
    const newRow = await stylesRepo.bySlug(proposal.style_slug);
    if (!newRow) return json({ error: "new style not found" }, { status: 404 });
    if (newRow.parent_id === null) {
      return json({ error: "applied proposal's style row has no parent" }, { status: 409 });
    }
    const parentRow = await stylesRepo.byId(newRow.parent_id);
    if (!parentRow) return json({ error: "parent missing" }, { status: 404 });

    const newStyle = stylesRepo.parseRow(newRow) as Style;
    const parentStyle = stylesRepo.parseRow(parentRow) as Style;

    const personaSlugs =
      Array.isArray(body.personas) && body.personas.length > 0
        ? body.personas
        : CANDIDATE_PERSONAS.slice(0, 4).map((p) => p.slug);
    const personas = personaSlugs
      .map((s) => CANDIDATE_BY_SLUG.get(s))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    if (personas.length === 0) return json({ error: "no valid personas" }, { status: 400 });

    const runs = Math.max(1, Math.min(5, Math.floor(body.runs ?? 1)));
    const maxTurns = Math.max(4, Math.min(40, Math.floor(body.max_turns ?? 16)));
    const pairsPlanned = personas.length * runs;

    const shadowRepo = new ShadowEvaluationsRepo(deps.sql);
    const evalRow = await shadowRepo.insert({
      proposalId: id,
      parentStyleSlug: parentRow.slug,
      parentStyleId: parentRow.id,
      newStyleSlug: newRow.slug,
      newStyleId: newRow.id,
      pairsPlanned,
    });

    void runShadowEval(
      {
        db: deps.sql,
        shadowRepo,
        kb: new KbRepo(deps.sql),
        skills: new SkillsRepo(deps.sql),
        outcomes: new SkillOutcomesRepo(deps.sql),
        ratings: new StyleRatingsRepo(deps.sql),
        users: new UsersRepo(deps.sql),
        conversations: new ConversationsRepo(deps.sql),
        leads: new LeadsRepo(deps.sql),
        salesChat: deps.rag.chat,
        candidateChat: deps.rag.chat,
        judgeChat: deps.rag.chat,
        embedder: deps.rag.embedder,
        ...(await (async () => {
          const block = renderVacanciesBlock(await new VacanciesRepo(deps.sql).listActive());
          return block ? { vacanciesBlock: block } : {};
        })()),
      },
      {
        evalId: evalRow.id,
        parentStyle,
        parentStyleId: parentRow.id,
        newStyle,
        newStyleId: newRow.id,
        personas,
        runs,
        maxTurns,
      },
    ).catch((err) => {
      console.warn(`[shadow-eval] runner crashed for eval #${evalRow.id}: ${err}`);
    });

    return json({ shadow_eval: evalRow });
  };
}

/** GET /admin/api/coach/:id/shadow-eval — latest eval status (polled). */
export function createGetShadowEvalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const shadowRepo = new ShadowEvaluationsRepo(deps.sql);
    const row = await shadowRepo.latestForProposal(id);
    return json({ shadow_eval: row });
  };
}
