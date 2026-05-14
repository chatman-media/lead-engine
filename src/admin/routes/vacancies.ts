import { VacanciesRepo } from "../../db/repos/vacancies.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Vacancies (admin-managed list of currently-open offers) ───────────

const VACANCY_TITLE_MAX = 200;
const VACANCY_BODY_MAX = 4000;
const VACANCY_URL_MAX = 500;

export function createListVacanciesHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req }) => {
    const url = new URL(req.url);
    // Default = all (operators want to see closed too, to re-enable);
    // ?active=1 narrows for any internal callers that need the same
    // shape the bot uses.
    const onlyActive = url.searchParams.get("active") === "1";
    const list = onlyActive ? await vacancies.listActive() : await vacancies.listAll();
    return json({ vacancies: list });
  });
}

export function createCreateVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req }) => {
    const body = await parseJsonBody<{
      title?: unknown;
      body?: unknown;
      url?: unknown;
      is_active?: unknown;
    }>(req);
    if (body instanceof Response) return body;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!title) return json({ error: "title is required" }, { status: 400 });
    if (!text) return json({ error: "body is required" }, { status: 400 });
    if (title.length > VACANCY_TITLE_MAX) {
      return json({ error: `title > ${VACANCY_TITLE_MAX}` }, { status: 400 });
    }
    if (text.length > VACANCY_BODY_MAX) {
      return json({ error: `body > ${VACANCY_BODY_MAX}` }, { status: 400 });
    }
    let url: string | null = null;
    if (typeof body.url === "string") {
      const trimmed = body.url.trim();
      if (trimmed.length > VACANCY_URL_MAX) {
        return json({ error: `url > ${VACANCY_URL_MAX}` }, { status: 400 });
      }
      url = trimmed || null;
    }

    const created = await vacancies.create({
      title,
      body: text,
      url,
      isActive: body.is_active !== false,
    });
    return json({ vacancy: created });
  });
}

export function createUpdateVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const body = await parseJsonBody<{
      title?: unknown;
      body?: unknown;
      url?: unknown;
      is_active?: unknown;
    }>(req);
    if (body instanceof Response) return body;
    const patch: {
      title?: string;
      body?: string;
      url?: string | null;
      isActive?: boolean;
    } = {};
    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (!trimmed) return json({ error: "title is empty" }, { status: 400 });
      if (trimmed.length > VACANCY_TITLE_MAX) {
        return json({ error: `title > ${VACANCY_TITLE_MAX}` }, { status: 400 });
      }
      patch.title = trimmed;
    }
    if (typeof body.body === "string") {
      const trimmed = body.body.trim();
      if (!trimmed) return json({ error: "body is empty" }, { status: 400 });
      if (trimmed.length > VACANCY_BODY_MAX) {
        return json({ error: `body > ${VACANCY_BODY_MAX}` }, { status: 400 });
      }
      patch.body = trimmed;
    }
    if (typeof body.url === "string") {
      const trimmed = body.url.trim();
      if (trimmed.length > VACANCY_URL_MAX) {
        return json({ error: `url > ${VACANCY_URL_MAX}` }, { status: 400 });
      }
      patch.url = trimmed || null;
    } else if (body.url === null) {
      patch.url = null;
    }
    if (typeof body.is_active === "boolean") {
      patch.isActive = body.is_active;
    }
    const updated = await vacancies.update(id, patch);
    if (!updated) return json({ error: "not found" }, { status: 404 });
    return json({ vacancy: updated });
  });
}

export function createDeleteVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const ok = await vacancies.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  });
}
