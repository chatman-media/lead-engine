import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";

import { createRouter, type AppDeps } from "./app.ts";
import { currentAdmin } from "./admin/auth.ts";
import { AdminBus, type AdminWsData } from "./admin/bus.ts";

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

export interface CreateServerOptions extends Omit<AppDeps, "bus"> {
  port: number;
  /** Path of the WebSocket endpoint. Defaults to /admin/api/ws. */
  wsPath?: string;
  /** Serve admin-ui/dist for /admin/* paths. Defaults to SERVE_UI env var. */
  serveUi?: boolean;
}

export function createServer(opts: CreateServerOptions): Server {
  const wsPath = opts.wsPath ?? "/admin/api/ws";
  const shouldServeUi = opts.serveUi ?? process.env.SERVE_UI === "1";
  const bus = new AdminBus();
  const router = createRouter({ ...opts, bus });
  const db = opts.db;

  return Bun.serve<AdminWsData, undefined>({
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === wsPath) {
        const ctx = currentAdmin(db, req);
        if (!ctx) return new Response("Unauthorized", { status: 401 });
        const ok = server.upgrade(req, { data: { adminId: ctx.adminId } });
        return ok
          ? undefined
          : new Response("Upgrade failed", { status: 500 });
      }

      // Serve SPA for /admin/* paths that are not API routes
      if (
        shouldServeUi &&
        url.pathname.startsWith("/admin/") &&
        !url.pathname.startsWith("/admin/api/")
      ) {
        const staticRes = await serveStatic(url.pathname);
        if (staticRes) return staticRes;
      }

      return router.handle(req);
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
