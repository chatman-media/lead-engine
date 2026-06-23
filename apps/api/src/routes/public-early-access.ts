import { earlyAccessSignups } from "@chatman-media/storage";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Context } from "hono";
import { Hono } from "hono";

export interface PublicEarlyAccessRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
}

interface EarlyAccessBody {
  email?: unknown;
  name?: unknown;
  company?: unknown;
  useCase?: unknown;
  source?: unknown;
  locale?: unknown;
  website?: unknown;
}

function applyCors(c: Context) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Vary", "Origin");
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.slice(0, max);
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || null;
}

export function makePublicEarlyAccessRoutes(opts: PublicEarlyAccessRoutesOpts): Hono {
  const app = new Hono();

  app.options("/api/public/early-access", (c) => {
    applyCors(c);
    return c.body(null, 204);
  });

  app.post("/api/public/early-access", async (c) => {
    applyCors(c);

    let body: EarlyAccessBody;
    try {
      body = (await c.req.json()) as EarlyAccessBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body.website === "string" && body.website.trim().length > 0) {
      return c.json({ ok: true });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "invalid email" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const name = cleanText(body.name, 120);
    const company = cleanText(body.company, 160);
    const useCase = cleanText(body.useCase, 1200);
    const source = cleanText(body.source, 80) ?? "landing_alpha";
    const locale = cleanText(body.locale, 12) ?? "ru";
    const userAgent = cleanText(c.req.header("user-agent"), 400);
    const ip = cleanText(clientIp(c), 120);

    const updateSet: Partial<typeof earlyAccessSignups.$inferInsert> = {
      source,
      locale,
      userAgent,
      ip,
      updatedAt: now,
    };
    if (name !== null) updateSet.name = name;
    if (company !== null) updateSet.company = company;
    if (useCase !== null) updateSet.useCase = useCase;

    const [row] = await opts.db
      .insert(earlyAccessSignups)
      .values({
        email,
        name,
        company,
        useCase,
        source,
        locale,
        userAgent,
        ip,
        metaJson: JSON.stringify({
          referrer: c.req.header("referer") ?? null,
        }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: earlyAccessSignups.email,
        set: updateSet,
      })
      .returning({
        id: earlyAccessSignups.id,
        email: earlyAccessSignups.email,
        status: earlyAccessSignups.status,
      });

    return c.json({ ok: true, item: row }, 200);
  });

  return app;
}
