/**
 * StaleleadSweeper.sweep — интеграция: лид, провисевший на активной стадии
 * дольше stale_timeout_days, закрывается в первую terminal_lost стадию +
 * lead_event + notification. Требует DATABASE_URL; без него — graceful-skip.
 */
import {
  applyAllMigrations,
  contacts,
  createIsolatedDb,
  funnels,
  leadEvents,
  leads,
  schema,
  stageDefinitions,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { StaleleadSweeper } from "./stale-lead-sweep.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_stale_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantId = 0;
let activeStageId = 0;
let lostStageId = 0;

const runSweep = (s: StaleleadSweeper) => (s as unknown as { sweep: () => Promise<void> }).sweep();

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 3,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);

  const [t] = await db
    .insert(tenants)
    .values({ slug: `stale-${n}`, status: "active" })
    .returning({ id: tenants.id });
  tenantId = t!.id;

  const [f] = await db
    .insert(funnels)
    .values({ tenantId, slug: "main", isActive: true, createdAt: n, updatedAt: n })
    .returning({ id: funnels.id });

  const [active] = await db
    .insert(stageDefinitions)
    .values({
      tenantId,
      funnelId: f!.id,
      slug: "qualify",
      displayName: "Qualify",
      kind: "active",
      stageType: "form_fill",
      position: 1,
      staleTimeoutDays: 7,
      nextStages: [],
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: stageDefinitions.id });
  activeStageId = active!.id;

  const [lost] = await db
    .insert(stageDefinitions)
    .values({
      tenantId,
      funnelId: f!.id,
      slug: "lost",
      displayName: "Lost",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 9,
      nextStages: [],
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: stageDefinitions.id });
  lostStageId = lost!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

async function makeLead(updatedAt: number): Promise<number> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, displayName: `c-${Math.random().toString(36).slice(2, 8)}`, createdAt: n })
    .returning({ id: contacts.id });
  const [l] = await db
    .insert(leads)
    .values({
      tenantId,
      userId: c!.id,
      state: "qualify",
      stageDefinitionId: activeStageId,
      createdAt: updatedAt,
      updatedAt,
    })
    .returning({ id: leads.id });
  return l!.id;
}

describe("StaleleadSweeper.sweep (integration)", () => {
  it("просроченный лид → terminal_lost + lead_event + notification", async () => {
    if (!enabled) return;
    const staleAt = n - 10 * 86400; // 10 дней назад > 7-дневного таймаута
    const staleLeadId = await makeLead(staleAt);
    const freshLeadId = await makeLead(n); // свежий — не трогаем

    const events: Array<{ eventType: string; leadId?: number }> = [];
    const sweeper = new StaleleadSweeper(db, {
      intervalMs: 1000,
      notifications: {
        notify: async (e: { eventType: string; leadId?: number }) => {
          events.push(e);
        },
      } as never,
    });

    await runSweep(sweeper);

    const [stale] = await db
      .select({ stageDefinitionId: leads.stageDefinitionId, state: leads.state })
      .from(leads)
      .where(eq(leads.id, staleLeadId));
    expect(stale!.stageDefinitionId).toBe(lostStageId);
    expect(stale!.state).toBe("lost");

    const [fresh] = await db
      .select({ stageDefinitionId: leads.stageDefinitionId })
      .from(leads)
      .where(eq(leads.id, freshLeadId));
    expect(fresh!.stageDefinitionId).toBe(activeStageId); // не тронут

    const evs = await db
      .select({ toState: leadEvents.toState })
      .from(leadEvents)
      .where(and(eq(leadEvents.tenantId, tenantId), eq(leadEvents.leadId, staleLeadId)));
    expect(evs.some((e) => e.toState === "lost")).toBe(true);

    expect(events.some((e) => e.eventType === "lead_stale" && e.leadId === staleLeadId)).toBe(true);
  });

  it("повторный sweep идемпотентен (нет новых просроченных)", async () => {
    if (!enabled) return;
    const sweeper = new StaleleadSweeper(db, { intervalMs: 1000 });
    // не должно бросать; ранее закрытые лиды уже terminal_lost (исключены из выборки)
    await runSweep(sweeper);
    expect(true).toBe(true);
  });
});
