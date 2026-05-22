// Публичная поверхность @chatman-media/storage после re-design (Этап 1).
//
// Старые тонкие репы (PgUsersRepo, PgConversationsRepo, …) удалены: они
// расходились с production-схемой и не покрывали половины таблиц.
// Репозитории живут в доменных пакетах (`conversation-engine`, `sales`,
// `kb`) и собираются над общей schema, экспортируемой отсюда.

export * as schema from "./schema.ts";
export * from "./schema.ts";
// Integration-test helpers — exposed для других packages/apps что хотят
// reuse setup'а isolated test-БД (createIsolatedDb, applyAllMigrations).
// НЕ для production runtime — admin/dev utility.
export {
  applyAllMigrations,
  createIsolatedDb,
  dropIsolatedDb,
  tryConnectToPg,
} from "./integration-helpers.ts";
