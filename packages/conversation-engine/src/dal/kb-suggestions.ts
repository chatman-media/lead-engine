import type { KbScope } from "@chatman-media/kb";
import { kbSuggestions } from "@chatman-media/storage";
import { withTenant } from "../with-tenant.ts";
import type { RepoCtx } from "./types.ts";

/**
 * Repo для логирования вопросов, на которые бот не смог найти ответ в KB.
 *
 * Операторы видят эти записи в admin-UI и могут:
 *  - Принять (ingested) → написать документ и загрузить в KB.
 *  - Отклонить (rejected) → пометить как нерелевантный вопрос.
 *
 * Используется в RagReplyStrategy когда answerWithRag возвращает NO_CONTEXT_MARKER.
 */
export class KbSuggestionsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  /**
   * Записать незакрытый вопрос.
   * Fire-and-forget: ошибки залоггированы, но не пробрасываются — чтобы не
   * блокировать основной pipeline если insert упадёт.
   */
  async log(opts: {
    questionText: string;
    sourceConversationId?: number;
    sourceMessageId?: number;
    scope?: KbScope | null;
    nowEpoch: number;
  }): Promise<void> {
    const scope = opts.scope ?? { scopeType: "global" as const };
    await withTenant(this.ctx.db, this.ctx.tenantId, async (tx) => {
      await tx.insert(kbSuggestions).values({
        tenantId: this.ctx.tenantId,
        questionText: opts.questionText,
        status: "pending",
        scopeType: scope.scopeType,
        funnelId: scope.scopeType === "global" ? null : (scope.funnelId ?? null),
        stageSlug: scope.scopeType === "stage" ? (scope.stageSlug ?? null) : null,
        ...(opts.sourceConversationId !== undefined
          ? { sourceConversationId: opts.sourceConversationId }
          : {}),
        ...(opts.sourceMessageId !== undefined ? { sourceMessageId: opts.sourceMessageId } : {}),
        createdAt: opts.nowEpoch,
        updatedAt: opts.nowEpoch,
      });
    });
  }
}
