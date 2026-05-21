import { Hono } from "hono";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

/**
 * `/healthz` — простой liveness/readiness probe. Делает SELECT 1 с
 * timeout'ом. Fly.io и Cloudflare healthchecks смотрят на него.
 */
export function makeHealthRoutes(opts: {
  db: PostgresJsDatabase<Record<string, never>>;
  timeoutMs: number;
}): Hono {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    try {
      await Promise.race([
        opts.db.execute(sql`SELECT 1`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("db check timeout")), opts.timeoutMs),
        ),
      ]);
      return c.json({ status: "ok" });
    } catch (err) {
      return c.json(
        { status: "error", reason: err instanceof Error ? err.message : "unknown" },
        503,
      );
    }
  });

  app.get("/readyz", (c) => c.json({ status: "ok" }));

  return app;
}
