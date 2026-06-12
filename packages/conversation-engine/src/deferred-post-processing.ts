import { ContactsRepo, MessagesRepo } from "./dal/index.ts";
import type { Db } from "./dal/types.ts";
import { ensureAndAdvanceLeadByPhase } from "./lead-advance.ts";
import type { MemoryExtractor } from "./memory-extractor.ts";
import { applyClassifiedStage, type StageClassifier } from "./stage-classifier.ts";
import {
  type Clock,
  type PipelineSink,
  type ProcessInboundResult,
  systemClock,
  type TenantContext,
} from "./types.ts";
import { withTenant } from "./with-tenant.ts";

export interface RunDeferredInboundPostProcessingDeps {
  db: Db;
  tenant: TenantContext;
  result: ProcessInboundResult;
  stageClassifier?: StageClassifier | null;
  memoryExtractor?: MemoryExtractor | null;
  /** Preserve legacy lead auto-advance only for call sites that used LeadsRepo. */
  advanceLead?: boolean;
  /** Prefer stages from the active funnel owned by the current vertical template. */
  preferredVerticalTemplateId?: string | null;
  sink?: PipelineSink;
  clock?: Clock;
}

/**
 * Completes the split-pipeline work intentionally deferred by processInbound:
 *
 *   tx1 persist -> outside-tx classify/extract -> tx1b write stage/memory
 *
 * Classifier and memory LLM calls run outside DB transactions. Any DB reads
 * needed for RLS-sensitive context are done in short `withTenant` snapshots.
 */
export async function runDeferredInboundPostProcessing(
  deps: RunDeferredInboundPostProcessingDeps,
): Promise<void> {
  const text = deps.result.userMessageText ?? "";
  if (!deps.result.persisted || text.length === 0) return;

  const clock = deps.clock ?? systemClock;
  const now = clock.nowEpoch();

  await runDeferredStageClassification({ ...deps, text, now });
  await runDeferredMemoryExtraction({ ...deps, now });
}

async function runDeferredStageClassification(
  deps: RunDeferredInboundPostProcessingDeps & { text: string; now: number },
): Promise<void> {
  if (!deps.stageClassifier) return;

  try {
    const newStage = await deps.stageClassifier.classify({
      tenantId: deps.tenant.tenantId,
      userMessageText: deps.text,
      previousStage: deps.result.previousStage ?? null,
      isFirstUserMessage: deps.result.conversationCreated ?? false,
    });

    await withTenant(deps.db, deps.tenant.tenantId, async (tx) => {
      const changed = await applyClassifiedStage({
        db: tx,
        tenantId: deps.tenant.tenantId,
        conversationId: deps.result.conversationId,
        newStage,
      });
      if (changed) {
        deps.sink?.log?.("debug", "conversation stage classified", {
          tenantId: deps.tenant.tenantId,
          conversationId: deps.result.conversationId,
          from: deps.result.previousStage ?? null,
          to: newStage,
        });
      }

      if (newStage && newStage !== "opener" && deps.advanceLead) {
        try {
          const res = await ensureAndAdvanceLeadByPhase({
            db: tx,
            tenantId: deps.tenant.tenantId,
            contactId: deps.result.contactId,
            salesStage: newStage,
            preferredVerticalTemplateId: deps.preferredVerticalTemplateId ?? null,
            nowEpoch: deps.now,
          });
          if (res && (res.created || res.advanced)) {
            deps.sink?.log?.("info", res.created ? "lead auto-created" : "lead advanced", {
              tenantId: deps.tenant.tenantId,
              conversationId: deps.result.conversationId,
              contactId: deps.result.contactId,
              leadId: res.leadId,
              stage: res.stageSlug,
              salesStage: newStage,
            });
          }
        } catch (err) {
          deps.sink?.log?.("warn", "lead auto-advance failed", {
            tenantId: deps.tenant.tenantId,
            conversationId: deps.result.conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  } catch (err) {
    deps.sink?.log?.("warn", "stage classifier failed", {
      tenantId: deps.tenant.tenantId,
      conversationId: deps.result.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runDeferredMemoryExtraction(
  deps: RunDeferredInboundPostProcessingDeps & { now: number },
): Promise<void> {
  if (!deps.memoryExtractor) return;

  try {
    const snapshot = await withTenant(deps.db, deps.tenant.tenantId, async (tx) => {
      const contacts = new ContactsRepo({ db: tx, tenantId: deps.tenant.tenantId });
      const contact = await contacts.byId(deps.result.contactId);
      if (!contact) return null;

      const existingFacts: Record<string, string> = {};
      if (contact.attributesJson) {
        const parsed = JSON.parse(contact.attributesJson) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") existingFacts[key] = value;
        }
      }

      const messages = new MessagesRepo({ db: tx, tenantId: deps.tenant.tenantId });
      const history = await messages.recent(
        deps.result.conversationId,
        deps.memoryExtractor?.historyLimit ?? 10,
      );

      return { existingFacts, history };
    });
    if (!snapshot) return;

    const extracted = await deps.memoryExtractor.extract({
      tenantId: deps.tenant.tenantId,
      conversationId: deps.result.conversationId,
      contactId: deps.result.contactId,
      existingFacts: snapshot.existingFacts,
      history: snapshot.history,
    });
    if (Object.keys(extracted).length === 0) return;

    await withTenant(deps.db, deps.tenant.tenantId, async (tx) => {
      const contacts = new ContactsRepo({ db: tx, tenantId: deps.tenant.tenantId });
      await contacts.mergeAttributes(deps.result.contactId, extracted, deps.now);
    });

    deps.sink?.log?.("debug", "memory facts extracted", {
      tenantId: deps.tenant.tenantId,
      conversationId: deps.result.conversationId,
      keys: Object.keys(extracted),
    });
  } catch (err) {
    deps.sink?.log?.("warn", "memory extractor failed", {
      tenantId: deps.tenant.tenantId,
      conversationId: deps.result.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
