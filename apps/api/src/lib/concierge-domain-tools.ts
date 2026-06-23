/**
 * Concierge domain action tools — Фаза 3 (#175).
 *
 * Доменные инструменты для сервисных вертикалей: трансфер, еда, уборка, экскурсия.
 * До этой фазы стадии собирали поля и двигали лид, но цену/срок ставил оператор.
 * Теперь AI читает сервисный каталог тенанта и возвращает котировку/варианты сам.
 *
 * Каталог хранится как JSON в tenant_secrets под ключом "concierge_catalog".
 * Тенант настраивает его через admin-API (PUT /api/admin/concierge/catalog).
 *
 * Инструменты: по 2 на каждый тип (options/quote + confirm).
 * Стадийное продвижение лида по-прежнему делает funnel engine (field-extractor);
 * инструменты только считают цену и возвращают детали боту.
 */

import { type Db, getDecryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import { conversations, leads, stageDefinitions } from "@chatman-media/storage";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";

// ── Catalog types ─────────────────────────────────────────────────────────────

export interface TransferClass {
  id: string;
  name: string;
  description?: string;
  capacity?: number;
  /** Base price for a standard route. */
  priceBase: number;
  currency: string;
}

export interface FoodItem {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  category?: string;
  /** Defaults to true if absent. */
  available?: boolean;
}

export interface HousekeepingConfig {
  ratePerHour: number;
  currency: string;
  minHours?: number;
  /** Slot labels, e.g. ["10:00","14:00","18:00"] */
  availableSlots?: string[];
}

export interface TourOption {
  id: string;
  name: string;
  description?: string;
  duration?: string;
  pricePerPerson: number;
  currency: string;
  minParticipants?: number;
  maxParticipants?: number;
}

export interface ConciergeCatalog {
  transfer?: { classes: TransferClass[] };
  food?: {
    menu: FoodItem[];
    deliveryFee?: number;
    currency?: string;
    etaMinutes?: number;
  };
  housekeeping?: HousekeepingConfig;
  tour?: { options: TourOption[] };
}

// ── Catalog loader ─────────────────────────────────────────────────────────────

export const CONCIERGE_CATALOG_KEY = "concierge_catalog";

export async function loadConciergeCatalog(
  db: Db,
  tenantId: number,
  masterKeyHex: string,
): Promise<ConciergeCatalog | null> {
  const json = await getDecryptedSecret({
    db,
    tenantId,
    key: CONCIERGE_CATALOG_KEY,
    masterKeyHex,
  });
  if (!json) return null;
  try {
    return JSON.parse(json) as ConciergeCatalog;
  } catch {
    return null;
  }
}

// ── Resolve current request type for the conversation ────────────────────────

async function resolveCurrentRequestType(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<string | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [conv] = await tx
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv?.userId) return null;

    const rows = await tx
      .select({
        requestType: leads.requestType,
        kind: stageDefinitions.kind,
      })
      .from(leads)
      .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
      .where(
        and(
          eq(leads.tenantId, tenantId),
          eq(leads.userId, conv.userId),
          notInArray(stageDefinitions.kind, ["terminal_won", "terminal_lost"]),
        ),
      )
      .orderBy(desc(leads.updatedAt))
      .limit(1);

    return rows[0]?.requestType ?? null;
  });
}

// ── Tool factories ─────────────────────────────────────────────────────────────

export interface ConciergeDomainToolsDeps {
  db: Db;
  tenantId: number;
  conversationId: number;
  masterKeyHex: string;
}

// ─── Transfer ──────────────────────────────────────────────────────────────────

function makeTransferOptionsTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "get_transfer_options",
    description: [
      "Список доступных вариантов трансфера (классы авто + цены) из настроек тенанта.",
      "Вызывай, когда гость просит трансфер: «куда нужно ехать», «сколько стоит»,",
      "«есть ли машины», «минивэн», «бизнес-класс». Передай маршрут/время если назвал.",
      "НЕ выдумывай цены — возвращай только то, что вернул инструмент.",
    ].join(" "),
    parameters: z.object({
      pickup: z.string().optional().describe("Место/адрес отправления"),
      dropoff: z.string().optional().describe("Место/адрес назначения"),
      datetime: z.string().optional().describe("Дата и время поездки (строка от гостя)"),
      passengers: z.number().int().positive().optional().describe("Количество пассажиров"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "transfer") {
        return {
          error: `Инструмент трансфера не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.transfer?.classes?.length) {
        return {
          needsOperator: true,
          note: "Тарифы трансфера не настроены. Уточни детали у оператора.",
        };
      }
      const available = args.passengers
        ? catalog.transfer.classes.filter((c) => !c.capacity || c.capacity >= args.passengers!)
        : catalog.transfer.classes;
      return {
        options: available.map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
          ...(c.capacity ? { capacity: c.capacity } : {}),
          price: c.priceBase,
          currency: c.currency,
        })),
        ...(args.pickup ? { pickup: args.pickup } : {}),
        ...(args.dropoff ? { dropoff: args.dropoff } : {}),
        ...(args.datetime ? { datetime: args.datetime } : {}),
      };
    },
  };
}

function makeConfirmTransferTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "confirm_transfer_booking",
    description: [
      "Подтвердить бронирование трансфера — выбранный класс + маршрут + время.",
      "Вызывай ПОСЛЕ того, как гость выбрал класс авто и согласился.",
      "Возвращает итоговую стоимость и детали для передачи оператору.",
    ].join(" "),
    parameters: z.object({
      classId: z.string().describe("ID класса авто из get_transfer_options"),
      pickup: z.string().describe("Место отправления"),
      dropoff: z.string().describe("Место назначения"),
      datetime: z.string().describe("Дата и время поездки"),
      passengers: z.number().int().positive().optional().describe("Количество пассажиров"),
      notes: z.string().optional().describe("Пожелания гостя (детское кресло, багаж и т.п.)"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "transfer") {
        return {
          error: `Инструмент трансфера не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      const cls = catalog?.transfer?.classes?.find((c) => c.id === args.classId);
      if (!cls) {
        return {
          needsOperator: true,
          note: "Выбранный класс не найден в каталоге. Оператор уточнит детали.",
        };
      }
      return {
        ok: true,
        service: "transfer",
        classId: cls.id,
        className: cls.name,
        pickup: args.pickup,
        dropoff: args.dropoff,
        datetime: args.datetime,
        ...(args.passengers ? { passengers: args.passengers } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        price: cls.priceBase,
        currency: cls.currency,
        summary: `Трансфер: ${cls.name} | ${args.pickup} → ${args.dropoff} | ${args.datetime} | ${cls.priceBase} ${cls.currency}`,
        nextStep: "needsOperator",
        note: "Заявка принята. Оператор свяжется с гостем для подтверждения и уточнения деталей.",
      };
    },
  };
}

// ─── Food ──────────────────────────────────────────────────────────────────────

function makeGetFoodMenuTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "get_food_menu",
    description: [
      "Меню доставки еды: позиции + цены из настроек тенанта.",
      "Вызывай, когда гость просит еду/доставку: «что есть поесть», «меню»,",
      "«закажи пиццу», «что можно заказать». Можно фильтровать по категории.",
      "НЕ выдумывай цены и состав — возвращай только данные из инструмента.",
    ].join(" "),
    parameters: z.object({
      category: z.string().optional().describe("Категория для фильтрации (пицца, суши, напитки…)"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "food") {
        return {
          error: `Инструмент заказа еды не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.food?.menu?.length) {
        return {
          needsOperator: true,
          note: "Меню не настроено. Оператор подскажет варианты.",
        };
      }
      let items = catalog.food.menu.filter((i) => i.available !== false);
      if (args.category) {
        const cat = args.category.toLowerCase();
        items = items.filter(
          (i) => i.category?.toLowerCase().includes(cat) || i.name.toLowerCase().includes(cat),
        );
      }
      return {
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          ...(i.description ? { description: i.description } : {}),
          ...(i.category ? { category: i.category } : {}),
          price: i.price,
          currency: i.currency,
        })),
        ...(catalog.food.deliveryFee !== undefined
          ? {
              deliveryFee: catalog.food.deliveryFee,
              deliveryCurrency: catalog.food.currency ?? items[0]?.currency,
            }
          : {}),
        ...(catalog.food.etaMinutes ? { etaMinutes: catalog.food.etaMinutes } : {}),
      };
    },
  };
}

function makeConfirmFoodOrderTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "confirm_food_order",
    description: [
      "Оформить заказ еды. Вызывай ПОСЛЕ того, как гость выбрал позиции и согласился.",
      "Передай items — список {id, qty} из меню. Возвращает итог и время доставки.",
    ].join(" "),
    parameters: z.object({
      items: z
        .array(z.object({ id: z.string(), qty: z.number().int().positive() }))
        .min(1)
        .describe("Выбранные позиции меню с количеством"),
      deliveryLocation: z.string().optional().describe("Куда доставить: номер, корпус, адрес"),
      notes: z.string().optional().describe("Пожелания: без лука, аллергии и т.п."),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "food") {
        return {
          error: `Инструмент заказа еды не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.food?.menu?.length) {
        return {
          needsOperator: true,
          note: "Меню не настроено. Оператор примет заказ вручную.",
        };
      }
      const menuById = new Map(catalog.food.menu.map((i) => [i.id, i]));
      const lines: Array<{
        id: string;
        name: string;
        qty: number;
        lineTotal: number;
        currency: string;
      }> = [];
      const unknown: string[] = [];
      for (const item of args.items) {
        const m = menuById.get(item.id);
        if (!m) {
          unknown.push(item.id);
          continue;
        }
        lines.push({
          id: m.id,
          name: m.name,
          qty: item.qty,
          lineTotal: m.price * item.qty,
          currency: m.currency,
        });
      }
      if (unknown.length) {
        return {
          error: `Позиции не найдены в меню: ${unknown.join(", ")}. Используй get_food_menu.`,
        };
      }
      const currency = lines[0]?.currency ?? catalog.food.currency ?? "";
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const deliveryFee = catalog.food.deliveryFee ?? 0;
      const total = subtotal + deliveryFee;
      return {
        ok: true,
        service: "food",
        lines,
        subtotal,
        ...(deliveryFee ? { deliveryFee, deliveryCurrency: currency } : {}),
        total,
        currency,
        ...(args.deliveryLocation ? { deliveryLocation: args.deliveryLocation } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        ...(catalog.food.etaMinutes ? { etaMinutes: catalog.food.etaMinutes } : {}),
        summary: `Заказ: ${lines.map((l) => `${l.name}×${l.qty}`).join(", ")} | итого ${total} ${currency}`,
        nextStep: "needsOperator",
        note: "Заявка принята. Оператор подтвердит заказ и сообщит точное время.",
      };
    },
  };
}

// ─── Housekeeping ──────────────────────────────────────────────────────────────

function makeGetHousekeepingOptionsTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "get_housekeeping_options",
    description: [
      "Варианты уборки: ставка в час, минимальное время, доступные слоты.",
      "Вызывай, когда гость просит уборку: «уборка», «убрать номер», «почистить»,",
      "«прийти убраться», «когда свободны». Передай желаемую дату если назвал.",
    ].join(" "),
    parameters: z.object({
      date: z.string().optional().describe("Желаемая дата уборки (строка от гостя)"),
      hours: z.number().positive().optional().describe("Сколько часов планирует (если назвал)"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "housekeeping") {
        return {
          error: `Инструмент уборки не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.housekeeping) {
        return {
          needsOperator: true,
          note: "Расписание уборки не настроено. Оператор уточнит.",
        };
      }
      const hk = catalog.housekeeping;
      const estimate = args.hours
        ? {
            hours: args.hours,
            totalPrice: args.hours * hk.ratePerHour,
            currency: hk.currency,
          }
        : null;
      return {
        ratePerHour: hk.ratePerHour,
        currency: hk.currency,
        ...(hk.minHours ? { minHours: hk.minHours } : {}),
        ...(hk.availableSlots?.length ? { availableSlots: hk.availableSlots } : {}),
        ...(args.date ? { requestedDate: args.date } : {}),
        ...(estimate ? { estimate } : {}),
      };
    },
  };
}

function makeConfirmHousekeepingTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "confirm_housekeeping_booking",
    description: [
      "Подтвердить бронирование уборки. Вызывай ПОСЛЕ согласия гостя.",
      "Возвращает итоговую стоимость и детали для передачи оператору.",
    ].join(" "),
    parameters: z.object({
      date: z.string().describe("Дата уборки"),
      timeSlot: z.string().optional().describe("Временной слот (из get_housekeeping_options)"),
      hours: z.number().positive().describe("Продолжительность в часах"),
      notes: z.string().optional().describe("Пожелания гостя"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "housekeeping") {
        return {
          error: `Инструмент уборки не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.housekeeping) {
        return {
          needsOperator: true,
          note: "Расписание уборки не настроено. Оператор уточнит.",
        };
      }
      const hk = catalog.housekeeping;
      const effectiveHours = Math.max(args.hours, hk.minHours ?? 1);
      const total = effectiveHours * hk.ratePerHour;
      return {
        ok: true,
        service: "housekeeping",
        date: args.date,
        ...(args.timeSlot ? { timeSlot: args.timeSlot } : {}),
        hours: effectiveHours,
        ...(args.notes ? { notes: args.notes } : {}),
        total,
        currency: hk.currency,
        summary: `Уборка ${args.date}${args.timeSlot ? ` в ${args.timeSlot}` : ""}, ${effectiveHours} ч — ${total} ${hk.currency}`,
        nextStep: "needsOperator",
        note: "Заявка принята. Оператор подтвердит время и пришлёт исполнителя.",
      };
    },
  };
}

// ─── Tour ──────────────────────────────────────────────────────────────────────

function makeGetTourOptionsTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "get_tour_options",
    description: [
      "Список доступных экскурсий + цены. Вызывай, когда гость просит",
      "экскурсию/тур: «что посмотреть», «есть ли экскурсии», «куда можно съездить»,",
      "«обзорная», «пляжный тур», «сколько стоит». Передай количество человек если назвал.",
    ].join(" "),
    parameters: z.object({
      participants: z.number().int().positive().optional().describe("Количество участников"),
      date: z.string().optional().describe("Желаемая дата"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "tour") {
        return {
          error: `Инструмент экскурсий не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      if (!catalog?.tour?.options?.length) {
        return {
          needsOperator: true,
          note: "Экскурсии не настроены. Оператор предложит варианты.",
        };
      }
      const options = args.participants
        ? catalog.tour.options.filter(
            (o) =>
              (!o.minParticipants || args.participants! >= o.minParticipants) &&
              (!o.maxParticipants || args.participants! <= o.maxParticipants),
          )
        : catalog.tour.options;
      return {
        options: options.map((o) => ({
          id: o.id,
          name: o.name,
          ...(o.description ? { description: o.description } : {}),
          ...(o.duration ? { duration: o.duration } : {}),
          pricePerPerson: o.pricePerPerson,
          currency: o.currency,
          ...(o.minParticipants ? { minParticipants: o.minParticipants } : {}),
          ...(o.maxParticipants ? { maxParticipants: o.maxParticipants } : {}),
          ...(args.participants ? { totalPrice: o.pricePerPerson * args.participants } : {}),
        })),
        ...(args.date ? { requestedDate: args.date } : {}),
        ...(args.participants ? { participants: args.participants } : {}),
      };
    },
  };
}

function makeConfirmTourBookingTool(deps: ConciergeDomainToolsDeps): AnyRagTool {
  const { db, tenantId, masterKeyHex, conversationId } = deps;
  return {
    name: "confirm_tour_booking",
    description: [
      "Подтвердить бронирование экскурсии. Вызывай ПОСЛЕ согласия гостя.",
      "tourId — из get_tour_options. Возвращает итоговую стоимость для оператора.",
    ].join(" "),
    parameters: z.object({
      tourId: z.string().describe("ID тура из get_tour_options"),
      date: z.string().describe("Дата экскурсии"),
      participants: z.number().int().positive().describe("Количество участников"),
      notes: z.string().optional().describe("Пожелания гостя"),
    }),
    execute: async (args) => {
      const rt = await resolveCurrentRequestType(db, tenantId, conversationId);
      if (rt && rt !== "tour") {
        return {
          error: `Инструмент экскурсий не применим для запроса типа «${rt}».`,
        };
      }
      const catalog = await loadConciergeCatalog(db, tenantId, masterKeyHex);
      const tour = catalog?.tour?.options?.find((o) => o.id === args.tourId);
      if (!tour) {
        return {
          needsOperator: true,
          note: "Выбранный тур не найден в каталоге. Оператор уточнит наличие.",
        };
      }
      if (tour.minParticipants && args.participants < tour.minParticipants) {
        return {
          error: `Минимальное количество участников для этого тура: ${tour.minParticipants}.`,
        };
      }
      if (tour.maxParticipants && args.participants > tour.maxParticipants) {
        return {
          error: `Максимальное количество участников для этого тура: ${tour.maxParticipants}.`,
        };
      }
      const total = tour.pricePerPerson * args.participants;
      return {
        ok: true,
        service: "tour",
        tourId: tour.id,
        tourName: tour.name,
        date: args.date,
        participants: args.participants,
        ...(args.notes ? { notes: args.notes } : {}),
        ...(tour.duration ? { duration: tour.duration } : {}),
        pricePerPerson: tour.pricePerPerson,
        total,
        currency: tour.currency,
        summary: `${tour.name} | ${args.date} | ${args.participants} чел. | ${total} ${tour.currency}`,
        nextStep: "needsOperator",
        note: "Заявка принята. Оператор подтвердит бронирование и пришлёт детали встречи.",
      };
    },
  };
}

// ── Public factory ─────────────────────────────────────────────────────────────

/**
 * Создаёт все 8 доменных инструментов concierge (2 на тип: options + confirm).
 * Гейтится на `tenantSupportsMultiRequest` — вызывай только когда он true.
 * Каждый инструмент внутренне проверяет текущий requestType и отказывает если
 * тип не совпадает, чтобы LLM не смешивал контексты разных запросов гостя.
 */
export function makeConciergeDomainTools(deps: ConciergeDomainToolsDeps): AnyRagTool[] {
  return [
    makeTransferOptionsTool(deps),
    makeConfirmTransferTool(deps),
    makeGetFoodMenuTool(deps),
    makeConfirmFoodOrderTool(deps),
    makeGetHousekeepingOptionsTool(deps),
    makeConfirmHousekeepingTool(deps),
    makeGetTourOptionsTool(deps),
    makeConfirmTourBookingTool(deps),
  ];
}
