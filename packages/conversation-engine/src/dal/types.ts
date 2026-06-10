import type { schema } from "@chatman-media/storage";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Алиас Drizzle БД-инстанса со всей schema. apps/worker / apps/api инициируют
 * drizzle(postgres(url), { schema }) на boot и прокидывают сюда. DAL-слой
 * conversation-engine не знает откуда драйвер взялся.
 *
 * NB: `schema` — это именно namespaced re-export из storage/index.ts
 * (`export * as schema from "./schema.ts"`), а не всё содержимое модуля.
 * Использование `import type * as schema` ловит лишние exports
 * (applyAllMigrations и т.п.) и расходится с тем, что отдаёт `drizzle(_, { schema })`.
 */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Конструктор репозиториев — pattern для всех DAL-классов. Принимает
 * tenant_id чтобы каждый метод репо мог автоматически добавлять
 * WHERE tenant_id = ? без явного prop'а в API.
 *
 * NOTE: tenant_id фильтрация в каждом методе — это "soft multi-tenancy"
 * пока в БД не добавлены RLS-policies. План re-design явно откладывает
 * RLS до этапа 9+. Защита — ESLint-правило на raw SQL в репозиториях.
 */
export interface RepoCtx {
	db: Db;
	tenantId: number;
}
