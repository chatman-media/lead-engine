import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { currentAdmin } from "./admin/auth.ts";
import { AdminBus, type AdminWsData } from "./admin/bus.ts";
import { type AppDeps, createRouter } from "./app.ts";

const UI_DIST = resolve(import.meta.dir, "../admin-ui/dist");

/** Serve a static file from admin-ui/dist, or null if not found. */
async function serveStatic(pathname: string): Promise<Response | null> {
  // strip leading /admin prefix, since Vite builds with base=/admin/
  const rel = pathname.replace(/^\/admin\/?/, "") || "index.html";
  const filePath = join(UI_DIST, rel);
  if (existsSync(filePath)) {
    return new Response(Bun.file(filePath));
  }
  // SPA fallback
  const indexPath = join(UI_DIST, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath));
  }
  return null;
}

/**
 * Standard security headers applied to every response served by this
 * process. CSP is the lock — admin SPA loads same-origin JS/CSS only,
 * inline `style="..."` attributes from React require `'unsafe-inline'`
 * for style-src (low risk), but no inline scripts so script-src stays
 * tight.
 *
 * `frame-ancestors 'none'` prevents clickjacking on the admin SPA.
 * `Strict-Transport-Security` is set unconditionally — production runs
 * behind ngrok/CF tunnel which terminates TLS, and HSTS on plaintext
 * dev (localhost) is harmless because browsers ignore HSTS for
 * loopback addresses.
 *
 * Telegram file proxy responses have a different CSP-frame profile,
 * but applying these headers globally is fine: image responses don't
 * execute CSP-restricted content anyway.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' for style-src is needed for React inline styles
    // (`style={{...}}`). No inline `<style>` blocks elsewhere — limited blast radius.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // wss: for the AdminWs connection on the same origin — Bun upgrades
    // ws/wss based on the request scheme so listing both keeps dev (ws)
    // and prod (wss) working.
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  // HSTS: 1 year, with subdomains. Browsers ignore on http://localhost
  // so this is safe for dev too. preload omitted — let ops opt in later.
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // Telegram bot itself has no need for browser features; lock all of
  // them down. Comma-separated list per the Permissions-Policy spec.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/** Wraps a Response so every outbound message carries the security
 *  headers above. Existing headers on the response take precedence so
 *  per-route overrides (e.g. `cache-control: no-store`) still work. */
function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export interface CreateServerOptions extends AppDeps {
  port: number;
  /** Path of the WebSocket endpoint. Defaults to /admin/api/ws. */
  wsPath?: string;
  /** Serve admin-ui/dist for /admin/* paths. Defaults to SERVE_UI env var. */
  serveUi?: boolean;
}

export function createServer(opts: CreateServerOptions): Server<AdminWsData> {
  const wsPath = opts.wsPath ?? "/admin/api/ws";
  const shouldServeUi = opts.serveUi ?? process.env.SERVE_UI === "1";
  // Caller may supply a shared bus (so it can also forward events from the
  // userbot subprocess); otherwise own one.
  const bus = opts.bus ?? new AdminBus();
  const router = createRouter({ ...opts, bus });
  const sql = opts.sql;

  return Bun.serve<AdminWsData>({
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === wsPath) {
        const ctx = await currentAdmin(sql, req);
        if (!ctx) return new Response("Unauthorized", { status: 401 });
        const ok = server.upgrade(req, { data: { adminId: ctx.adminId } });
        return ok ? undefined : new Response("Upgrade failed", { status: 500 });
      }

      // Redirect bare /admin to /admin/ — the SPA is built with Vite
      // base=/admin/, so relative asset URLs only resolve under the slash.
      if (shouldServeUi && url.pathname === "/admin") {
        const dest = new URL(url);
        dest.pathname = "/admin/";
        return Response.redirect(dest.toString(), 308);
      }

      // Serve SPA for /admin/* paths that are not API routes
      if (
        shouldServeUi &&
        url.pathname.startsWith("/admin/") &&
        !url.pathname.startsWith("/admin/api/")
      ) {
        const staticRes = await serveStatic(url.pathname);
        if (staticRes) return withSecurityHeaders(staticRes);
      }

      return withSecurityHeaders(await router.handle(req));
    },
    websocket: {
      open(ws: ServerWebSocket<AdminWsData>) {
        bus.add(ws);
      },
      close(ws: ServerWebSocket<AdminWsData>) {
        bus.remove(ws);
      },
      message() {
        // Admin clients are receive-only for now.
      },
    },
  });
}
