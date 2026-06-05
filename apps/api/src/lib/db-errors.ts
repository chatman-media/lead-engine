/**
 * Хелперы для классификации низкоуровневых ошибок БД.
 */

/**
 * Postgres SQLSTATE для нарушения UNIQUE-constraint.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Надёжно определяет, является ли ошибка нарушением UNIQUE-constraint —
 * сквозь обёртки drizzle.
 *
 * drizzle-orm (>=0.45) оборачивает любую упавшую query в `DrizzleQueryError`,
 * у которого собственный `.message` — это лишь «Failed query: …» (без SQLSTATE
 * и без текста «duplicate key value violates unique constraint»). Оригинальная
 * `postgres`-ошибка (`PostgresError` с `.code === "23505"`) лежит в `.cause`.
 * Поэтому наивная проверка `err.message.includes("unique")` теперь
 * промахивается и отдаёт 500 вместо 409. Идём по всей цепочке `.cause` и
 * матчим либо SQLSTATE-код (надёжно), либо текст сообщения (fallback).
 */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === PG_UNIQUE_VIOLATION) return true;
    const msg = typeof e.message === "string" ? e.message : "";
    if (msg.includes("unique") || msg.includes("duplicate")) return true;
    cur = e.cause;
  }
  return false;
}
