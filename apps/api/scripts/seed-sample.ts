#!/usr/bin/env bun
/**
 * Sample-сид для локального просмотра: демо-тенант «Олег Обменников» со
 * скелет-воронкой (универсальный костяк), лидами по всем фазам и диалогами
 * с сообщениями — чтобы было что смотреть в «Лиды» и «Диалоги».
 *
 * Создаёт:
 *   - тенант  oleg-demo (active)
 *   - админов (пароль у всех: test1234):
 *       oleg@demo.io      — владелец «Олег Обменников» (superadmin)
 *       operator@demo.io  — «Оператор Смены» (manager) — ведёт эскалации
 *   - воронку из шаблона "skeleton" (capture→qualify→offer→clear→fulfill→won/lost)
 *   - ~11 лидов, разложенных по фазам, с диалогами (часть — на операторе)
 *
 * Идемпотентно: при повторном запуске пере-создаёт демо-данные тенанта.
 *
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *     bun run apps/api/scripts/seed-sample.ts
 */

import { withTenant } from "@chatman-media/conversation-engine";
import {
  admins,
  channels,
  contacts,
  conversations,
  leadFieldValues,
  leads,
  llmProviderConfigs,
  messages,
  stageDefinitions,
  stageFields,
  tenants,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashPassword } from "../src/lib/auth.ts";
import { seedFunnelByKey } from "../src/routes/admin-funnel.ts";

const SLUG = "oleg-demo";
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
  /** ведёт оператор (эскалация в human-режим) */
  operator?: boolean;
  msgs: Msg[];
};

// Лиды обменника по фазам костяка. operator:true → диалог на операторе.
const SAMPLE: LeadSpec[] = [
  {
    stage: "new",
    name: "Игорь Петров",
    msgs: [
      { role: "user", text: "Здравствуйте! Меняете USDT на баты?" },
      {
        role: "assistant",
        text: "Здравствуйте! Да, USDT (TRC20) → THB. Какая сумма интересует?",
      },
    ],
  },
  {
    stage: "new",
    name: "Марина Соколова",
    msgs: [
      { role: "user", text: "Привет, нужен обмен. Вы в Пхукете?" },
      {
        role: "assistant",
        text: "Здравствуйте! Да, офис в Банг Тао. Что меняем и на сколько?",
      },
    ],
  },
  {
    stage: "new",
    name: "Дмитрий Орлов",
    msgs: [{ role: "user", text: "Какой курс на сегодня?" }],
  },
  {
    stage: "qualify",
    name: "Алексей Кузнецов",
    msgs: [
      { role: "user", text: "Хочу обменять 500 USDT" },
      {
        role: "assistant",
        text: "Принято, 500 USDT TRC20. Получение наличными в офисе или на карту?",
      },
      { role: "user", text: "Наличными в офисе" },
    ],
  },
  {
    stage: "qualify",
    name: "Ольга Васильева",
    msgs: [
      { role: "user", text: "Нужно поменять рубли на баты, 80 000 ₽" },
      {
        role: "assistant",
        text: "Хорошо. Перевод на российскую карту, выдача — THB наличными. Когда удобно?",
      },
    ],
  },
  {
    stage: "offer",
    name: "Сергей Морозов",
    msgs: [
      { role: "user", text: "Сколько получу за 1000 USDT?" },
      {
        role: "assistant",
        text: "Курс 31.04. За 1000 USDT → 31 040 THB. Зафиксировать?",
      },
      { role: "user", text: "Дайте подумать 10 минут" },
    ],
  },
  {
    stage: "offer",
    name: "Анна Лебедева",
    msgs: [
      {
        role: "assistant",
        text: "Ваш курс: 335 USDT → 10 400 THB. Готовы подтвердить заявку?",
      },
      { role: "user", text: "Да, подтверждаю" },
    ],
  },
  {
    stage: "clear",
    name: "Виктор Зайцев",
    operator: true,
    msgs: [
      { role: "user", text: "Подтверждаю обмен на 5000 USDT" },
      {
        role: "assistant",
        text: "Для суммы свыше 3000 USDT нужна верификация. Передаю оператору.",
      },
      {
        role: "human",
        text: "Виктор, здравствуйте. Пришлите, пожалуйста, фото паспорта для KYC.",
      },
    ],
  },
  {
    stage: "fulfill",
    name: "Екатерина Новикова",
    operator: true,
    msgs: [
      { role: "user", text: "Перевёл USDT, хеш отправил" },
      {
        role: "human",
        text: "Платёж вижу, подтверждаю. Выдача THB готова — подходите в офис, код 4471.",
      },
    ],
  },
  {
    stage: "won",
    name: "Павел Михайлов",
    msgs: [
      { role: "user", text: "Всё получил, спасибо!" },
      { role: "assistant", text: "Спасибо за обмен! Ждём вас снова 🙌" },
    ],
  },
  {
    stage: "lost",
    name: "Роман Семёнов",
    msgs: [
      { role: "user", text: "Передумал, курс не устроил" },
      { role: "assistant", text: "Понимаю. Будем рады помочь в следующий раз." },
    ],
  },
];

