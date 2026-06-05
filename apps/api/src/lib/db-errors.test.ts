import { describe, expect, it } from "bun:test";
import { isUniqueViolation } from "./db-errors.ts";

/**
 * Воспроизводит обёртку drizzle-orm: верхний `DrizzleQueryError` без кода и
 * без «unique»-текста, оригинальная Postgres-ошибка — в `.cause`.
 */
class FakeDrizzleQueryError extends Error {
  cause: unknown;
  constructor(cause: unknown) {
    super('Failed query: insert into "tenants" (...) values (...) returning ...');
    this.cause = cause;
  }
}

function pgUniqueError(): { code: string; message: string } {
  return {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "tenants_slug_unique"',
  };
}

describe("isUniqueViolation", () => {
  it("ловит unique-violation сквозь обёртку DrizzleQueryError (по .cause.code)", () => {
    const err = new FakeDrizzleQueryError(pgUniqueError());
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("ловит сырую Postgres-ошибку с code 23505", () => {
    expect(isUniqueViolation(pgUniqueError())).toBe(true);
  });

  it("ловит по тексту сообщения (fallback без code)", () => {
    expect(isUniqueViolation(new Error("duplicate key value ..."))).toBe(true);
    expect(isUniqueViolation(new Error("violates unique constraint"))).toBe(true);
  });

  it("НЕ ловит другие ошибки БД (напр. not-null violation 23502)", () => {
    const err = new FakeDrizzleQueryError({
      code: "23502",
      message: 'null value in column "x" violates not-null constraint',
    });
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("безопасен на null / undefined / строках", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
  });

  it("не зацикливается на циклической цепочке .cause", () => {
    const a: { cause?: unknown; code?: string } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b; // цикл a → b → a
    expect(isUniqueViolation(a)).toBe(false);
  });
});
