import { json, type RouteHandler } from "../../router.ts";
import { withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Telegram file proxy (photos / videos / documents in admin chat) ──

/**
 * Streams a Telegram file (photo / video / voice / document) through
 * the bot to an authenticated admin. The browser's `<img>` / `<video>`
 * elements hit this same-origin URL; admin session cookies authorise.
 *
 * Two safety constraints beyond auth:
 *  1. The file_id MUST appear somewhere in `messages.meta_json.media`.
 *     Without this, an authenticated admin could enumerate arbitrary
 *     file_ids the bot has never been told about (still bounded by
 *     "things the bot has seen", but tighter is better).
 *  2. We pass the bot token through to Telegram via the client's
 *     `downloadFile`; the token never reaches the admin browser.
 *
 * Cache headers: `private, max-age=3600` — files are tied to the
 * candidate's chat (private), and Telegram regenerates the file_path
 * on each `getFile`, but the underlying bytes don't change.
 */
export function createDownloadFileHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    if (!deps.telegram) {
      return json({ error: "telegram client not configured" }, { status: 503 });
    }

    const fileId = params.fileId;
    if (!fileId || fileId.length > 200) {
      return json({ error: "bad file id" }, { status: 400 });
    }

    // Constraint 1: file_id must already be referenced by some message
    // we processed. We query via jsonb to find the file_id in meta_json.
    const [seenRow] = await deps.sql<{ count: number }[]>`
      SELECT COUNT(*)::INTEGER AS count FROM messages
      WHERE meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'file_id' = ${fileId}
    `;
    if (!seenRow || seenRow.count === 0) {
      return json({ error: "unknown file" }, { status: 404 });
    }

    let upstream: Response;
    try {
      upstream = await deps.telegram.downloadFile(fileId);
    } catch (err) {
      console.error(`[admin] downloadFile(${fileId}) failed:`, err);
      return json({ error: "download failed" }, { status: 502 });
    }
    if (!upstream.ok || !upstream.body) {
      return new Response("upstream error", {
        status: upstream.status || 502,
      });
    }

    // Forward content-type so the browser renders <img>/<video>
    // correctly. Telegram includes one for known media kinds; default
    // to octet-stream for unknown documents.
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": contentType,
      "cache-control": "private, max-age=3600",
    };
    const len = upstream.headers.get("content-length");
    if (len) headers["content-length"] = len;
    return new Response(upstream.body, { status: 200, headers });
  });
}
