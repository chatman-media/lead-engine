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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
        // 0. Find lead for this contact; auto-create if funnel exists
        let [lead] = await tx
          .select({
            id: leads.id,
            state: leads.state,
            stageDefinitionId: leads.stageDefinitionId,
          })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)));

        if (!lead) {
          // No lead — try to auto-create in the first stage of the active funnel
          const [activeFunnel] = await tx
            .select({ id: funnels.id })
            .from(funnels)
            .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
            .limit(1);

          if (activeFunnel) {
            const [firstStage] = await tx
              .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
              .from(stageDefinitions)
              .where(eq(stageDefinitions.funnelId, activeFunnel.id))
              .orderBy(asc(stageDefinitions.position))
              .limit(1);

            if (firstStage) {
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
                .onConflictDoNothing()
                .returning({
                  id: leads.id,
                  state: leads.state,
                  stageDefinitionId: leads.stageDefinitionId,
                });
              if (created) lead = created;
            }
          }
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
- Отвечай ТОЛЬКО JSON-объектом без markdown, без пояснений.`;

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
