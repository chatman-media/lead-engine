/**
 * AI field extraction for universal lead pipeline.
 *
 * After processInbound persists a user message, this module:
 *   0. If the contact has no lead and the tenant has an active funnel →
 *      auto-creates a lead in the funnel's first stage.
 *   1. Finds the contact's lead and its current stage.
 *   2. Loads stage fields with ai_extractable = true.
 *   3. Asks the tenant's chat LLM to extract structured values from the text.
 *   4. Writes extracted values to lead_field_values.
 *   5. Sends field_updated to WorkflowRuntime for auto-advance evaluation.
 *
 * Non-fatal: any LLM or DB error is caught. The calling webhook never waits.
 */

import { type Db, type NotificationService, withTenant } from "@chatman-media/conversation-engine";
import {
  funnels,
  leadEvents,
  leadFieldValues,
  leadNotes,
  leads,
  partnerServices,
  serviceCatalogItems,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { chooseServiceRoute, type ServiceRouteSelection } from "./service-intent-router.ts";
import {
  dispatchWorkflowEffects,
  handleFieldUpdatedInTx,
  type WorkflowEffect,
} from "./workflow-runtime.ts";

export { selectNextStage } from "./workflow-runtime.ts";

export interface FieldExtractor {
  extract(opts: {
    tenantId: number;
    contactId: number;
    text: string;
    db: Db;
  }): Promise<void>;
}

export function makeFieldExtractor(
  ref: LoadedRef,
  notificationService?: NotificationService,
): FieldExtractor {
  return {
    async extract({ tenantId, contactId, text, db }) {
      // Resolve chat client — skip if no chat config for this tenant
      let chatClient: ReturnType<typeof ref.router.resolveChat> | null = null;
      try {
        chatClient = ref.router.resolveChat(tenantId);
      } catch {
        return; // no chat LLM configured
      }
      if (!chatClient) return;

      const now = Math.floor(Date.now() / 1000);
      const workflowEffects: WorkflowEffect[] = [];

      await withTenant(db, tenantId, async (tx) => {
        // 0. Резолвим направление по тексту. Service Catalog имеет приоритет:
        // владелец может явно сказать, какая услуга ведёт в какой funnel,
        // partner-service, webhook или ручной разбор. Если catalog не совпал —
        // остаётся прежний deterministic intent-router.
        const activeFunnels = await tx
          .select({
            id: funnels.id,
            slug: funnels.slug,
            verticalTemplateId: funnels.verticalTemplateId,
          })
          .from(funnels)
          .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
          .orderBy(asc(funnels.id));
        const catalogItems = await tx
          .select({
            id: serviceCatalogItems.id,
            slug: serviceCatalogItems.slug,
            name: serviceCatalogItems.name,
            category: serviceCatalogItems.category,
            description: serviceCatalogItems.description,
            routeType: serviceCatalogItems.routeType,
            funnelId: serviceCatalogItems.funnelId,
            partnerServiceId: serviceCatalogItems.partnerServiceId,
            partnerServiceFunnelId: partnerServices.funnelId,
            partnerServiceStageDefinitionId: partnerServices.stageDefinitionId,
            webhookUrl: serviceCatalogItems.webhookUrl,
          })
          .from(serviceCatalogItems)
          .leftJoin(
            partnerServices,
            and(
              eq(partnerServices.tenantId, tenantId),
              eq(partnerServices.id, serviceCatalogItems.partnerServiceId),
            ),
          )
          .where(
            and(
              eq(serviceCatalogItems.tenantId, tenantId),
              eq(serviceCatalogItems.isActive, true),
            ),
          )
          .orderBy(asc(serviceCatalogItems.sortOrder), asc(serviceCatalogItems.id));
        const routeSelection = chooseServiceRoute({
          funnels: activeFunnels,
          catalogItems: catalogItems.map((item) => ({
            ...item,
            routeType: item.routeType as "manual" | "funnel" | "partner_service" | "webhook",
          })),
          text,
        });
        const activeFunnel = routeSelection.funnel;
        const [firstStage] = activeFunnel
          ? await tx
              .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
              .from(stageDefinitions)
              .where(eq(stageDefinitions.funnelId, activeFunnel.id))
              .orderBy(asc(stageDefinitions.position))
              .limit(1)
          : [];

        // Concierge multi-request: если первая стадия имеет поле `request_type`,
        // гость может держать несколько ПОСЛЕДОВАТЕЛЬНЫХ запросов — по одному
        // лиду на запрос. Тогда таргетим самый свежий НЕ-терминальный лид, а при
        // его отсутствии создаём новый. Для линейных воронок (нет поля
        // `request_type`) — прежнее поведение «один лид на контакт».
        let multiRequest = false;
        if (firstStage) {
          const [rtField] = await tx
            .select({ id: stageFields.id })
            .from(stageFields)
            .where(
              and(
                eq(stageFields.stageId, firstStage.id),
                eq(stageFields.slug, "request_type"),
              ),
            )
            .limit(1);
          multiRequest = !!rtField;
        }

        // Находим лид для извлечения.
        let lead:
          | { id: number; state: string; stageDefinitionId: number | null; requestType: string | null }
          | undefined;
        if (multiRequest) {
          // Самый свежий НЕ-терминальный лид контакта (concierge: N лидов).
          [lead] = await tx
            .select({
              id: leads.id,
              state: leads.state,
              stageDefinitionId: leads.stageDefinitionId,
              requestType: leads.requestType,
            })
            .from(leads)
            .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
            .where(
              and(
                eq(leads.tenantId, tenantId),
                eq(leads.userId, contactId),
                notInArray(stageDefinitions.kind, ["terminal_won", "terminal_lost"]),
              ),
            )
            .orderBy(desc(leads.updatedAt))
            .limit(1);
        } else {
          // Легаси: один лид на контакт.
          [lead] = await tx
            .select({
              id: leads.id,
              state: leads.state,
              stageDefinitionId: leads.stageDefinitionId,
              requestType: leads.requestType,
            })
            .from(leads)
            .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)));
        }

        // Нет (открытого) лида — создаём новый в первой стадии воронки.
        if (!lead && firstStage) {
          const [created] = await tx
            .insert(leads)
            .values({
              tenantId,
              userId: contactId,
              state: firstStage.slug,
              stageDefinitionId: firstStage.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning({
              id: leads.id,
              state: leads.state,
              stageDefinitionId: leads.stageDefinitionId,
              requestType: leads.requestType,
            });
          if (created) {
            lead = created;
            const routeNote = buildRouteAuditNote(routeSelection, activeFunnel);
            if (routeNote) {
              await tx.insert(leadEvents).values({
                tenantId,
                leadId: created.id,
                fromState: null,
                toState: firstStage.slug,
                notes: routeNote,
                createdAt: now,
              });
              await tx.insert(leadNotes).values({
                tenantId,
                leadId: created.id,
                body: buildRouteAuditBody(routeSelection, activeFunnel),
                source: "service_catalog",
                createdAt: now,
              });
            }
          }
        }

        if (!lead?.stageDefinitionId) return;

        // 2. Load stage + extractable fields
        const [stage] = await tx
          .select({
            id: stageDefinitions.id,
            funnelId: stageDefinitions.funnelId,
            kind: stageDefinitions.kind,
            nextStages: stageDefinitions.nextStages,
            autoAdvanceCondition: stageDefinitions.autoAdvanceCondition,
          })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.id, lead.stageDefinitionId),
              eq(stageDefinitions.tenantId, tenantId),
            ),
          );

        if (!stage) return;
        if (stage.kind === "terminal_won" || stage.kind === "terminal_lost") return;

        const extractableFields = await tx
          .select()
          .from(stageFields)
          .where(
            and(
              eq(stageFields.stageId, stage.id),
              eq(stageFields.tenantId, tenantId),
              eq(stageFields.aiExtractable, true),
            ),
          );

        if (extractableFields.length === 0) return;

        // 3. Build extraction prompt and call LLM
        const fieldDescriptions = extractableFields
          .map((f) => {
            let desc = `- "${f.slug}" (${f.displayName}, тип: ${f.fieldType}`;
            if (f.hint) desc += `, подсказка: ${f.hint}`;
            if (f.optionsJson && f.optionsJson !== "[]") {
              try {
                const opts = JSON.parse(f.optionsJson) as Array<{ value: string; label: string }>;
                desc += `, варианты: ${opts.map((o) => o.value).join("|")}`;
              } catch {
                // ignore
              }
            }
            desc += ")";
            return desc;
          })
          .join("\n");

        // Concierge: если лид уже в ветке (не на intake) — даём LLM возможность
        // в ТОМ ЖЕ вызове сигнализировать о НОВОМ параллельном запросе другого
        // типа (поле `_new_request`). Без доп. LLM-вызова.
        const inBranch =
          multiRequest && !!firstStage && lead.state !== firstStage.slug;
        const newRequestHint = inBranch
          ? '\n- ОТДЕЛЬНО: если гость в этом сообщении начинает СОВЕРШЕННО ДРУГУЮ услугу (не относящуюся к текущему запросу) — добавь поле "_new_request" со значением одного из: exchange|transfer|food. Если это продолжение текущего запроса — НЕ добавляй "_new_request".'
          : "";

        const systemPrompt = `Ты — ассистент по извлечению данных из текста диалога.
Из сообщения пользователя извлеки значения следующих полей (если они упомянуты):

${fieldDescriptions}

Верни JSON-объект, где ключи — slug'и полей, а значения — извлечённые данные.
Правила:
- Включай только те поля, которые явно упомянуты в тексте.
- Для boolean полей: true/false.
- Для select/multiselect: ровно одно из допустимых значений (value, не label).
- Для number: только число без единиц измерения.
- Для date: ISO-формат YYYY-MM-DD.
- Если поле не упомянуто — не включай его в ответ.
- Отвечай ТОЛЬКО JSON-объектом без markdown, без пояснений.${newRequestHint}`;

        let responseText: string;
        try {
          responseText = await chatClient.complete([
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ]);
        } catch {
          return; // LLM error — skip silently
        }

        // 4. Parse extracted values
        let extracted: Record<string, unknown> = {};
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } catch {
          return; // bad JSON from LLM
        }

        if (Object.keys(extracted).length === 0) return;

        // 4b. Параллельный запрос (concierge): гость начал ДРУГУЮ услугу в треде
        // с уже открытым запросом → заводим ОТДЕЛЬНЫЙ лид сразу в его ветке, не
        // смешивая с текущим. Сигнал `_new_request` пришёл в том же LLM-ответе.
        if (inBranch) {
          const nr =
            typeof extracted._new_request === "string"
              ? extracted._new_request.trim()
              : null;
          if (nr && nr !== lead.requestType) {
            const [branchStage] = await tx
              .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
              .from(stageDefinitions)
              .where(
                and(
              eq(stageDefinitions.tenantId, tenantId),
              eq(stageDefinitions.slug, `${nr}_request`),
              eq(stageDefinitions.funnelId, stage.funnelId),
            ),
          );
            if (branchStage) {
              const [created] = await tx
                .insert(leads)
                .values({
                  tenantId,
                  userId: contactId,
                  state: branchStage.slug,
                  stageDefinitionId: branchStage.id,
                  requestType: nr,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: leads.id });
              if (created) {
                await tx.insert(leadEvents).values({
                  tenantId,
                  leadId: created.id,
                  fromState: firstStage?.slug ?? "request_received",
                  toState: branchStage.slug,
                  createdAt: now,
                });
                return; // новый параллельный запрос заведён — сообщение обработано
              }
            }
          }
        }

        // 5. Write to lead_field_values
        const fieldBySlug = new Map(extractableFields.map((f) => [f.slug, f]));
        for (const [slug, value] of Object.entries(extracted)) {
          const field = fieldBySlug.get(slug);
          if (!field) continue;
          await tx
            .insert(leadFieldValues)
            .values({
              leadId: lead.id,
              fieldId: field.id,
              tenantId,
              valueJson: JSON.stringify(value),
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [leadFieldValues.leadId, leadFieldValues.fieldId],
              set: { valueJson: JSON.stringify(value), updatedAt: now },
            });
        }

        const workflowResult = await handleFieldUpdatedInTx(tx, {
          tenantId,
          leadId: lead.id,
          extractedValues: extracted,
          now,
        });
        workflowEffects.push(...workflowResult.effects);
      });

      // Проактивный пинг оператору: лид вошёл в awaiting_operator → нужен человек.
      // Fire-and-forget, вне tx (Telegram I/O). /send-offer шлёт на ВЫХОДЕ из стадии.
      dispatchWorkflowEffects(workflowEffects, notificationService);
    },
  };
}