// Поля по этапам — демо-кастомизация поверх голого скелета (у скелета полей нет).
type FieldDef = {
  slug: string;
  displayName: string;
  fieldType: string;
  required: boolean;
  ai?: boolean;
  options?: string[];
};
const STAGE_FIELDS: Record<string, FieldDef[]> = {
  new: [
    { slug: "name", displayName: "Имя", fieldType: "text", required: true, ai: true },
    { slug: "phone", displayName: "Телефон / Telegram", fieldType: "phone", required: true, ai: true },
  ],
  qualify: [
    { slug: "amount", displayName: "Сумма", fieldType: "number", required: true, ai: true },
    { slug: "currency_from", displayName: "Что отдаёт", fieldType: "select", required: true, ai: true, options: ["USDT", "RUB", "USD", "EUR"] },
    { slug: "payout_method", displayName: "Способ выдачи", fieldType: "select", required: false, ai: true, options: ["Офис", "Банкомат", "Карта"] },
  ],
  offer: [
    { slug: "exchange_rate", displayName: "Курс", fieldType: "number", required: true },
    { slug: "amount_thb", displayName: "Итог, THB", fieldType: "number", required: true },
    { slug: "confirmed", displayName: "Клиент подтвердил", fieldType: "boolean", required: true, ai: true },
  ],
  clear: [
    { slug: "kyc_status", displayName: "Статус KYC", fieldType: "select", required: true, options: ["На проверке", "Пройдено"] },
    { slug: "passport_photo", displayName: "Фото паспорта", fieldType: "photo", required: false },
  ],
  fulfill: [
    { slug: "paid", displayName: "Оплата получена", fieldType: "boolean", required: true },
    { slug: "payout_code", displayName: "Код выдачи", fieldType: "text", required: false },
  ],
};

