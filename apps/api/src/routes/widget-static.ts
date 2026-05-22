import { Hono } from "hono";
import { resolve } from "node:path";

/**
 * Static serving для widget bundle + demo HTML. На production обычно
 * вообще не используется (CDN типа Cloudflare / S3 + CloudFront отдают
 * widget.js быстрее, см. WEB_WIDGET_SCRIPT_URL env). Но для dev / SMB
 * deploy без CDN — apps/api сам отдаёт.
 *
 * Файлы:
 *   GET /widget.js       — apps/widget/dist/widget.js (build artifact)
 *   GET /widget.js.map   — source map (доступен, debug-friendly)
 *   GET /demo/web-chat.html — legacy demo HTML (используется snippet'ом для smoke-test)
 *
 * Не используем Hono's serveStatic — он tied к специфическому runtime.
 * Вместо этого: вручную Bun.file() + явный allow-list путей.
 */

const WIDGET_DIST = resolve(import.meta.dir, "..", "..", "..", "widget", "dist");
const DEMO_DIR = resolve(import.meta.dir, "..", "..", "demo");

const ALLOWED: Record<string, { fsPath: string; contentType: string; cacheMaxAge: number }> = {
  "/widget.js": {
    fsPath: resolve(WIDGET_DIST, "widget.js"),
    contentType: "application/javascript; charset=utf-8",
    // Кешируем 5 минут — dev iteration friendly. В prod через CDN можно
    // долгий cache + version-via-query.
    cacheMaxAge: 300,
  },
  "/widget.js.map": {
    fsPath: resolve(WIDGET_DIST, "widget.js.map"),
    contentType: "application/json; charset=utf-8",
    cacheMaxAge: 300,
  },
  "/demo/web-chat.html": {
    fsPath: resolve(DEMO_DIR, "web-chat.html"),
    contentType: "text/html; charset=utf-8",
    cacheMaxAge: 60,
  },
};

export function makeWidgetStaticRoutes(): Hono {
  const app = new Hono();

  for (const [route, cfg] of Object.entries(ALLOWED)) {
    app.get(route, async (c) => {
      const file = Bun.file(cfg.fsPath);
      if (!(await file.exists())) {
        return c.json(
          {
            error: "file_not_found",
            hint:
              route === "/widget.js"
                ? "Run `bun --cwd apps/widget build` to generate dist/widget.js"
                : "file missing on filesystem",
          },
          404,
        );
      }
      return new Response(file, {
        headers: {
          "content-type": cfg.contentType,
          "cache-control": `public, max-age=${cfg.cacheMaxAge}`,
          // CORS — widget.js может загружаться с customer-домена.
          "access-control-allow-origin": "*",
        },
      });
    });
  }

  return app;
}
