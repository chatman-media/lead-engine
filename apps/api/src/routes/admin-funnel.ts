import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  funnels,
  skills,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

// ── Seed templates ──────────────────────────────────────────────────────────

type SeedStage = {
  slug: string;
  displayName: string;
  kind: "intake" | "active" | "terminal_won" | "terminal_lost";
  stageType: string;
  position: number;
  color?: string;
  staleTimeoutDays?: number;
  nextStages: string[];
  autoAdvanceCondition?: string;
  fields: Array<{
    slug: string;
    displayName: string;
    fieldType: string;
    required: boolean;
    aiExtractable: boolean;
    hint?: string;
    optionsJson?: string;
    position: number;
  }>;
};

const SEED_TEMPLATES: Record<string, SeedStage[]> = {
  visa: [
    {
      slug: "qualification",
      displayName: "Квалификация",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      color: "#3b82f6",
      nextStages: ["documents_collection"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "citizenship", displayName: "Гражданство", fieldType: "text", required: true, aiExtractable: true, hint: "Страна гражданства", position: 0 },
        { slug: "visa_type", displayName: "Тип визы", fieldType: "select", required: true, aiExtractable: true, hint: "Рабочая, туристическая, студенческая...", position: 1,
          optionsJson: '[{"value":"work","label":"Рабочая"},{"value":"tourist","label":"Туристическая"},{"value":"student","label":"Студенческая"},{"value":"family","label":"По воссоединению семьи"}]' },
        { slug: "experience_years", displayName: "Опыт работы (лет)", fieldType: "number", required: false, aiExtractable: true, position: 2 },
        { slug: "english_level", displayName: "Уровень английского", fieldType: "select", required: true, aiExtractable: true, position: 3,
          optionsJson: '[{"value":"a1","label":"A1 — Начальный"},{"value":"a2","label":"A2"},{"value":"b1","label":"B1 — Средний"},{"value":"b2","label":"B2"},{"value":"c1","label":"C1 — Продвинутый"},{"value":"c2","label":"C2"}]' },
      ],
    },
    {
      slug: "documents_collection",
      displayName: "Сбор документов",
      kind: "active",
      stageType: "document_upload",
      position: 1,
      color: "#f59e0b",
      nextStages: ["financial_verification"],
      fields: [
        { slug: "passport_photo", displayName: "Фото паспорта", fieldType: "photo", required: true, aiExtractable: true, hint: "Первый разворот паспорта", position: 0 },
        { slug: "diploma_uploaded", displayName: "Диплом загружен", fieldType: "boolean", required: false, aiExtractable: false, position: 1 },
        { slug: "employment_history", displayName: "История трудоустройства", fieldType: "textarea", required: false, aiExtractable: true, position: 2 },
      ],
    },
    {
      slug: "financial_verification",
      displayName: "Финансовая проверка",
      kind: "active",
      stageType: "external_approval",
      position: 2,
      color: "#8b5cf6",
      nextStages: ["application_submission"],
      fields: [
        { slug: "bank_statement_uploaded", displayName: "Выписка из банка загружена", fieldType: "boolean", required: true, aiExtractable: false, position: 0 },
        { slug: "funds_amount_usd", displayName: "Сумма средств (USD)", fieldType: "number", required: true, aiExtractable: true, position: 1 },
      ],
    },
    {
      slug: "application_submission",
      displayName: "Подача заявки",
      kind: "active",
      stageType: "form_fill",
      position: 3,
      color: "#ec4899",
      nextStages: ["processing"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "application_date", displayName: "Дата подачи", fieldType: "date", required: true, aiExtractable: false, position: 0 },
        { slug: "application_number", displayName: "Номер заявки", fieldType: "text", required: false, aiExtractable: false, position: 1 },
        { slug: "payment_confirmed", displayName: "Оплата консульского сбора подтверждена", fieldType: "boolean", required: true, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "processing",
      displayName: "Рассмотрение",
      kind: "active",
      stageType: "waiting",
      position: 4,
      color: "#6b7280",
      staleTimeoutDays: 90,
      nextStages: ["visa_issued", "rejected"],
      fields: [
        { slug: "expected_decision_date", displayName: "Ожидаемая дата решения", fieldType: "date", required: false, aiExtractable: false, position: 0 },
        { slug: "processing_notes", displayName: "Заметки по рассмотрению", fieldType: "textarea", required: false, aiExtractable: false, position: 1 },
      ],
    },
    {
      slug: "visa_issued",
      displayName: "Виза выдана",
      kind: "terminal_won",
      stageType: "milestone",
      position: 5,
      color: "#10b981",
      nextStages: [],
      fields: [
        { slug: "visa_number", displayName: "Номер визы", fieldType: "text", required: false, aiExtractable: false, position: 0 },
        { slug: "visa_expiry", displayName: "Срок действия визы", fieldType: "date", required: false, aiExtractable: false, position: 1 },
      ],
    },
    {
      slug: "rejected",
      displayName: "Отказ",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 6,
      color: "#ef4444",
      nextStages: [],
      fields: [
        { slug: "rejection_reason", displayName: "Причина отказа", fieldType: "textarea", required: false, aiExtractable: false, position: 0 },
      ],
    },
  ],

  real_estate: [
    {
      slug: "qualification",
      displayName: "Квалификация покупателя",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      color: "#3b82f6",
      nextStages: ["pre_approval"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "budget_usd", displayName: "Бюджет (USD)", fieldType: "number", required: true, aiExtractable: true, hint: "Бюджет на покупку", position: 0 },
        { slug: "property_type", displayName: "Тип недвижимости", fieldType: "select", required: true, aiExtractable: true, position: 1,
          optionsJson: '[{"value":"apartment","label":"Квартира"},{"value":"villa","label":"Вилла"},{"value":"townhouse","label":"Таунхаус"},{"value":"studio","label":"Студия"},{"value":"commercial","label":"Коммерческая"}]' },
        { slug: "locations", displayName: "Интересующие районы", fieldType: "multiselect", required: false, aiExtractable: true, position: 2,
          optionsJson: '[{"value":"downtown","label":"Центр"},{"value":"marina","label":"Марина"},{"value":"suburbs","label":"Пригород"},{"value":"beachfront","label":"Первая линия"}]' },
        { slug: "payment_method", displayName: "Способ оплаты", fieldType: "select", required: true, aiExtractable: true, position: 3,
          optionsJson: '[{"value":"cash","label":"Наличные"},{"value":"mortgage","label":"Ипотека"},{"value":"installment","label":"Рассрочка"}]' },
        { slug: "timeline_months", displayName: "Срок покупки (месяцев)", fieldType: "number", required: false, aiExtractable: true, position: 4 },
      ],
    },
    {
      slug: "pre_approval",
      displayName: "Предварительное одобрение",
      kind: "active",
      stageType: "external_approval",
      position: 1,
      color: "#f59e0b",
      nextStages: ["viewings"],
      fields: [
        { slug: "bank_name", displayName: "Банк", fieldType: "text", required: false, aiExtractable: false, position: 0 },
        { slug: "approved_amount_usd", displayName: "Одобренная сумма (USD)", fieldType: "number", required: false, aiExtractable: false, position: 1 },
        { slug: "pre_approval_date", displayName: "Дата одобрения", fieldType: "date", required: false, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "viewings",
      displayName: "Просмотры",
      kind: "active",
      stageType: "interaction",
      position: 2,
      color: "#8b5cf6",
      staleTimeoutDays: 30,
      nextStages: ["offer"],
      fields: [
        { slug: "properties_viewed", displayName: "Количество просмотров", fieldType: "number", required: false, aiExtractable: false, position: 0 },
        { slug: "preferred_property_ref", displayName: "Понравившийся объект (референс)", fieldType: "text", required: false, aiExtractable: false, position: 1 },
        { slug: "viewing_feedback", displayName: "Фидбек по просмотрам", fieldType: "textarea", required: false, aiExtractable: true, position: 2 },
      ],
    },
    {
      slug: "offer",
      displayName: "Предложение",
      kind: "active",
      stageType: "form_fill",
      position: 3,
      color: "#ec4899",
      nextStages: ["closing", "deal_lost"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "offer_amount_usd", displayName: "Сумма предложения (USD)", fieldType: "number", required: true, aiExtractable: false, position: 0 },
        { slug: "offer_date", displayName: "Дата предложения", fieldType: "date", required: true, aiExtractable: false, position: 1 },
        { slug: "offer_conditions", displayName: "Условия сделки", fieldType: "textarea", required: false, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "closing",
      displayName: "Закрытие сделки",
      kind: "terminal_won",
      stageType: "document_signature",
      position: 4,
      color: "#10b981",
      nextStages: [],
      fields: [
        { slug: "closing_date", displayName: "Дата закрытия", fieldType: "date", required: false, aiExtractable: false, position: 0 },
        { slug: "final_price_usd", displayName: "Итоговая цена (USD)", fieldType: "number", required: false, aiExtractable: false, position: 1 },
      ],
    },
    {
      slug: "deal_lost",
      displayName: "Сделка не состоялась",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 5,
      color: "#ef4444",
      nextStages: [],
      fields: [
        { slug: "loss_reason", displayName: "Причина потери", fieldType: "select", required: false, aiExtractable: false, position: 0,
          optionsJson: '[{"value":"budget","label":"Бюджет не подошёл"},{"value":"competitor","label":"Выбрал другого агента"},{"value":"not_ready","label":"Не готов покупать"},{"value":"found_himself","label":"Нашёл сам"},{"value":"other","label":"Другое"}]' },
      ],
    },
  ],

  modeling: [
    {
      slug: "intake",
      displayName: "Первичный контакт",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      color: "#3b82f6",
      nextStages: ["portfolio_review"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "full_name", displayName: "Полное имя", fieldType: "text", required: true, aiExtractable: true, position: 0 },
        { slug: "age", displayName: "Возраст", fieldType: "number", required: true, aiExtractable: true, position: 1 },
        { slug: "height_cm", displayName: "Рост (см)", fieldType: "number", required: true, aiExtractable: true, position: 2 },
        { slug: "bust_waist_hips", displayName: "Параметры (ОГ/ОТ/ОБ)", fieldType: "text", required: false, aiExtractable: true, hint: "например: 88/60/90", position: 3 },
        { slug: "experience", displayName: "Опыт в модельной сфере", fieldType: "multiselect", required: false, aiExtractable: true, position: 4,
          optionsJson: '[{"value":"runway","label":"Подиум"},{"value":"commercial","label":"Коммерческая съёмка"},{"value":"editorial","label":"Editorial"},{"value":"acting","label":"Актёрское мастерство"},{"value":"none","label":"Нет опыта"}]' },
        { slug: "instagram_url", displayName: "Instagram / соцсети", fieldType: "text", required: false, aiExtractable: true, position: 5 },
      ],
    },
    {
      slug: "portfolio_review",
      displayName: "Ревью портфолио",
      kind: "active",
      stageType: "document_upload",
      position: 1,
      color: "#f59e0b",
      staleTimeoutDays: 14,
      nextStages: ["go_see"],
      fields: [
        { slug: "portfolio_photos_uploaded", displayName: "Фото портфолио загружены", fieldType: "boolean", required: true, aiExtractable: false, position: 0 },
        { slug: "comp_card_uploaded", displayName: "Комп-карта загружена", fieldType: "boolean", required: false, aiExtractable: false, position: 1 },
        { slug: "portfolio_notes", displayName: "Заметки по портфолио", fieldType: "textarea", required: false, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "go_see",
      displayName: "Go-See / Кастинг",
      kind: "active",
      stageType: "interaction",
      position: 2,
      color: "#8b5cf6",
      nextStages: ["contract", "not_suitable"],
      fields: [
        { slug: "go_see_date", displayName: "Дата кастинга", fieldType: "date", required: false, aiExtractable: false, position: 0 },
        { slug: "casting_result", displayName: "Результат кастинга", fieldType: "select", required: false, aiExtractable: false, position: 1,
          optionsJson: '[{"value":"approved","label":"Одобрен"},{"value":"pending","label":"На рассмотрении"},{"value":"rejected","label":"Не подошёл"}]' },
        { slug: "casting_notes", displayName: "Заметки кастинг-директора", fieldType: "textarea", required: false, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "contract",
      displayName: "Заключение контракта",
      kind: "active",
      stageType: "document_signature",
      position: 3,
      color: "#ec4899",
      nextStages: ["active_representation"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "contract_signed", displayName: "Контракт подписан", fieldType: "boolean", required: true, aiExtractable: false, position: 0 },
        { slug: "contract_date", displayName: "Дата подписания", fieldType: "date", required: true, aiExtractable: false, position: 1 },
        { slug: "commission_pct", displayName: "Комиссия агентства (%)", fieldType: "number", required: false, aiExtractable: false, position: 2 },
      ],
    },
    {
      slug: "active_representation",
      displayName: "Активное представление",
      kind: "terminal_won",
      stageType: "milestone",
      position: 4,
      color: "#10b981",
      nextStages: [],
      fields: [
        { slug: "agency_profile_url", displayName: "Профиль на сайте агентства", fieldType: "text", required: false, aiExtractable: false, position: 0 },
      ],
    },
    {
      slug: "not_suitable",
      displayName: "Не подошёл",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 5,
      color: "#ef4444",
      nextStages: [],
      fields: [
        { slug: "rejection_notes", displayName: "Причина отказа", fieldType: "textarea", required: false, aiExtractable: false, position: 0 },
      ],
    },
  ],

  recruitment: [
    {
      slug: "intake_pending",
      displayName: "Заполнение анкеты",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      color: "#3b82f6",
      nextStages: ["intake_complete", "rejected"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "full_name", displayName: "Имя и фамилия (как в паспорте)", fieldType: "text", required: true, aiExtractable: true, position: 0 },
        { slug: "age", displayName: "Возраст", fieldType: "number", required: true, aiExtractable: true, position: 1 },
        { slug: "height_cm", displayName: "Рост (см)", fieldType: "number", required: true, aiExtractable: true, position: 2 },
        { slug: "weight_kg", displayName: "Вес (кг)", fieldType: "number", required: true, aiExtractable: true, position: 3 },
        { slug: "nationality", displayName: "Гражданство", fieldType: "text", required: true, aiExtractable: true, position: 4 },
        { slug: "marital_status", displayName: "Семейное положение", fieldType: "select", required: true, aiExtractable: true, position: 5,
          optionsJson: '[{"value":"single","label":"Не замужем"},{"value":"married","label":"Замужем"},{"value":"divorced","label":"Разведена"},{"value":"widowed","label":"Вдова"}]' },
        { slug: "children", displayName: "Дети", fieldType: "text", required: true, aiExtractable: true, hint: "нет / есть — укажите сколько", position: 6 },
        { slug: "languages", displayName: "Языки и уровень", fieldType: "textarea", required: true, aiExtractable: true, hint: "например: английский B2, базовый китайский", position: 7 },
        { slug: "work_experience", displayName: "Опыт работы (2 года)", fieldType: "textarea", required: false, aiExtractable: true, position: 8 },
        { slug: "passport_expiry", displayName: "Срок действия загранпаспорта", fieldType: "date", required: true, aiExtractable: true, position: 9 },
        { slug: "city_and_readiness", displayName: "Город и готовность к выезду", fieldType: "textarea", required: true, aiExtractable: true, position: 10 },
      ],
    },
    {
      slug: "intake_complete",
      displayName: "Анкета собрана",
      kind: "active",
      stageType: "assessment",
      position: 1,
      color: "#f59e0b",
      nextStages: ["approved", "partner_review", "rejected"],
      fields: [],
    },
    {
      slug: "partner_review",
      displayName: "На рассмотрении у партнёра",
      kind: "active",
      stageType: "external_approval",
      position: 2,
      color: "#8b5cf6",
      staleTimeoutDays: 14,
      nextStages: ["approved", "rejected"],
      fields: [],
    },
    {
      slug: "approved",
      displayName: "Одобрена",
      kind: "active",
      stageType: "milestone",
      position: 3,
      color: "#22c55e",
      nextStages: ["docs_pending"],
      fields: [],
    },
    {
      slug: "docs_pending",
      displayName: "Сбор документов",
      kind: "active",
      stageType: "document_upload",
      position: 4,
      color: "#f59e0b",
      staleTimeoutDays: 21,
      nextStages: ["docs_complete", "rejected"],
      fields: [
        { slug: "passport_scan", displayName: "Скан загранпаспорта", fieldType: "file", required: true, aiExtractable: false, position: 0 },
        { slug: "photos", displayName: "Фотографии (6–8 шт.)", fieldType: "file", required: true, aiExtractable: false, position: 1 },
        { slug: "video_intro", displayName: "Видео (2 видео)", fieldType: "file", required: false, aiExtractable: false, position: 2 },
        { slug: "dance_video", displayName: "Видео танца (1 мин.)", fieldType: "file", required: false, aiExtractable: false, position: 3 },
      ],
    },
    {
      slug: "docs_complete",
      displayName: "Документы собраны",
      kind: "active",
      stageType: "milestone",
      position: 5,
      color: "#22c55e",
      nextStages: ["visa_form"],
      fields: [],
    },
    {
      slug: "visa_form",
      displayName: "Заполнение визовой анкеты",
      kind: "active",
      stageType: "form_fill",
      position: 6,
      color: "#3b82f6",
      nextStages: ["visa_filing", "rejected"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "visa_destination", displayName: "Страна назначения", fieldType: "text", required: true, aiExtractable: true, position: 0 },
        { slug: "visa_type", displayName: "Тип визы", fieldType: "select", required: true, aiExtractable: true, position: 1,
          optionsJson: '[{"value":"work","label":"Рабочая"},{"value":"business","label":"Деловая"},{"value":"entertainer","label":"Артистическая"}]' },
        { slug: "employer_name", displayName: "Работодатель / агентство", fieldType: "text", required: false, aiExtractable: true, position: 2 },
      ],
    },
    {
      slug: "visa_filing",
      displayName: "Подача документов на визу",
      kind: "active",
      stageType: "external_approval",
      position: 7,
      color: "#8b5cf6",
      nextStages: ["visa_waiting"],
      fields: [],
    },
    {
      slug: "visa_waiting",
      displayName: "Ожидание решения по визе",
      kind: "active",
      stageType: "waiting",
      position: 8,
      color: "#94a3b8",
      staleTimeoutDays: 90,
      nextStages: ["ready_to_work", "rejected"],
      fields: [],
    },
    {
      slug: "ready_to_work",
      displayName: "Готова к работе",
      kind: "terminal_won",
      stageType: "milestone",
      position: 9,
      color: "#10b981",
      nextStages: [],
      fields: [],
    },
    {
      slug: "rejected",
      displayName: "Отказ",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 10,
      color: "#ef4444",
      nextStages: [],
      fields: [],
    },
  ],
};

/**
 * Funnel builder + skills list API.
 *
 * GET  /api/admin/funnel                       — активная воронка + все стадии + поля
 * POST /api/admin/funnel/stages                — создать стадию
 * PATCH /api/admin/funnel/stages/:stageId      — обновить стадию
 * DELETE /api/admin/funnel/stages/:stageId     — удалить стадию
 * POST /api/admin/funnel/stages/:stageId/fields — создать поле
 * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId — обновить поле
 * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId — удалить поле
 * PATCH /api/admin/funnel/stages/reorder       — переставить позиции
 *
 * GET  /api/admin/skills                       — полный список скилов
 */
export interface AdminFunnelRoutesOpts {
  db: Db;
}

export function makeAdminFunnelRoutes(opts: AdminFunnelRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/funnel
   * Возвращает активную воронку тенанта со всеми стадиями и полями.
   */
  app.get("/api/admin/funnel", async (c) => {
    const tenantId = c.var.tenantId;

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [funnel] = await tx
        .select()
        .from(funnels)
        .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
        .limit(1);

      if (!funnel) return null;

      const stages = await tx
        .select()
        .from(stageDefinitions)
        .where(eq(stageDefinitions.funnelId, funnel.id))
        .orderBy(asc(stageDefinitions.position));

      const fields = stages.length > 0
        ? await tx
            .select()
            .from(stageFields)
            .where(eq(stageFields.tenantId, tenantId))
            .orderBy(asc(stageFields.position))
        : [];

      // группируем поля по stageId
      const fieldsByStage = fields.reduce<Record<number, typeof fields>>(
        (acc, f) => {
          (acc[f.stageId] ??= []).push(f);
          return acc;
        },
        {},
      );

      return {
        funnel: { id: funnel.id, slug: funnel.slug, isActive: funnel.isActive },
        stages: stages.map((s) => ({
          ...s,
          fields: fieldsByStage[s.id] ?? [],
        })),
      };
    });

    if (!result) return c.json({ funnel: null, stages: [] });
    return c.json(result);
  });

  /**
   * POST /api/admin/funnel/stages
   * Body: { funnelId, slug, displayName, kind, stageType, position?, color?, icon?,
   *         description?, staleTimeoutDays?, checkinIntervalDays?, supportMode? }
   */
  app.post("/api/admin/funnel/stages", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const body = await c.req.json<{
      funnelId: number;
      slug: string;
      displayName: string;
      kind?: string;
      stageType?: string;
      position?: number;
      color?: string;
      icon?: string;
      description?: string;
      staleTimeoutDays?: number;
      checkinIntervalDays?: number;
      supportMode?: boolean;
      nextStages?: string[];
    }>();

    if (!body.funnelId || !body.slug || !body.displayName) {
      return c.json({ error: "funnelId, slug, displayName required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const [stage] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(stageDefinitions)
        .values({
          tenantId,
          funnelId: body.funnelId,
          slug: body.slug,
          displayName: body.displayName,
          description: body.description ?? undefined,
          position: body.position ?? 0,
          kind: body.kind ?? "active",
          stageType: body.stageType ?? "form_fill",
          color: body.color ?? undefined,
          icon: body.icon ?? undefined,
          staleTimeoutDays: body.staleTimeoutDays ?? undefined,
          checkinIntervalDays: body.checkinIntervalDays ?? undefined,
          supportMode: body.supportMode ?? false,
          nextStages: body.nextStages ?? [],
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.create",
      targetKind: "stage_definition",
      targetId: String(stage?.id),
      details: { slug: body.slug },
    });

    return c.json(stage, 201);
  });

  /**
   * PATCH /api/admin/funnel/stages/:stageId
   */
  app.patch("/api/admin/funnel/stages/:stageId", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    const body = await c.req.json<Partial<{
      displayName: string;
      description: string;
      kind: string;
      stageType: string;
      position: number;
      color: string;
      icon: string;
      staleTimeoutDays: number;
      checkinIntervalDays: number;
      supportMode: boolean;
      nextStages: string[];
      configJson: string;
    }>>();

    const now = Math.floor(Date.now() / 1000);
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.description !== undefined) patch.description = body.description;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.stageType !== undefined) patch.stageType = body.stageType;
    if (body.position !== undefined) patch.position = body.position;
    if (body.color !== undefined) patch.color = body.color;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.staleTimeoutDays !== undefined) patch.staleTimeoutDays = body.staleTimeoutDays;
    if (body.checkinIntervalDays !== undefined) patch.checkinIntervalDays = body.checkinIntervalDays;
    if (body.supportMode !== undefined) patch.supportMode = body.supportMode;
    if (body.nextStages !== undefined) patch.nextStages = body.nextStages;
    if (body.configJson !== undefined) patch.configJson = body.configJson;

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(stageDefinitions)
        // biome-ignore lint/suspicious/noExplicitAny: dynamic patch object
        .set(patch as any)
        .where(and(eq(stageDefinitions.id, stageId), eq(stageDefinitions.tenantId, tenantId))),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.update",
      targetKind: "stage_definition",
      targetId: String(stageId),
    });

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/funnel/stages/:stageId
   */
  app.delete("/api/admin/funnel/stages/:stageId", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(stageDefinitions)
        .where(and(eq(stageDefinitions.id, stageId), eq(stageDefinitions.tenantId, tenantId))),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.delete",
      targetKind: "stage_definition",
      targetId: String(stageId),
    });

    return c.json({ ok: true });
  });

  /**
   * PATCH /api/admin/funnel/stages/reorder
   * Body: { order: Array<{ id: number, position: number }> }
   */
  app.patch("/api/admin/funnel/stages/reorder", async (c) => {
    const tenantId = c.var.tenantId;
    const { order } = await c.req.json<{ order: Array<{ id: number; position: number }> }>();
    if (!Array.isArray(order)) return c.json({ error: "order array required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      for (const { id, position } of order) {
        await tx
          .update(stageDefinitions)
          .set({ position, updatedAt: now })
          .where(and(eq(stageDefinitions.id, id), eq(stageDefinitions.tenantId, tenantId)));
      }
    });

    return c.json({ ok: true });
  });

  // ── Stage fields ──────────────────────────────────────────────────────────

  /**
   * POST /api/admin/funnel/stages/:stageId/fields
   */
  app.post("/api/admin/funnel/stages/:stageId/fields", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    const body = await c.req.json<{
      slug: string;
      displayName: string;
      fieldType?: string;
      required?: boolean;
      position?: number;
      hint?: string;
      aiExtractable?: boolean;
      optionsJson?: string;
      validationJson?: string;
    }>();

    if (!body.slug || !body.displayName) {
      return c.json({ error: "slug, displayName required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const [field] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(stageFields)
        .values({
          stageId,
          tenantId,
          slug: body.slug,
          displayName: body.displayName,
          fieldType: body.fieldType ?? "text",
          required: body.required ?? false,
          position: body.position ?? 0,
          hint: body.hint ?? null,
          aiExtractable: body.aiExtractable ?? false,
          optionsJson: body.optionsJson ?? "[]",
          validationJson: body.validationJson ?? "{}",
          createdAt: now,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage_field.create",
      targetKind: "stage_field",
      targetId: String(field?.id),
    });

    return c.json(field, 201);
  });

  /**
   * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId
   */
  app.patch("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
    const tenantId = c.var.tenantId;
    const fieldId = Number(c.req.param("fieldId"));
    if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

    const body = await c.req.json<Partial<{
      displayName: string;
      fieldType: string;
      required: boolean;
      position: number;
      hint: string;
      aiExtractable: boolean;
      optionsJson: string;
      validationJson: string;
    }>>();

    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.fieldType !== undefined) patch.fieldType = body.fieldType;
    if (body.required !== undefined) patch.required = body.required;
    if (body.position !== undefined) patch.position = body.position;
    if (body.hint !== undefined) patch.hint = body.hint;
    if (body.aiExtractable !== undefined) patch.aiExtractable = body.aiExtractable;
    if (body.optionsJson !== undefined) patch.optionsJson = body.optionsJson;
    if (body.validationJson !== undefined) patch.validationJson = body.validationJson;

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(stageFields)
        // biome-ignore lint/suspicious/noExplicitAny: dynamic patch
        .set(patch as any)
        .where(and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId))),
    );

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId
   */
  app.delete("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
    const tenantId = c.var.tenantId;
    const fieldId = Number(c.req.param("fieldId"));
    if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(stageFields)
        .where(and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId))),
    );

    return c.json({ ok: true });
  });

  // ── Seed templates ───────────────────────────────────────────────────────

  /**
   * POST /api/admin/funnel/seed
   * Body: { template: "visa" | "real_estate" | "modeling" }
   * Создаёт или заменяет воронку из предустановленного шаблона.
   * Если у тенанта уже есть активная воронка — добавляет стадии/поля к ней;
   * если нет — создаёт новую воронку со slug = template.
   */
  app.post("/api/admin/funnel/seed", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;

    const body = await c.req.json<{ template: string }>();
    const stages = SEED_TEMPLATES[body.template];
    if (!stages) {
      return c.json({ error: `Unknown template. Available: ${Object.keys(SEED_TEMPLATES).join(", ")}` }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      // Найти или создать активную воронку
      let [funnel] = await tx
        .select()
        .from(funnels)
        .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
        .limit(1);

      if (!funnel) {
        const [created] = await tx
          .insert(funnels)
          .values({ tenantId, slug: body.template, isActive: true, createdAt: now, updatedAt: now })
          .returning();
        funnel = created!;
      }

      // Удалить существующие стадии этой воронки (полная замена)
      const existingStages = await tx
        .select({ id: stageDefinitions.id })
        .from(stageDefinitions)
        .where(eq(stageDefinitions.funnelId, funnel.id));

      for (const s of existingStages) {
        await tx.delete(stageFields).where(eq(stageFields.stageId, s.id));
      }
      if (existingStages.length > 0) {
        await tx.delete(stageDefinitions).where(eq(stageDefinitions.funnelId, funnel.id));
      }

      // Вставить стадии и поля из шаблона
      const createdStages: Array<{ id: number; slug: string }> = [];
      for (const stageTpl of stages) {
        const { fields, ...stageData } = stageTpl;
        const [stage] = await tx
          .insert(stageDefinitions)
          .values({
            tenantId,
            funnelId: funnel.id,
            slug: stageData.slug,
            displayName: stageData.displayName,
            kind: stageData.kind,
            stageType: stageData.stageType,
            position: stageData.position,
            color: stageData.color ?? null,
            staleTimeoutDays: stageData.staleTimeoutDays ?? null,
            nextStages: stageData.nextStages,
            autoAdvanceCondition: stageData.autoAdvanceCondition ?? null,
            supportMode: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });

        if (!stage) continue;
        createdStages.push(stage);

        for (const fieldTpl of fields) {
          await tx.insert(stageFields).values({
            stageId: stage.id,
            tenantId,
            slug: fieldTpl.slug,
            displayName: fieldTpl.displayName,
            fieldType: fieldTpl.fieldType,
            required: fieldTpl.required,
            aiExtractable: fieldTpl.aiExtractable,
            hint: fieldTpl.hint ?? null,
            ...(fieldTpl.optionsJson ? { optionsJson: fieldTpl.optionsJson } : {}),
            position: fieldTpl.position,
            createdAt: now,
          });
        }
      }

      return { funnelId: funnel.id, stagesCreated: createdStages.length };
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "funnel.seed",
      targetKind: "funnel",
      targetId: String(result.funnelId),
      details: { template: body.template, stagesCreated: result.stagesCreated },
    });

    return c.json({ ok: true, ...result });
  });

  // ── Skills ────────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/skills
   * Полный список скилов тенанта с ELO-рейтингами.
   */
  app.get("/api/admin/skills", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(skills)
        .where(eq(skills.tenantId, tenantId))
        .orderBy(asc(skills.family), asc(skills.displayName)),
    );

    return c.json({ items: rows });
  });

  return app;
}
