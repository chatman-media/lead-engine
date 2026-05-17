import { basename, join } from "node:path";
import { config } from "../../config.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
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

/**
 * Serves userbot-channel media from disk (`config.media.dir`).
 *
 * MTProto media has no Bot API file_id — the userbot downloads the bytes
 * once and references the filename in `messages.meta_json.media.file`
 * (see `handleInboundPhoto`). This endpoint resolves that filename for an
 * authenticated admin. The `<img>` tag in the chat view hits it directly;
 * admin session cookie authorises.
 *
 * Path-traversal guard: the filename is taken only from our own
 * `meta_json` (which we control), but it is still `basename`-stripped and
 * matched against `^[\w.-]+$` before being joined to the media dir.
 */
export function createMediaFileHandler(deps: AdminApiDeps): RouteHandler {
  const messages = new MessagesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = Number(params.messageId);
    if (!Number.isInteger(id) || id <= 0) {
      return json({ error: "bad message id" }, { status: 400 });
    }

    const msg = await messages.byId(id);
    if (!msg?.meta_json) return json({ error: "not found" }, { status: 404 });

    let file: string | undefined;
    try {
      const meta = JSON.parse(msg.meta_json) as { media?: { file?: string } };
      file = meta.media?.file;
    } catch {
      return json({ error: "not found" }, { status: 404 });
    }
    if (!file || !/^[\w.-]+$/.test(file)) {
      return json({ error: "not found" }, { status: 404 });
    }

    const bunFile = Bun.file(join(config.media.dir, basename(file)));
    if (!(await bunFile.exists())) {
      return json({ error: "file missing" }, { status: 404 });
    }
    return new Response(bunFile, {
      status: 200,
      headers: {
        "content-type": bunFile.type || "image/jpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  });
}
