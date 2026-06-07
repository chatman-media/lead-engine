/**
 * advanceLead — operator-in-the-loop продвижение лида на next_stages[0]:
 * lead.state/stage, lead_event, сообщение в чат, доставка в outbound (real-канал),
 * notify при awaiting_operator. Требует DATABASE_URL; без него — graceful-skip.
 */
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  funnels,
  leadEvents,
  leads,
  outboundQueue,
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
import { advanceLead } from "./advance-lead.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_advlead_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantId = 0;
let intakeId = 0;
let qualifyId = 0;
let opId = 0;

async function makeStage(
  funnelId: number,
  slug: string,
  kind: string,
  stageType: string,
  position: number,
  nextStages: string[],
) {
  const [s] = await db
    .insert(stageDefinitions)
    .values({
      tenantId,
      funnelId,
      slug,
      displayName: slug,
      kind,
      stageType,
      position,
      nextStages,
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: stageDefinitions.id });
  return s!.id;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [t] = await db
    .insert(tenants)
    .values({ slug: `advlead-${n}`, status: "active" })
    .returning({ id: tenants.id });
  tenantId = t!.id;
  const [f] = await db
    .insert(funnels)
    .values({ tenantId, slug: "main", isActive: true, createdAt: n, updatedAt: n })
    .returning({ id: funnels.id });
  intakeId = await makeStage(f!.id, "intake", "intake", "form_fill", 0, ["qualify"]);
  qualifyId = await makeStage(f!.id, "qualify", "active", "form_fill", 1, ["op"]);
  opId = await makeStage(f!.id, "op", "active", "awaiting_operator", 2, []);
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

async function makeLead(stageId: number, state: string): Promise<{ leadId: number; contactId: number }> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, displayName: `c-${Math.random().toString(36).slice(2, 8)}`, createdAt: n })
    .returning({ id: contacts.id });
  const [l] = await db
    .insert(leads)
    .values({
      tenantId,
      userId: c!.id,
      state,
      stageDefinitionId: stageId,
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: leads.id });
  return { leadId: l!.id, contactId: c!.id };
}

describe("advanceLead", () => {
  it("несуществующий лид → no_lead", async () => {
    if (!enabled) return;
    const r = await advanceLead({ db, tenantId, selector: { leadId: 9999999 } });
    expect(r.kind).toBe("no_lead");
  });

  it("терминальная стадия (нет nextStages) → terminal", async () => {
    if (!enabled) return;
    const { leadId } = await makeLead(opId, "op");
    const r = await advanceLead({ db, tenantId, selector: { leadId } });
    expect(r.kind).toBe("terminal");
  });

  it("happy: intake → qualify, lead обновлён + lead_event", async () => {
    if (!enabled) return;
    const { leadId } = await makeLead(intakeId, "intake");
    const r = await advanceLead({ db, tenantId, selector: { leadId } });
    expect(r.kind).toBe("advanced");
    if (r.kind !== "advanced") return;
    expect(r.from).toBe("intake");
    expect(r.to).toBe("qualify");
    const [lead] = await db
      .select({ state: leads.state, stage: leads.stageDefinitionId })
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(lead!.state).toBe("qualify");
    expect(lead!.stage).toBe(qualifyId);
    const evs = await db
      .select({ toState: leadEvents.toState })
      .from(leadEvents)
      .where(and(eq(leadEvents.tenantId, tenantId), eq(leadEvents.leadId, leadId)));
    expect(evs.some((e) => e.toState === "qualify")).toBe(true);
  });

  it("с диалогом + активным каналом → сообщение в чат + outbound доставка", async () => {
    if (!enabled) return;
    const { leadId, contactId } = await makeLead(intakeId, "intake");
    const [ch] = await db
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: `b-${n}-${leadId}`, status: "active", createdAt: n, updatedAt: n })
      .returning({ id: channels.id });
    await db
      .insert(channelIdentities)
      .values({ contactId, channelId: ch!.id, externalUserId: `tg-${leadId}`, createdAt: n });
    await db
      .insert(conversations)
      .values({ tenantId, userId: contactId, source: "bot", mode: "ai", lastMessageAt: n, createdAt: n });

    const r = await advanceLead({ db, tenantId, selector: { contactId }, note: "Переходим дальше!" });
    expect(r.kind).toBe("advanced");
    const queued = await db
      .select({ payload: outboundQueue.payloadJson })
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantId));
    expect(queued.some((q) => q.payload.includes("Переходим дальше"))).toBe(true);
  });

  it("self_play диалог → НЕ доставляется в outbound", async () => {
    if (!enabled) return;
    const { leadId, contactId } = await makeLead(intakeId, "intake");
    await db
      .insert(conversations)
      .values({ tenantId, userId: contactId, source: "self_play", mode: "ai", lastMessageAt: n, createdAt: n });
    const before = (
      await db.select({ id: outboundQueue.id }).from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId))
    ).length;
    const r = await advanceLead({ db, tenantId, selector: { leadId } });
    expect(r.kind).toBe("advanced");
    const after = (
      await db.select({ id: outboundQueue.id }).from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId))
    ).length;
    expect(after).toBe(before); // ничего не добавилось
  });

  it("вход в awaiting_operator → notify operator_confirm_needed", async () => {
    if (!enabled) return;
    const { leadId } = await makeLead(qualifyId, "qualify");
    const events: Array<{ eventType: string; leadId?: number }> = [];
    const r = await advanceLead({
      db,
      tenantId,
      selector: { leadId },
      notifications: {
        notify: async (e: { eventType: string; leadId?: number }) => {
          events.push(e);
        },
      } as never,
    });
    expect(r.kind).toBe("advanced");
    if (r.kind === "advanced") expect(r.awaitingOperator).toBe(true);
    expect(events.some((e) => e.eventType === "operator_confirm_needed" && e.leadId === leadId)).toBe(
      true,
    );
  });
});
