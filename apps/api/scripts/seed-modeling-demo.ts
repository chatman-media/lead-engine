#!/usr/bin/env bun
/**
 * Demo-сид вертикали «Модельное агентство» — тенант «ModelingAgency Demo» с
 * воронкой из шаблона "modeling" (intake→casting→offer→contract→show), лидами
 * по всем стадиям и диалогами с сообщениями.
 *
 * Создаёт:
 *   - тенант  modeling-demo (active)
 *   - администратор (пароль: test1234):
 *       lena@demo.io      — «Лена Скаут» (superadmin / владелец)
 *       casting@demo.io   — «Кастинг Директор» (manager)
 *   - воронку из шаблона "modeling"
 *   - ~10 лидов по стадиям с диалогами
 *
 * Идемпотентно: при повторном запуске пере-создаёт демо-данные тенанта.
 *
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *     bun run apps/api/scripts/seed-modeling-demo.ts
 */

import { withTenant } from "@chatman-media/conversation-engine";
import {
  admins,
  channels,
  contacts,
  conversations,
  leads,
  llmProviderConfigs,
  messages,
  stageDefinitions,
  tenants,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashPassword } from "../src/lib/auth.ts";
import { seedFunnelByKey } from "../src/routes/admin-funnel.ts";

const SLUG = "modeling-demo";
const url =
  process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5434/lead_engine";
const client = postgres(url, { max: 2, prepare: false });
// biome-ignore lint/suspicious/noExplicitAny: seed script
const db = drizzle(client) as any;
const now = Math.floor(Date.now() / 1000);

type Msg = { role: "user" | "assistant" | "human"; text: string };
type LeadSpec = {
  stage: string;
  name: string;
  operator?: boolean;
  msgs: Msg[];
};

const SAMPLE: LeadSpec[] = [
  {
    stage: "intake",
    name: "Алина Смирнова",
    msgs: [
      { role: "user", text: "Добрый день, хочу попробовать себя в модельном бизнесе" },
      { role: "assistant", text: "Привет, Алина! Отлично 🌟 Расскажи немного — сколько лет, какой рост и откуда ты?" },
    ],
  },
  {
    stage: "intake",
    name: "Карина Попова",
    msgs: [
      { role: "user", text: "Меня интересует работа в Дубае, это возможно?" },
      { role: "assistant", text: "Привет! Да, мы работаем с Дубаем и Стамбулом. Заполни анкету — это первый шаг 👇" },
    ],
  },
  {
    stage: "portfolio_review",
    name: "Дарья Иванова",
    msgs: [
      { role: "user", text: "Анкету заполнила, когда ответите?" },
      { role: "assistant", text: "Даша, анкету получили! Теперь пришли 3–5 фото (лицо + полный рост) и короткое видео 30–60 сек." },
      { role: "user", text: "Хорошо, скину сегодня вечером" },
    ],
  },
  {
    stage: "portfolio_review",
    name: "Виктория Козлова",
    msgs: [
      { role: "user", text: "Вот мои фото" },
      { role: "assistant", text: "Получила, спасибо 🙌 Передаю кастинг-директору — ответим в течение 2–3 дней." },
    ],
  },
  {
    stage: "go_see",
    name: "Полина Медведева",
    msgs: [
      { role: "user", text: "Отлично, когда кастинг?" },
      { role: "assistant", text: "Кастинг в пятницу 14 июня в 15:00, офис на Патонге, ул. Рат Утит 200 Пай. Возьми паспорт." },
      { role: "user", text: "Буду!" },
    ],
  },
  {
    stage: "go_see",
    name: "Анастасия Фёдорова",
    operator: true,
    msgs: [
      { role: "user", text: "Мне 17 лет, можно участвовать?" },
      { role: "assistant", text: "Да, с 16 лет. Для несовершеннолетних нужно согласие родителей. Передаю кастинг-директору." },
      { role: "human", text: "Анастасия, здравствуйте! Пришлите, пожалуйста, контакт родителя — обсудим формат участия." },
    ],
  },
  {
    stage: "contract",
    name: "Марина Орлова",
    msgs: [
      { role: "user", text: "Кастинг прошла, что дальше?" },
      { role: "assistant", text: "Поздравляем! 🎉 Кастинг-директор одобрил. Готовим контракт — пришлю для ознакомления." },
    ],
  },
  {
    stage: "active_representation",
    name: "Юлия Белова",
    msgs: [
      { role: "user", text: "Контракт подписала!" },
      { role: "assistant", text: "Добро пожаловать в агентство, Юля! 🌟 Первый показ — 20 июня в Dubai Mall. Детали пришлём отдельно." },
    ],
  },
  {
    stage: "not_suitable",
    name: "Светлана Громова",
    msgs: [
      { role: "user", text: "Мне 14 лет, берёте?" },
      { role: "assistant", text: "Привет! К сожалению, минимальный возраст — 16 лет. Можем вернуться к разговору через 2 года 🙏" },
    ],
  },
];

