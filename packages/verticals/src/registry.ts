import type { VerticalTemplate } from "./types.ts";

/**
 * In-memory реестр vertical templates. apps/vertical-<slug>/ при импорте
 * вызывает registerTemplate(template) и template становится доступен
 * через loadTemplate(slug).
 *
 * Не singleton'ом, а явным контейнером: один процесс может держать
 * несколько реестров (для тестов). По умолчанию глобально доступен
 * defaultRegistry.
 */
export class VerticalRegistry {
  private readonly bySlug = new Map<string, VerticalTemplate<unknown>>();

  register<TCtx>(template: VerticalTemplate<TCtx>): void {
    const existing = this.bySlug.get(template.slug);
    if (existing && existing.version >= template.version) {
      throw new Error(
        `vertical-registry: ${template.slug} already registered at version ${existing.version} ` +
          `(attempted to register version ${template.version}); skipping`,
      );
    }
    this.bySlug.set(template.slug, template as VerticalTemplate<unknown>);
  }

  load<TCtx>(slug: string): VerticalTemplate<TCtx> {
    const t = this.bySlug.get(slug);
    if (!t) {
      const available = [...this.bySlug.keys()].sort();
      throw new Error(
        `vertical-registry: template "${slug}" not registered. Available: [${available.join(", ")}]`,
      );
    }
    return t as VerticalTemplate<TCtx>;
  }

  /** Опциональный lookup — возвращает undefined вместо throw. */
  tryLoad<TCtx>(slug: string): VerticalTemplate<TCtx> | undefined {
    return this.bySlug.get(slug) as VerticalTemplate<TCtx> | undefined;
  }

  /** Список всех зарегистрированных slug'ов — для admin-инспекции. */
  list(): string[] {
    return [...this.bySlug.keys()].sort();
  }

  /** Снять регистрацию (для тестов). */
  clear(): void {
    this.bySlug.clear();
  }
}

/**
 * Глобальный реестр по умолчанию. apps/vertical-<slug>/index.ts регистрирует
 * себя сюда side-effect import'ом, conversation-engine читает отсюда.
 */
export const defaultRegistry = new VerticalRegistry();
