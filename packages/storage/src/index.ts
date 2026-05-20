// Публичная поверхность @chatman-media/storage после re-design (Этап 1).
//
// Старые тонкие репы (PgUsersRepo, PgConversationsRepo, …) удалены: они
// расходились с прод-схемой sales-guru и не покрывали половины таблиц.
// Репозитории живут в доменных пакетах (`conversation-engine`, `sales`,
// `kb`) и собираются над общей schema, экспортируемой отсюда.

export * as schema from "./schema.ts";
export * from "./schema.ts";