async function upsertTenant(): Promise<number> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, SLUG));
  if (existing) return existing.id as number;
  const [t] = await db
    .insert(tenants)
    .values({
      slug: SLUG,
      plan: "free",
      status: "active",
      llmBillingMode: "byok",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tenants.id });
  return t!.id as number;
}

async function upsertAdmin(
  tenantId: number,
  email: string,
  name: string,
  role: "superadmin" | "manager",
): Promise<number> {
  const passwordHash = await hashPassword("test1234");
  const [existing] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.email, email));
  if (existing) {
    await db
      .update(admins)
      .set({ name, role, tenantId, passwordHash })
      .where(eq(admins.id, existing.id));
    return existing.id as number;
  }
  const [a] = await db
    .insert(admins)
    .values({ tenantId, email, name, role, passwordHash, createdAt: now })
    .returning({ id: admins.id });
  return a!.id as number;
}

async function main() {
  const tenantId = await upsertTenant();
  console.log(`[seed] tenant ${SLUG} → id=${tenantId}`);

  const lenaId = await upsertAdmin(tenantId, "lena@demo.io", "Лена Скаут", "superadmin");
  const castingId = await upsertAdmin(tenantId, "casting@demo.io", "Кастинг Директор", "manager");
  console.log(`[seed] admins: lena=${lenaId} casting=${castingId}`);

  await withTenant(db, tenantId, async (tx: any) => {
    await tx
      .insert(channels)
      .values({ tenantId, kind: "web", externalId: SLUG, status: "active", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await tx
      .insert(llmProviderConfigs)
      .values({ tenantId, purpose: "chat", provider: "openai", model: "gpt-4o-mini", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
  });

  // Чистим прежние демо-данные тенанта.
  await withTenant(db, tenantId, async (tx: any) => {
    await tx.delete(contacts).where(eq(contacts.tenantId, tenantId));
  });

  // Воронка из шаблона "modeling".
  const seeded = await seedFunnelByKey(db, tenantId, "modeling", lenaId);
  if ("error" in seeded) throw new Error(`seedFunnel: ${seeded.error}`);
  console.log(`[seed] modeling funnel: ${seeded.stagesCreated} стадий`);

  const stageRows = await withTenant(db, tenantId, async (tx: any) =>
    tx
      .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.funnelId, seeded.funnelId)),
  );
  const stageId = new Map<string, number>(
    stageRows.map((s: { id: number; slug: string }) => [s.slug, s.id]),
  );

  let leadCount = 0;
  let msgCount = 0;
  await withTenant(db, tenantId, async (tx: any) => {
    for (let i = 0; i < SAMPLE.length; i++) {
      const spec = SAMPLE[i]!;
      const sid = stageId.get(spec.stage);
      if (!sid) {
        console.warn(`[seed] нет стадии "${spec.stage}", пропуск ${spec.name}`);
        continue;
      }
      const createdAt = now - (SAMPLE.length - i) * 3600;

      const [ct] = await tx
        .insert(contacts)
        .values({ tenantId, displayName: spec.name, attributesJson: "{}", createdAt, updatedAt: createdAt })
        .returning({ id: contacts.id });
      const contactId = ct!.id as number;

      const [ld] = await tx
        .insert(leads)
        .values({ tenantId, userId: contactId, state: spec.stage, stageDefinitionId: sid, createdAt, updatedAt: createdAt })
        .returning({ id: leads.id });
      const _leadId = ld!.id as number;
      leadCount++;

      const last = spec.msgs[spec.msgs.length - 1]!;
      const lastAt = createdAt + (spec.msgs.length - 1) * 120;
      const onOperator = spec.operator === true;
      const [cv] = await tx
        .insert(conversations)
        .values({
          tenantId, userId: contactId, source: "bot",
          mode: onOperator ? "human" : "ai",
          status: onOperator ? "pending" : "open",
          unreadCount: last.role === "user" ? 1 : 0,
          lastMessageText: last.text,
          lastMessageAt: lastAt,
          currentStage: spec.stage,
          assignedAdminId: onOperator ? castingId : null,
          escalatedAt: onOperator ? createdAt + 60 : null,
          createdAt,
        })
        .returning({ id: conversations.id });
      const convId = cv!.id as number;

      for (let j = 0; j < spec.msgs.length; j++) {
        const m = spec.msgs[j]!;
        await tx.insert(messages).values({
          tenantId, conversationId: convId, role: m.role,
          text: m.text, stage: spec.stage, createdAt: createdAt + j * 120,
        });
        msgCount++;
      }
    }
  });

  console.log(`[seed] готово: ${leadCount} лидов, ${msgCount} сообщений`);
  console.log("\nЛогины (пароль: test1234):");
  console.log("  Лена Скаут        → lena@demo.io       (владелец)");
  console.log("  Кастинг Директор  → casting@demo.io    (оператор)");

  await client.end({ timeout: 0 });
}

main().catch((err) => {
  console.error("[seed] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
