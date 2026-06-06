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
 *   5. Checks auto-advance: if autoAdvanceCondition = all_required_fields_filled
 *      and all required fields are now filled, advances the lead to nextStages[0].
 *
 * Non-fatal: any LLM or DB error is caught. The calling webhook never waits.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  funnels,
  leadEvents,
  leadFieldValues,
  leads,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { LoadedRef } from "../llm-bootstrap.ts";

export interface FieldExtractor {
  extract(opts: {
    tenantId: number;
    contactId: number;
    text: string;
    db: Db;
  }): Promise<void>;
}

/**
 * Выбор следующей стадии при auto-advance.
 *
 * Branch-aware (concierge): если у стадии есть поле `request_type` и >1 ветки,
 * уводим в ветку `<request_type>_*` (напр. `transfer` → `transfer_request`) и
 * возвращаем `requestType` для записи в `leads.request_type`. Если валидной
 * ветки нет (напр. `other` / не распознано) — возвращаем `null` = «не
 * продвигать», лид остаётся на intake для оператора/уточнения.
 *
 * Линейные воронки (5 вертикалей) не затронуты: у их стадий нет поля
 * `request_type`, поэтому `hasRequestTypeField=false` → прежнее поведение
 * `nextStages[0]`, `requestType=null` (колонка не трогается).
 */
export function selectNextStage(opts: {
  nextStages: readonly string[];
  hasRequestTypeField: boolean;
  requestType: string | null;
}): { nextSlug: string; requestType: string | null } | null {
  const { nextStages, hasRequestTypeField, requestType } = opts;
  if (hasRequestTypeField && nextStages.length > 1) {
    const branch = requestType
      ? nextStages.find(
          (s) => s === `${requestType}_request` || s.startsWith(`${requestType}_`),
        )
      : undefined;
    if (!branch) return null;
    return { nextSlug: branch, requestType };
  }
  const first = nextStages[0];
  if (!first) return null;
  return { nextSlug: first, requestType: null };
}

export function makeFieldExtractor(ref: LoadedRef): FieldExtractor {
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

      await withTenant(db, tenantId, async (tx) => {
        // 0. Резолвим активную воронку и её первую (intake) стадию — нужны и
        // для определения multi-request режима, и для auto-create лида.
        const [activeFunnel] = await tx
          .select({ id: funnels.id })
          .from(funnels)
          .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
          .limit(1);
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
          if (created) lead = created;
        }

        if (!lead?.stageDefinitionId) return;

        // 2. Load stage + extractable fields
        const [stage] = await tx
          .select({
            id: stageDefinitions.id,
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

        // 6. Check auto-advance
        let condition: { type: string } | null = null;
        try {
          condition = stage.autoAdvanceCondition
            ? (JSON.parse(stage.autoAdvanceCondition) as { type: string })
            : null;
        } catch {
          return;
        }
        if (condition?.type !== "all_required_fields_filled") return;
        if (!stage.nextStages.length) return;

        const allRequired = await tx
          .select({ id: stageFields.id })
          .from(stageFields)
          .where(
            and(eq(stageFields.stageId, stage.id), eq(stageFields.required, true)),
          );
        if (allRequired.length === 0) return;

        const filledRequired = await tx
          .select({ id: leadFieldValues.fieldId })
          .from(leadFieldValues)
          .where(
            and(
              eq(leadFieldValues.leadId, lead.id),
              inArray(
                leadFieldValues.fieldId,
                allRequired.map((f) => f.id),
              ),
              sql`${leadFieldValues.valueJson} != 'null' AND ${leadFieldValues.valueJson} != '""' AND ${leadFieldValues.valueJson} != ''`,
            ),
          );
        if (filledRequired.length < allRequired.length) return;

        // 7. Advance the lead. Branch-aware для concierge — логика в чистой
        // selectNextStage(); здесь только резолвим значение request_type
        // (из текущей экстракции или из сохранённого) для ветвящихся стадий.
        const requestTypeField = extractableFields.find((f) => f.slug === "request_type");
        let rt: string | null = null;
        if (requestTypeField) {
          rt = typeof extracted.request_type === "string" ? extracted.request_type : null;
          if (!rt) {
            const [stored] = await tx
              .select({ valueJson: leadFieldValues.valueJson })
              .from(leadFieldValues)
              .where(
                and(
                  eq(leadFieldValues.leadId, lead.id),
                  eq(leadFieldValues.fieldId, requestTypeField.id),
                ),
              );
            if (stored?.valueJson) {
              try {
                const v = JSON.parse(stored.valueJson);
                if (typeof v === "string") rt = v;
              } catch {
                // ignore malformed stored value
              }
            }
          }
        }

        const selected = selectNextStage({
          nextStages: stage.nextStages,
          hasRequestTypeField: !!requestTypeField,
          requestType: rt,
        });
        if (!selected) return;
        const { nextSlug, requestType: resolvedRequestType } = selected;

        const [nextStageDef] = await tx
          .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.slug, nextSlug),
              eq(stageDefinitions.tenantId, tenantId),
            ),
          );
        if (!nextStageDef) return;

        await tx
          .update(leads)
          .set({
            stageDefinitionId: nextStageDef.id,
            state: nextStageDef.slug,
            ...(resolvedRequestType ? { requestType: resolvedRequestType } : {}),
            updatedAt: now,
          })
          .where(eq(leads.id, lead.id));

        await tx.insert(leadEvents).values({
          tenantId,
          leadId: lead.id,
          fromState: lead.state,
          toState: nextStageDef.slug,
          createdAt: now,
        });
      });
    },
  };
}
