import { kbSuggestions } from "@chatman-media/storage";
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
    nowEpoch: number;
  }): Promise<void> {
    await this.ctx.db.insert(kbSuggestions).values({
      tenantId: this.ctx.tenantId,
      questionText: opts.questionText,
      status: "pending",
      ...(opts.sourceConversationId !== undefined
        ? { sourceConversationId: opts.sourceConversationId }
        : {}),
      ...(opts.sourceMessageId !== undefined ? { sourceMessageId: opts.sourceMessageId } : {}),
      createdAt: opts.nowEpoch,
      updatedAt: opts.nowEpoch,
    });
  }
}
