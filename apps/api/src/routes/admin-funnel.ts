import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  experiments,
  funnels,
  leadEvents,
  leads,
  skills,
  stageDefinitions,
  stageFields,
  styles,
} from "@chatman-media/storage";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { SKILLS_CATALOGUE } from "../lib/skills-catalogue.ts";
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
  checkinIntervalDays?: number;
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
      displayName: "Квалификация",
      kind: "intake",
      stageType: "form_fill",
      position: 0,
      color: "#3b82f6",
      nextStages: ["viewings"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "budget_usd", displayName: "Бюджет (USD)", fieldType: "number", required: true, aiExtractable: true, hint: "Общий бюджет на покупку", position: 0 },
        { slug: "property_type", displayName: "Тип недвижимости", fieldType: "select", required: true, aiExtractable: true, position: 1,
          optionsJson: '[{"value":"apartment","label":"Квартира"},{"value":"villa","label":"Вилла"},{"value":"townhouse","label":"Таунхаус"},{"value":"studio","label":"Студия"},{"value":"penthouse","label":"Пентхаус"},{"value":"commercial","label":"Коммерческая"}]' },
        { slug: "bedrooms", displayName: "Количество спален", fieldType: "select", required: false, aiExtractable: true, position: 2,
          optionsJson: '[{"value":"studio","label":"Студия"},{"value":"1","label":"1"},{"value":"2","label":"2"},{"value":"3","label":"3"},{"value":"4+","label":"4+"}]' },
        { slug: "locations", displayName: "Районы", fieldType: "multiselect", required: false, aiExtractable: true, position: 3,
          optionsJson: '[{"value":"downtown","label":"Downtown"},{"value":"marina","label":"Marina"},{"value":"jvc","label":"JVC"},{"value":"business_bay","label":"Business Bay"},{"value":"palm","label":"Palm"},{"value":"creek","label":"Creek"},{"value":"other","label":"Другой"}]' },
        { slug: "payment_method", displayName: "Способ оплаты", fieldType: "select", required: true, aiExtractable: true, position: 4,
          optionsJson: '[{"value":"cash","label":"Наличные"},{"value":"mortgage","label":"Ипотека"},{"value":"installment","label":"Рассрочка от застройщика"}]' },
        { slug: "market_type", displayName: "Первичка или вторичка", fieldType: "select", required: false, aiExtractable: true, position: 5,
          optionsJson: '[{"value":"primary","label":"Первичная (от застройщика)"},{"value":"secondary","label":"Вторичная (resale)"},{"value":"both","label":"Оба варианта"}]' },
        { slug: "residency_goal", displayName: "Цель покупки", fieldType: "select", required: false, aiExtractable: true, position: 6,
          optionsJson: '[{"value":"own_use","label":"Для себя"},{"value":"investment","label":"Инвестиция/аренда"},{"value":"visa","label":"Для получения визы резидента"}]' },
        { slug: "timeline_months", displayName: "Срок сделки (месяцев)", fieldType: "number", required: false, aiExtractable: true, position: 7 },
      ],
    },
    {
      slug: "viewings",
      displayName: "Просмотры",
      kind: "active",
      stageType: "interaction",
      position: 1,
      color: "#8b5cf6",
      staleTimeoutDays: 21,
      checkinIntervalDays: 7,
      nextStages: ["offer_negotiation", "deal_lost"],
      fields: [
        { slug: "properties_sent", displayName: "Подборок отправлено", fieldType: "number", required: false, aiExtractable: false, position: 0 },
        { slug: "viewings_count", displayName: "Просмотров проведено", fieldType: "number", required: false, aiExtractable: false, position: 1 },
        { slug: "shortlisted_ref", displayName: "Выбранный объект (ссылка/референс)", fieldType: "text", required: false, aiExtractable: false, position: 2 },
        { slug: "shortlisted_price_usd", displayName: "Цена выбранного объекта (USD)", fieldType: "number", required: false, aiExtractable: false, position: 3 },
        { slug: "viewing_notes", displayName: "Заметки по просмотрам", fieldType: "textarea", required: false, aiExtractable: true, position: 4 },
      ],
    },
    {
      slug: "offer_negotiation",
      displayName: "Оффер и переговоры",
      kind: "active",
      stageType: "form_fill",
      position: 2,
      color: "#f59e0b",
      staleTimeoutDays: 14,
      nextStages: ["mou_signed", "deal_lost"],
      fields: [
        { slug: "asking_price_usd", displayName: "Цена продавца (USD)", fieldType: "number", required: false, aiExtractable: false, position: 0 },
        { slug: "offer_price_usd", displayName: "Предложение покупателя (USD)", fieldType: "number", required: true, aiExtractable: false, position: 1 },
        { slug: "agreed_price_usd", displayName: "Согласованная цена (USD)", fieldType: "number", required: false, aiExtractable: false, position: 2 },
        { slug: "negotiation_notes", displayName: "Ход переговоров", fieldType: "textarea", required: false, aiExtractable: false, position: 3 },
      ],
    },
    {
      slug: "mou_signed",
      displayName: "MOU подписан (Form F)",
      kind: "active",
      stageType: "document_signature",
      position: 3,
      color: "#ec4899",
      staleTimeoutDays: 30,
      // NOC нужен для вторички; ипотека — для mortgage-покупателей; cash-покупатели могут идти сразу на transfer
      nextStages: ["noc_application", "mortgage_approval", "dld_transfer"],
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      fields: [
        { slug: "mou_date", displayName: "Дата подписания MOU", fieldType: "date", required: true, aiExtractable: false, position: 0 },
        { slug: "deposit_amount_usd", displayName: "Депозит (USD, обычно 10%)", fieldType: "number", required: true, aiExtractable: false, position: 1 },
        { slug: "deposit_paid", displayName: "Депозит оплачен", fieldType: "boolean", required: true, aiExtractable: false, position: 2 },
        { slug: "completion_deadline", displayName: "Дата завершения сделки", fieldType: "date", required: false, aiExtractable: false, position: 3 },
        { slug: "mou_document", displayName: "MOU / Form F (файл)", fieldType: "file", required: false, aiExtractable: false, position: 4 },
      ],
    },
    {
      slug: "noc_application",
      displayName: "NOC от застройщика",
      kind: "active",
      stageType: "external_approval",
      position: 4,
      color: "#6366f1",
      staleTimeoutDays: 21,
      // Только для вторички; после получения NOC — к трансферу (или сначала ипотека)
      nextStages: ["mortgage_approval", "dld_transfer"],
      fields: [
        { slug: "developer_name", displayName: "Застройщик", fieldType: "text", required: false, aiExtractable: false, position: 0 },
        { slug: "noc_applied_date", displayName: "Дата подачи заявки на NOC", fieldType: "date", required: false, aiExtractable: false, position: 1 },
        { slug: "noc_received", displayName: "NOC получен", fieldType: "boolean", required: true, aiExtractable: false, position: 2 },
        { slug: "noc_document", displayName: "NOC (файл)", fieldType: "file", required: false, aiExtractable: false, position: 3 },
      ],
    },
    {
      slug: "mortgage_approval",
      displayName: "Одобрение ипотеки",
      kind: "active",
      stageType: "external_approval",
      position: 5,
      color: "#0ea5e9",
      staleTimeoutDays: 30,
      nextStages: ["dld_transfer"],
      fields: [
        { slug: "bank_name", displayName: "Банк", fieldType: "text", required: false, aiExtractable: false, position: 0 },
        { slug: "approved_amount_usd", displayName: "Одобренная сумма (USD)", fieldType: "number", required: false, aiExtractable: false, position: 1 },
        { slug: "interest_rate_pct", displayName: "Процентная ставка (%)", fieldType: "number", required: false, aiExtractable: false, position: 2 },
        { slug: "mortgage_term_years", displayName: "Срок ипотеки (лет)", fieldType: "number", required: false, aiExtractable: false, position: 3 },
        { slug: "approval_letter", displayName: "Письмо об одобрении (файл)", fieldType: "file", required: false, aiExtractable: false, position: 4 },
      ],
    },
    {
      slug: "dld_transfer",
      displayName: "Регистрация в DLD",
      kind: "terminal_won",
      stageType: "milestone",
      position: 6,
      color: "#10b981",
      nextStages: [],
      fields: [
        { slug: "transfer_date", displayName: "Дата трансфера", fieldType: "date", required: false, aiExtractable: false, position: 0 },
        { slug: "final_price_usd", displayName: "Итоговая цена (USD)", fieldType: "number", required: false, aiExtractable: false, position: 1 },
        { slug: "title_deed_number", displayName: "Номер Title Deed", fieldType: "text", required: false, aiExtractable: false, position: 2 },
        { slug: "dld_registration_number", displayName: "Регистрационный номер DLD", fieldType: "text", required: false, aiExtractable: false, position: 3 },
        { slug: "dld_fee_usd", displayName: "Комиссия DLD (USD, обычно 4%)", fieldType: "number", required: false, aiExtractable: false, position: 4 },
      ],
    },
    {
      slug: "deal_lost",
      displayName: "Сделка не состоялась",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 7,
      color: "#ef4444",
      nextStages: [],
      fields: [
        { slug: "loss_reason", displayName: "Причина", fieldType: "select", required: false, aiExtractable: false, position: 0,
          optionsJson: '[{"value":"budget","label":"Бюджет не сошёлся"},{"value":"competitor","label":"Выбрал другого агента"},{"value":"financing_failed","label":"Ипотека не одобрена"},{"value":"noc_rejected","label":"NOC отклонён"},{"value":"not_ready","label":"Не готов покупать"},{"value":"found_himself","label":"Нашёл сам"},{"value":"other","label":"Другое"}]' },
        { slug: "loss_notes", displayName: "Детали", fieldType: "textarea", required: false, aiExtractable: false, position: 1 },
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
        { slug: "portfolio_photos", displayName: "Фото портфолио", fieldType: "file", required: true, aiExtractable: false, hint: "6–10 фото (headshot + full-length)", position: 0 },
        { slug: "comp_card", displayName: "Комп-карта", fieldType: "file", required: false, aiExtractable: false, position: 1 },
        { slug: "video_reel", displayName: "Видео-рилл", fieldType: "file", required: false, aiExtractable: false, hint: "30–90 сек, свободное движение или подиум", position: 2 },
        { slug: "portfolio_notes", displayName: "Заметки по портфолио", fieldType: "textarea", required: false, aiExtractable: false, position: 3 },
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
        { slug: "client_name", displayName: "Клиент / площадка", fieldType: "text", required: false, aiExtractable: false, position: 1 },
        { slug: "location", displayName: "Локация", fieldType: "text", required: false, aiExtractable: false, position: 2 },
        { slug: "casting_result", displayName: "Результат кастинга", fieldType: "select", required: false, aiExtractable: false, position: 3,
          optionsJson: '[{"value":"approved","label":"Одобрен"},{"value":"pending","label":"На рассмотрении"},{"value":"rejected","label":"Не подошёл"}]' },
        { slug: "casting_notes", displayName: "Заметки кастинг-директора", fieldType: "textarea", required: false, aiExtractable: false, position: 4 },
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
        { slug: "contract_start_date", displayName: "Начало контракта", fieldType: "date", required: false, aiExtractable: false, position: 1 },
        { slug: "contract_end_date", displayName: "Конец контракта", fieldType: "date", required: false, aiExtractable: false, position: 2 },
        { slug: "day_rate_usd", displayName: "Дневная ставка (USD)", fieldType: "number", required: false, aiExtractable: false, position: 3 },
        { slug: "exclusive", displayName: "Эксклюзивный контракт", fieldType: "boolean", required: false, aiExtractable: false, position: 4 },
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
        { slug: "dance_styles", displayName: "Стили танца", fieldType: "multiselect", required: true, aiExtractable: true, position: 11,
          optionsJson: '[{"value":"show_ballet","label":"Шоу-балет"},{"value":"strip_plastic","label":"Стрип-пластика"},{"value":"pole","label":"Pole dance"},{"value":"latin","label":"Латина"},{"value":"contemporary","label":"Контемп"},{"value":"go_go","label":"Go-go"},{"value":"fire_show","label":"Fire show"},{"value":"acrobatics","label":"Акробатика"},{"value":"other","label":"Другое"}]' },
        { slug: "bust_waist_hips", displayName: "Параметры (ОГ/ОТ/ОБ)", fieldType: "text", required: false, aiExtractable: true, hint: "например: 88/60/90", position: 12 },
        { slug: "shoe_size", displayName: "Размер обуви (EU)", fieldType: "number", required: false, aiExtractable: true, position: 13 },
        { slug: "hair_color", displayName: "Цвет волос", fieldType: "select", required: false, aiExtractable: true, position: 14,
          optionsJson: '[{"value":"blonde","label":"Блондинка"},{"value":"brunette","label":"Брюнетка"},{"value":"red","label":"Рыжая"},{"value":"dark_blonde","label":"Тёмно-русая"},{"value":"other","label":"Другой"}]' },
        { slug: "eye_color", displayName: "Цвет глаз", fieldType: "select", required: false, aiExtractable: true, position: 15,
          optionsJson: '[{"value":"blue","label":"Голубые"},{"value":"green","label":"Зелёные"},{"value":"brown","label":"Карие"},{"value":"grey","label":"Серые"},{"value":"other","label":"Другой"}]' },
        { slug: "tattoos", displayName: "Татуировки / пирсинг", fieldType: "select", required: true, aiExtractable: true, position: 16,
          optionsJson: '[{"value":"none","label":"Нет"},{"value":"hidden","label":"Есть, скрытые"},{"value":"visible","label":"Есть, видимые"}]' },
        { slug: "has_valid_schengen", displayName: "Есть действующая шенген/US виза", fieldType: "boolean", required: false, aiExtractable: true, position: 17 },
        { slug: "additional_skills", displayName: "Доп. навыки", fieldType: "textarea", required: false, aiExtractable: true, hint: "вокал, акробатика, языки и т.д.", position: 18 },
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
        { slug: "visa_application_city", displayName: "Город подачи документов", fieldType: "text", required: true, aiExtractable: true, hint: "Ближайшее консульство или визовый центр", position: 0 },
        { slug: "family_name", displayName: "Фамилия (латиницей)", fieldType: "text", required: true, aiExtractable: true, hint: "Как в загранпаспорте", position: 1 },
        { slug: "given_name", displayName: "Имя (латиницей)", fieldType: "text", required: true, aiExtractable: true, hint: "Как в загранпаспорте", position: 2 },
        { slug: "date_of_birth", displayName: "Дата рождения", fieldType: "date", required: true, aiExtractable: true, position: 3 },
        { slug: "country_of_birth", displayName: "Страна рождения (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 4 },
        { slug: "birth_province", displayName: "Область / штат рождения (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 5 },
        { slug: "city_of_birth", displayName: "Город рождения (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 6 },
        { slug: "marital_status", displayName: "Семейное положение", fieldType: "select", required: true, aiExtractable: true, position: 7,
          optionsJson: '[{"value":"single","label":"Single"},{"value":"married","label":"Married"},{"value":"divorced","label":"Divorced"},{"value":"widowed","label":"Widowed"}]' },
        { slug: "current_nationality", displayName: "Гражданство (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 8 },
        { slug: "national_id_number", displayName: "Номер внутреннего паспорта", fieldType: "text", required: true, aiExtractable: true, position: 9 },
        { slug: "other_nationalities", displayName: "Другое гражданство (если есть)", fieldType: "text", required: false, aiExtractable: true, position: 10 },
        { slug: "other_permanent_residence", displayName: "ПМЖ в другой стране", fieldType: "boolean", required: false, aiExtractable: true, position: 11 },
        { slug: "held_other_nationalities", displayName: "Было ли другое гражданство ранее", fieldType: "boolean", required: false, aiExtractable: true, position: 12 },
        { slug: "passport_number", displayName: "Номер загранпаспорта", fieldType: "text", required: true, aiExtractable: true, position: 13 },
        { slug: "passport_issuing_country", displayName: "Страна выдачи загранпаспорта (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 14 },
        { slug: "passport_issuing_place", displayName: "Место выдачи загранпаспорта", fieldType: "text", required: true, aiExtractable: true, position: 15 },
        { slug: "passport_expiration_date", displayName: "Дата окончания загранпаспорта", fieldType: "date", required: true, aiExtractable: true, position: 16 },
        { slug: "current_address", displayName: "Адрес проживания (на английском)", fieldType: "textarea", required: true, aiExtractable: true, position: 17 },
        { slug: "phone", displayName: "Телефон", fieldType: "text", required: false, aiExtractable: true, position: 18 },
        { slug: "mobile_phone", displayName: "Мобильный телефон", fieldType: "text", required: true, aiExtractable: true, position: 19 },
        { slug: "email", displayName: "Email", fieldType: "text", required: true, aiExtractable: true, position: 20 },
        { slug: "father_name", displayName: "Имя отца (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 21 },
        { slug: "father_nationality", displayName: "Гражданство отца (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 22 },
        { slug: "father_dob", displayName: "Дата рождения отца", fieldType: "date", required: false, aiExtractable: true, position: 23 },
        { slug: "mother_name", displayName: "Имя матери (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 24 },
        { slug: "mother_nationality", displayName: "Гражданство матери (на английском)", fieldType: "text", required: true, aiExtractable: true, position: 25 },
        { slug: "mother_dob", displayName: "Дата рождения матери", fieldType: "date", required: false, aiExtractable: true, position: 26 },
        { slug: "been_to_china", displayName: "Были ли в Китае", fieldType: "boolean", required: true, aiExtractable: true, position: 27 },
        { slug: "previous_chinese_visa", displayName: "Предыдущие китайские визы (тип, номер, дата)", fieldType: "textarea", required: false, aiExtractable: true, position: 28 },
        { slug: "work_experience", displayName: "Опыт работы (обратный порядок)", fieldType: "textarea", required: false, aiExtractable: true, position: 29 },
        { slug: "education", displayName: "Образование", fieldType: "textarea", required: false, aiExtractable: true, position: 30 },
        { slug: "travel_history_12mo", displayName: "Поездки за рубеж за 12 месяцев", fieldType: "textarea", required: false, aiExtractable: true, position: 31 },
        { slug: "family_other", displayName: "Муж и дети (если есть)", fieldType: "textarea", required: false, aiExtractable: true, position: 32 },
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
      kind: "active",
      stageType: "milestone",
      position: 9,
      color: "#10b981",
      nextStages: ["closed"],
      fields: [],
    },
    {
      slug: "closed",
      displayName: "Завершено",
      kind: "terminal_won",
      stageType: "milestone",
      position: 10,
      color: "#10b981",
      nextStages: [],
      fields: [],
    },
    {
      slug: "rejected",
      displayName: "Отказ",
      kind: "terminal_lost",
      stageType: "milestone",
      position: 11,
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
   * GET /api/admin/funnel/analytics
   * Per-stage funnel analytics: current leads, entries, exits, avg time in stage.
   */
  app.get("/api/admin/funnel/analytics", async (c) => {
    const tenantId = c.var.tenantId;

    const stages = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: stageDefinitions.id,
          slug: stageDefinitions.slug,
          displayName: stageDefinitions.displayName,
          kind: stageDefinitions.kind,
          color: stageDefinitions.color,
          position: stageDefinitions.position,
        })
        .from(stageDefinitions)
        .where(eq(stageDefinitions.tenantId, tenantId))
        .orderBy(asc(stageDefinitions.position)),
    );

    if (stages.length === 0) return c.json({ stages: [] });

    // Leads currently in each stage
    const currentCounts = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          stageDefinitionId: leads.stageDefinitionId,
          n: count(),
        })
        .from(leads)
        .where(eq(leads.tenantId, tenantId))
        .groupBy(leads.stageDefinitionId),
    );
    const currentMap = new Map(currentCounts.map((r) => [r.stageDefinitionId, Number(r.n)]));

    // Entries per stage slug (toState events)
    const entryCounts = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ toState: leadEvents.toState, n: count() })
        .from(leadEvents)
        .where(eq(leadEvents.tenantId, tenantId))
        .groupBy(leadEvents.toState),
    );
    const entryMap = new Map(entryCounts.map((r) => [r.toState, Number(r.n)]));

    // Average time in stage: for each (lead, stageSlug) entry event, find the
    // next exit event and compute duration. Aggregated per stageSlug.
    const avgTimeRows = await withTenant(opts.db, tenantId, async (tx) =>
      tx.execute(sql`
        SELECT
          e_in.to_state AS slug,
          AVG(e_out.created_at - e_in.created_at)::float AS avg_seconds
        FROM lead_events e_in
        JOIN LATERAL (
          SELECT created_at
          FROM lead_events
          WHERE lead_id = e_in.lead_id
            AND from_state = e_in.to_state
            AND created_at > e_in.created_at
          ORDER BY created_at ASC
          LIMIT 1
        ) e_out ON TRUE
        WHERE e_in.tenant_id = ${tenantId}
        GROUP BY e_in.to_state
      `),
    );
    const avgMap = new Map<string, number>();
    for (const row of avgTimeRows as unknown as Array<{ slug: string; avg_seconds: number | null }>) {
      if (row.avg_seconds !== null) {
        avgMap.set(row.slug, row.avg_seconds / 86400); // seconds → days
      }
    }

    const result = stages.map((s) => ({
      id: s.id,
      slug: s.slug,
      displayName: s.displayName,
      kind: s.kind,
      color: s.color,
      position: s.position,
      leadsCurrent: currentMap.get(s.id) ?? 0,
      leadsEntered: entryMap.get(s.slug) ?? 0,
      avgDaysInStage: avgMap.has(s.slug) ? Math.round(avgMap.get(s.slug)! * 10) / 10 : null,
    }));

    return c.json({ stages: result });
  });

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

  /**
   * POST /api/admin/skills/seed
   * Засевает каталог навыков из SKILLS_CATALOGUE.
   * Новые slug'и → INSERT, изменившиеся promptFragment → UPDATE.
   * Удалённые из каталога slug'и — НЕ трогаются (data stays).
   * Returns: { seeded, updated, skipped }
   */
  app.post("/api/admin/skills/seed", async (c) => {
    const tenantId = c.var.tenantId;
    const nowEpoch = Math.floor(Date.now() / 1000);

    let seeded = 0;
    let updated = 0;
    let skipped = 0;

    await withTenant(opts.db, tenantId, async (tx) => {
      for (const entry of SKILLS_CATALOGUE) {
        const [existing] = await tx
          .select({ id: skills.id, promptFragment: skills.promptFragment })
          .from(skills)
          .where(and(eq(skills.tenantId, tenantId), eq(skills.slug, entry.slug)));

        if (!existing) {
          await tx.insert(skills).values({
            tenantId,
            slug: entry.slug,
            family: entry.family,
            displayName: entry.displayName,
            description: entry.description,
            promptFragment: entry.promptFragment,
            applicableStagesJson: JSON.stringify(entry.applicableStageKinds),
            intent: entry.intent,
            isEnabled: entry.isEnabled,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          });
          seeded++;
        } else if (existing.promptFragment !== entry.promptFragment) {
          await tx
            .update(skills)
            .set({ promptFragment: entry.promptFragment, updatedAt: nowEpoch })
            .where(eq(skills.id, existing.id));
          updated++;
        } else {
          skipped++;
        }
      }
    });

    return c.json({ ok: true, seeded, updated, skipped, total: SKILLS_CATALOGUE.length });
  });

  /**
   * PATCH /api/admin/skills/:slug
   * Обновить isEnabled и/или promptFragment конкретного навыка.
   * Body: { isEnabled?: boolean, promptFragment?: string }
   */
  app.patch("/api/admin/skills/:slug", async (c) => {
    const tenantId = c.var.tenantId;
    const slug = c.req.param("slug");

    let body: { isEnabled?: unknown; promptFragment?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const hasIsEnabled = typeof body.isEnabled === "boolean";
    const hasPromptFragment =
      typeof body.promptFragment === "string" && body.promptFragment.trim().length > 0;
    if (!hasIsEnabled && !hasPromptFragment) {
      return c.json({ error: "nothing to update" }, 400);
    }

    const setValues: {
      updatedAt: number;
      isEnabled?: boolean;
      promptFragment?: string;
    } = { updatedAt: Math.floor(Date.now() / 1000) };
    if (hasIsEnabled) setValues.isEnabled = body.isEnabled as boolean;
    if (hasPromptFragment) setValues.promptFragment = (body.promptFragment as string).trim();

    const updated = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(skills)
        .set(setValues)
        .where(and(eq(skills.tenantId, tenantId), eq(skills.slug, slug)))
        .returning({ id: skills.id }),
    );

    if (updated.length === 0) return c.json({ error: "skill not found" }, 404);
    return c.json({ ok: true });
  });

  /**
   * GET /api/admin/styles
   * Список стилей тенанта (не удалённых).
   */
  app.get("/api/admin/styles", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(styles)
        .where(and(eq(styles.tenantId, tenantId), isNull(styles.deletedAt)))
        .orderBy(asc(styles.slug), asc(styles.version)),
    );

    return c.json({ items: rows });
  });

  /**
   * GET /api/admin/experiments
   * Список экспериментов тенанта.
   */
  app.get("/api/admin/experiments", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(experiments)
        .where(eq(experiments.tenantId, tenantId))
        .orderBy(asc(experiments.createdAt)),
    );

    return c.json({ items: rows });
  });

  return app;
}
