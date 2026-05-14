import { CoachProposalsRepo } from "../../db/repos/coach-proposals.ts";
import { SelfPlayMatchesRepo } from "../../db/repos/self-play-matches.ts";
import { SkillsRepo } from "../../db/repos/skills.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { json, type RouteHandler } from "../../router.ts";
import { applyEditsToStyle, proposeStyleEdits } from "../../sales/coach.ts";
import { type Style, StyleSchema } from "../../sales/types.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Coach-LLM proposals ──────────────────────────────────────────────

/** GET /admin/api/coach — list proposals (filter by style + status). */
export function createListCoachProposalsHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, url }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const repo = new CoachProposalsRepo(deps.sql);
    const styleSlug = url.searchParams.get("style") ?? undefined;
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const opts: Parameters<typeof repo.list>[0] = {
      limit: Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 100,
      ...(styleSlug ? { styleSlug } : {}),
      ...(status === "pending" || status === "applied" || status === "dismissed" ? { status } : {}),
    };
    return json({
      proposals: await repo.list(opts),
      pending_count: await repo.countPending(),
    });
  };
}

/** GET /admin/api/coach/:id — full proposal with parsed edits + rationale. */
export function createGetCoachProposalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const repo = new CoachProposalsRepo(deps.sql);
    const proposal = await repo.byId(id);
    if (!proposal) return json({ error: "not found" }, { status: 404 });
    return json({ proposal });
  };
}

/**
 * POST /admin/api/coach/run — runs proposeStyleEdits live and persists.
 * Body: { style_slug: string, sample?: number, persona?: string, model?: string }
 * Returns the freshly-created proposal row.
 *
 * Requires `deps.rag.chat` (LLM client). Returns 503 when unset, mirroring
 * the playground endpoint's contract.
 */
export function createRunCoachHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    if (!deps.rag?.chat) {
      return json(
        { error: "LLM not configured — set LLM_PROVIDER + provider creds" },
        { status: 503 },
      );
    }
    let body: {
      style_slug?: string;
      sample?: number;
      persona?: string;
      model?: string;
    };
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad json" }, { status: 400 });
    }
    const styleSlug = body.style_slug?.trim();
    if (!styleSlug) return json({ error: "style_slug required" }, { status: 400 });

    const stylesRepo = new StylesRepo(deps.sql);
    const styleRow = await stylesRepo.bySlug(styleSlug);
    if (!styleRow) return json({ error: `style not found: ${styleSlug}` }, { status: 404 });
    const style = stylesRepo.parseRow(styleRow) as Style;

    const sampleSize =
      typeof body.sample === "number" && body.sample > 0 && body.sample <= 50
        ? Math.floor(body.sample)
        : 8;
    const personaFilter = body.persona?.trim() || null;

    const skillsRepo = new SkillsRepo(deps.sql);
    const currentSkills = (await skillsRepo.skillsForStyle(styleRow.id)).map((r) => r.slug);

    const matchesRepo = new SelfPlayMatchesRepo(deps.sql);
    const proposal = await proposeStyleEdits({
      style,
      matchesRepo,
      chat: deps.rag.chat,
      sampleSize,
      ...(personaFilter ? { personaSlug: personaFilter } : {}),
      ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      currentSkills,
    });

    const repo = new CoachProposalsRepo(deps.sql);
    const row = await repo.insert({
      styleSlug,
      sampleSize,
      personaFilter,
      proposal,
    });
    return json({ proposal: { ...row, edits: proposal.edits, rationale: proposal.rationale } });
  };
}

/** POST /admin/api/coach/:id/decide — operator marks proposal applied/dismissed.
 *  Body: { status: 'applied' | 'dismissed' }. Idempotent: 409 if already decided. */
export function createDecideCoachProposalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    let body: { status?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad json" }, { status: 400 });
    }
    if (body.status !== "applied" && body.status !== "dismissed") {
      return json({ error: "status must be 'applied' or 'dismissed'" }, { status: 400 });
    }
    const repo = new CoachProposalsRepo(deps.sql);
    const ok = await repo.decide({ id, status: body.status, adminId: ctx.adminId });
    if (!ok) {
      // Either not found OR already decided — distinguish for better UX.
      const existing = await repo.byId(id);
      if (!existing) return json({ error: "not found" }, { status: 404 });
      return json({ error: `already ${existing.status}` }, { status: 409 });
    }
    return json({ proposal: await repo.byId(id) });
  };
}

/**
 * POST /admin/api/coach/:id/apply — fork a NEW VERSION of the style with the
 * proposal's edits applied. Body (optional): { skip_skills?: boolean }.
 *
 * Steps (atomic-ish — DB ops in single transaction):
 *   1. Look up the proposal; must be status='pending'.
 *   2. Find the active style row by slug.
 *   3. applyEditsToStyle(currentStyle, edits) → newStyle
 *   4. StyleSchema.parse(newStyle) — guard against drift
 *   5. StylesRepo.editAsNewVersion(currentRowId, newStyle) — fresh row,
 *      old marked is_active=0, conversations pinned to old keep working.
 *   6. Apply skills_attach / skills_detach via SkillsRepo.setSkillsForStyle
 *      against the NEW row id (unless body.skip_skills is true).
 *   7. Mark proposal status='applied' with the admin id.
 *
 * Returns: { proposal, new_style: { id, slug, version } }
 */