function buildRouteAuditNote(
  route: ServiceRouteSelection,
  funnel: { id: number; slug: string; verticalTemplateId: string | null } | null,
): string | null {
  if (route.source !== "catalog" || !route.catalogItem) return null;
  const item = route.catalogItem;
  return JSON.stringify({
    type: "service_catalog_route",
    catalogItemId: item.id,
    catalogItemSlug: item.slug,
    catalogItemName: item.name,
    routeType: item.routeType,
    targetFunnelId: funnel?.id ?? null,
    targetFunnelSlug: funnel?.slug ?? null,
    partnerServiceId: item.partnerServiceId,
    partnerServiceStageDefinitionId: item.partnerServiceStageDefinitionId,
    webhookUrl: item.webhookUrl,
    intent: route.intent,
  });
}

function buildRouteAuditBody(
  route: ServiceRouteSelection,
  funnel: { slug: string } | null,
): string {
  const item = route.catalogItem;
  if (!item) return "Маршрут создан через каталог услуг.";
  const target =
    item.routeType === "funnel"
      ? `воронка ${funnel?.slug ?? "не выбрана"}`
      : item.routeType === "partner_service"
        ? `партнёрская услуга #${item.partnerServiceId ?? "не выбрана"}`
        : item.routeType === "webhook"
          ? `webhook ${item.webhookUrl ?? "не задан"}`
          : "ручная обработка оператором";
  return `Маршрут из каталога услуг: ${item.name} (${item.slug}) → ${target}.`;
}
