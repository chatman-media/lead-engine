import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import {
  type AdminApiDeps,
  buildExportHeaders,
  EXPORT_BULK_LIMIT_DEFAULT,
  EXPORT_BULK_LIMIT_MAX,
  type ExportedConversation,
  fillExportMessages,
  jsonlResponse,
  parseIntParam,
} from "../shared.ts";

export function createExportConversationHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    const headers = await buildExportHeaders(deps.sql, [id]);
    if (headers.size === 0) return json({ error: "not found" }, { status: 404 });
    await fillExportMessages(deps.sql, headers);

    const conv = [...headers.values()][0]!;
    return jsonlResponse([conv], `conversation-${id}.jsonl`);
  };
}

export function createBulkExportConversationsHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;

    const url = new URL(req.url);
    const styleId = parseIntParam(url.searchParams.get("style_id"));
    const experimentId = parseIntParam(url.searchParams.get("experiment_id"));
    const userStatus = url.searchParams.get("user_status")?.trim() || null;
    const mode = url.searchParams.get("mode")?.trim() || null;
    const requestedLimit = parseIntParam(url.searchParams.get("limit"));
    const limit = Math.min(
      Math.max(1, requestedLimit ?? EXPORT_BULK_LIMIT_DEFAULT),
      EXPORT_BULK_LIMIT_MAX,
    );

    // Build the query using postgres tagged templates with conditional clauses.
    const styleFilter = styleId !== null ? deps.sql`AND c.style_id = ${styleId}` : deps.sql``;
    const expFilter =
      experimentId !== null ? deps.sql`AND c.experiment_id = ${experimentId}` : deps.sql``;
    const statusFilter = userStatus ? deps.sql`AND u.status = ${userStatus}` : deps.sql``;
    const modeFilter = mode ? deps.sql`AND c.mode = ${mode}` : deps.sql``;

    const idRows = await deps.sql<{ id: number }[]>`
      SELECT c.id
      FROM conversations c
      JOIN users u ON u.id = c.user_id
      WHERE 1=1
        ${styleFilter}
        ${expFilter}
        ${statusFilter}
        ${modeFilter}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT ${limit}
    `;
    const ids = idRows.map((r) => r.id);

    const headers = await buildExportHeaders(deps.sql, ids);
    await fillExportMessages(deps.sql, headers);

    // Preserve the order from the SELECT (most recent first).
    const out = ids
      .map((id) => headers.get(id))
      .filter((c): c is ExportedConversation => c !== undefined);

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return jsonlResponse(out, `conversations-${stamp}.jsonl`);
  };
}