export function createApplyCoachProposalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    let body: { skip_skills?: boolean } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      // Empty body is fine — the endpoint has no required fields.
    }

    const proposalsRepo = new CoachProposalsRepo(deps.sql);
    const proposal = await proposalsRepo.byId(id);
    if (!proposal) return json({ error: "not found" }, { status: 404 });
    if (proposal.status !== "pending") {
      return json({ error: `already ${proposal.status}` }, { status: 409 });
    }

    const stylesRepo = new StylesRepo(deps.sql);
    const currentRow = await stylesRepo.bySlug(proposal.style_slug);
    if (!currentRow) {
      return json({ error: `style not found: ${proposal.style_slug}` }, { status: 404 });
    }
    const currentStyle = stylesRepo.parseRow(currentRow) as Style;

    const newStyle = applyEditsToStyle(currentStyle, proposal.edits);
    const validation = StyleSchema.safeParse(newStyle);
    if (!validation.success) {
      return json(
        {
          error: "applied edits produced an invalid style — refusing to fork",
          issues: validation.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 },
      );
    }

    let newRow: { id: number; slug: string; version: number };
    try {
      const inserted = await stylesRepo.editAsNewVersion(currentRow.id, validation.data);
      newRow = { id: inserted.id, slug: inserted.slug, version: inserted.version };
    } catch (err) {
      return json(
        { error: `editAsNewVersion failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    // Apply skills_attach / skills_detach against the NEW row's id. Strategy:
    // start from the parent's attached set, add proposal.edits.skills_attach,
    // remove proposal.edits.skills_detach, then setSkillsForStyle replaces
    // the new row's attachments atomically.
    if (!body.skip_skills) {
      const skillsRepo = new SkillsRepo(deps.sql);
      const currentAttached = new Set(
        (await skillsRepo.skillsForStyle(currentRow.id)).map((s) => s.slug),
      );
      for (const slug of proposal.edits.skills_attach ?? []) {
        currentAttached.add(slug);
      }
      for (const slug of proposal.edits.skills_detach ?? []) {
        currentAttached.delete(slug);
      }
      try {
        await skillsRepo.setSkillsForStyle(newRow.id, [...currentAttached]);
      } catch (err) {
        // Skill attachment failure shouldn't roll back the style fork — the
        // operator can re-attach via /admin/styles/:id/skills. Log only.
        console.warn(`[coach-apply] setSkillsForStyle failed: ${err}`);
      }
    }

    const decided = await proposalsRepo.decide({
      id,
      status: "applied",
      adminId: ctx.adminId,
    });
    if (!decided) {
      // Race: another admin decided between our byId and now. Style fork
      // is already done — leave it; surface the conflict.
      return json(
        {
          error: "proposal status changed concurrently — style was forked but proposal not marked",
          new_style: newRow,
        },
        { status: 409 },
      );
    }

    return json({
      proposal: await proposalsRepo.byId(id),
      new_style: newRow,
    });
  };
}

/** POST /admin/api/coach/:id/rollback — deactivate the new version,
 *  reactivate the parent. Conversations pinned to the new version keep
 *  working (FK is to row id, not slug — version chain semantics). */
export function createRollbackCoachProposalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const proposalsRepo = new CoachProposalsRepo(deps.sql);
    const proposal = await proposalsRepo.byId(id);
    if (!proposal) return json({ error: "proposal not found" }, { status: 404 });
    if (proposal.status !== "applied") {
      return json(
        { error: `only applied proposals can be rolled back (current: ${proposal.status})` },
        { status: 409 },
      );
    }
    const stylesRepo = new StylesRepo(deps.sql);
    const newRow = await stylesRepo.bySlug(proposal.style_slug);
    if (!newRow || newRow.parent_id === null) {
      return json({ error: "no parent version" }, { status: 409 });
    }
    const parentRow = await stylesRepo.byId(newRow.parent_id);
    if (!parentRow) return json({ error: "parent missing" }, { status: 404 });

    await deps.sql.begin(async (sql) => {
      await sql`UPDATE styles SET is_active = FALSE WHERE id = ${newRow.id}`;
      await sql`UPDATE styles SET is_active = TRUE WHERE id = ${parentRow.id}`;
    });

    return json({
      ok: true,
      deactivated: { id: newRow.id, slug: newRow.slug, version: newRow.version },
      reactivated: { id: parentRow.id, slug: parentRow.slug, version: parentRow.version },
    });
  };
}

/** DELETE /admin/api/coach/:id — clear noisy proposals. */
export function createDeleteCoachProposalHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const proposalsRepo = new CoachProposalsRepo(deps.sql);
    const ok = await proposalsRepo.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  };
}