// Значения полей по лиду (имя контакта → fieldSlug → value). Часть оставлена
// незаполненной намеренно — чтобы на карточках были разные проценты прогресса.
const FILL: Record<string, Record<string, unknown>> = {
  "Игорь Петров": { name: "Игорь Петров" }, // 50%: телефон не дал
  "Марина Соколова": { name: "Марина Соколова", phone: "@marina_s" },
  "Дмитрий Орлов": { name: "Дмитрий Орлов", phone: "+66 81 234 5678" },
  "Алексей Кузнецов": { amount: 500, currency_from: "USDT", payout_method: "Офис" },
  "Ольга Васильева": { amount: 80000, currency_from: "RUB" },
  "Сергей Морозов": { exchange_rate: 31.04, amount_thb: 31040 }, // 66%: ещё не подтвердил
  "Анна Лебедева": { exchange_rate: 31.04, amount_thb: 10400, confirmed: true },
  "Виктор Зайцев": { kyc_status: "На проверке" },
  "Екатерина Новикова": { paid: true, payout_code: "4471" },
};

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

  const olegId = await upsertAdmin(
    tenantId,
    "oleg@demo.io",
    "Олег Обменников",
    "superadmin",
  );
  const operatorId = await upsertAdmin(
    tenantId,
    "operator@demo.io",
    "Оператор Смены",
    "manager",
  );
  console.log(`[seed] admins: oleg=${olegId} operator=${operatorId}`);

  // Канал + chat-LLM — чтобы пройти onboarding-гейт: кабинет пускает generic-тенанта
  // только при наличии активного канала и chat-LLM конфига (см. admin-onboarding).
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

  // Чистим прежние демо-данные тенанта (cascade: contacts → leads/conversations/messages).
  await withTenant(db, tenantId, async (tx: any) => {
    await tx.delete(contacts).where(eq(contacts.tenantId, tenantId));
  });

  // Воронка из универсального скелета.
  const seeded = await seedFunnelByKey(db, tenantId, "skeleton", olegId);
  if ("error" in seeded) throw new Error(`seedFunnel: ${seeded.error}`);
  console.log(`[seed] skeleton funnel: ${seeded.stagesCreated} стадий`);

  // slug → stageDefinitionId
  const stageRows = await withTenant(db, tenantId, async (tx: any) =>
    tx
      .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.funnelId, seeded.funnelId)),
  );
  const stageId = new Map<string, number>(
    stageRows.map((s: { id: number; slug: string }) => [s.slug, s.id]),
  );

  // Поля на этапы скелета + индекс fieldId по (этап, slug).
  const fieldIdByStage = new Map<string, Map<string, number>>();
  await withTenant(db, tenantId, async (tx: any) => {
    for (const [slug, defs] of Object.entries(STAGE_FIELDS)) {
      const sid = stageId.get(slug);
      if (sid === undefined) continue;
      const m = new Map<string, number>();
      for (let p = 0; p < defs.length; p++) {
        const f = defs[p]!;
        const [row] = await tx
          .insert(stageFields)
          .values({
            stageId: sid,
            tenantId,
            slug: f.slug,
            displayName: f.displayName,
            fieldType: f.fieldType,
            required: f.required,
            aiExtractable: f.ai ?? false,
            position: p,
            ...(f.options
              ? {
                  optionsJson: JSON.stringify(
                    f.options.map((o) => ({ value: o, label: o })),
                  ),
                }
              : {}),
          })
          .returning({ id: stageFields.id });
        m.set(f.slug, row!.id as number);
      }
      fieldIdByStage.set(slug, m);
    }
  });
  const fieldCount = [...fieldIdByStage.values()].reduce((n, m) => n + m.size, 0);
  console.log(`[seed] полей на этапах: ${fieldCount}`);

  // Лиды + диалоги + сообщения.
  let leadCount = 0;
  let msgCount = 0;
  let fieldValueCount = 0;
  await withTenant(db, tenantId, async (tx: any) => {
    for (let i = 0; i < SAMPLE.length; i++) {
      const spec = SAMPLE[i]!;
      const sid = stageId.get(spec.stage);
      if (!sid) {
        console.warn(`[seed] нет стадии "${spec.stage}", пропуск ${spec.name}`);
        continue;
      }
      const createdAt = now - (SAMPLE.length - i) * 3600; // разнести по времени

      const [ct] = await tx
        .insert(contacts)
        .values({
          tenantId,
          displayName: spec.name,
          attributesJson: "{}",
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: contacts.id });
      const contactId = ct!.id as number;

      const [ld] = await tx
        .insert(leads)
        .values({
          tenantId,
          userId: contactId,
          state: spec.stage,
          stageDefinitionId: sid,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: leads.id });
      const leadId = ld!.id as number;
      leadCount++;

      // Значения полей лида (часть заполнена → прогресс на карточке).
      const fmap = fieldIdByStage.get(spec.stage);
      const fill = FILL[spec.name];
      if (fmap && fill) {
        for (const [fslug, val] of Object.entries(fill)) {
          const fid = fmap.get(fslug);
          if (fid === undefined) continue;
          await tx.insert(leadFieldValues).values({
            leadId,
            fieldId: fid,
            tenantId,
            valueJson: JSON.stringify(val),
            updatedAt: createdAt,
          });
          fieldValueCount++;
        }
      }

      const last = spec.msgs[spec.msgs.length - 1]!;
      const lastAt = createdAt + (spec.msgs.length - 1) * 120;
      const onOperator = spec.operator === true;
      const [cv] = await tx
        .insert(conversations)
        .values({
          tenantId,
          userId: contactId,
          source: "bot",
          mode: onOperator ? "human" : "ai",
          status: onOperator ? "pending" : "open",
          unreadCount: last.role === "user" ? 1 : 0,
          lastMessageText: last.text,
          lastMessageAt: lastAt,
          currentStage: spec.stage,
          assignedAdminId: onOperator ? operatorId : null,
          escalatedAt: onOperator ? createdAt + 60 : null,
          createdAt,
        })
        .returning({ id: conversations.id });
      const convId = cv!.id as number;

      for (let j = 0; j < spec.msgs.length; j++) {
        const m = spec.msgs[j]!;
        await tx.insert(messages).values({
          tenantId,
          conversationId: convId,
          role: m.role,
          text: m.text,
          stage: spec.stage,
          createdAt: createdAt + j * 120,
        });
        msgCount++;
      }
    }
  });

  console.log(
    `[seed] готово: ${leadCount} лидов, ${msgCount} сообщений, ${fieldValueCount} значений полей (${SAMPLE.filter((s) => s.operator).length} диалога на операторе)`,
  );
  console.log("\nЛогины (пароль: test1234):");
  console.log("  Олег Обменников  → oleg@demo.io      (владелец)");
  console.log("  Оператор Смены   → operator@demo.io  (оператор)");

  await client.end({ timeout: 0 });
}

main().catch((err) => {
  console.error("[seed] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
