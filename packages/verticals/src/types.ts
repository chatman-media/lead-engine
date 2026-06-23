// Vertical-template — это **данные**, не код. Описывает воронку для конкретной
// бизнес-вертикали (найм, продажа курсов, e-commerce ретеншн и т.д.):
//   - перечень stages funnel'а
//   - анкета (questionnaire fields) если есть intake-step
//   - per-vertical промпт-фрагменты для системного промпта
//   - hook points, которые conversation-engine дёргает на жизненном цикле
//     лида (onLeadStageChange, extractFields, и т.д.)
//
// Конкретные templates живут в apps/vertical-<slug>/ и регистрируются здесь
// через registerTemplate(). Conversation-engine читает их по slug из
// tenant.vertical_template_id.

/**
 * Тип stage'а в воронке.
 *   - "intake" — сбор анкеты от кандидата
 *   - "lead" — рабочий этап (review, qualification, docs, etc.)
 *   - "terminal" — конечный (won, lost, closed) — переходов вперёд нет
 */
export type FunnelStageKind = "intake" | "lead" | "terminal";

export interface FunnelStageDef {
  slug: string;
  kind: FunnelStageKind;
  displayName: string;
  /**
   * Список slug'ов stages, в которые разрешён переход из этого. Машина
   * состояний валидируется conversation-engine'ом при попытке смены
   * lead.stage — попытка перейти в stage не из этого списка = ошибка.
   * Пустой массив для terminal стадий.
   */
  next?: string[];
}

/** Тип значения, которое поле опросника принимает. */
export type QuestionnaireFieldKind =
  | "text"
  | "longText"
  | "number"
  | "date"
  | "enum"
  | "phone"
  | "email"
  | "photo"
  | "video"
  | "yesno";

export interface QuestionnaireField {
  slug: string;
  question: string;
  kind: QuestionnaireFieldKind;
  required: boolean;
  /** Только для kind === 'enum'. */
  options?: readonly string[];
  /** Подсказка для извлечения (для LLM-extractor'а). */
  hint?: string;
}

export interface QuestionnaireSchema {
  /** Slug stage'а, на котором анкета собирается (обычно "intake"). */
  stageSlug: string;
  fields: readonly QuestionnaireField[];
  /** Текст, отправляемый кандидату при начале анкеты. */
  introMessage?: string;
  /** Текст, отправляемый после успешного завершения. */
  completionMessage?: string;
}

/**
 * Hook points — conversation-engine дёргает эти функции на жизненных
 * событиях. Все необязательны. Сигнатуры намеренно объявлены через
 * unknown — vertical-template'у не нужна compile-time зависимость от
 * conversation-engine; HookContext типизируется на стороне consumer'а
 * через generic'и в loadTemplate<TCtx>().
 *
 * Возвращаемые значения: void для side-effect хуков, partial-record
 * для extractFields (ключи — slug'и QuestionnaireField).
 */
export interface VerticalHooks<TCtx = unknown> {
  onLeadStageChange?: (ctx: TCtx, fromStage: string, toStage: string) => Promise<void> | void;
  onPhotoReceived?: (ctx: TCtx, photoClass: string, externalRef: string) => Promise<void> | void;
  extractFields?: (
    ctx: TCtx,
    text: string,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface VerticalStyleSeed {
  displayName: string;
  slug: string;
  /** JSON-сериализованный Style (z.infer<typeof StyleSchema>). */
  configJson: string;
}

export type VerticalKbDocScope =
  | { scopeType: "global" }
  | { scopeType: "funnel" }
  | { scopeType: "stage"; stageSlug: string };

export interface VerticalKbDocSeed {
  title: string;
  body: string;
  topic?: string;
  scope?: VerticalKbDocScope;
}

export interface VerticalTemplate<TCtx = unknown> {
  /** Stable slug, например 'recruitment_uae_v1'. Используется в funnels.vertical_template_id. */
  slug: string;
  displayName: string;
  /** Версия template'а — bump при изменении funnel-машины. */
  version: number;
  funnelStages: readonly FunnelStageDef[];
  questionnaire?: QuestionnaireSchema;
  hooks?: VerticalHooks<TCtx>;
  /** Per-vertical промпт-фрагмент, добавляется к system prompt стиля. */
  systemPromptFragment?: string;
  /**
   * Опциональные пути к seed-документам для KB. Загружаются ingest'ом при
   * первом запуске tenant'а с этой вертикалью. Пути относительны корню
   * приложения template'а (apps/vertical-<slug>/kb/).
   */
  kbSeedFiles?: readonly string[];
  /** Inline seed-стили (sales personas) для установки при install. */
  styles?: readonly VerticalStyleSeed[];
  /** Inline seed-документы для KB при install. */
  kbDocuments?: readonly VerticalKbDocSeed[];
  /**
   * Ключ в SEED_TEMPLATES воронки (admin-funnel). Если задан — install-endpoint
   * сидит воронку из этого шаблона. Если не задан — воронка не сидится.
   */
  funnelSeedKey?: string;
}
