/**
 * Unit-тесты жизненного цикла ShadowEvalJobRunner (start/stop/wake).
 * Сам пайплайн обработки очереди покрыт integration-тестом
 * routes/admin-quality.integration.test.ts — здесь только таймер и error-path
 * через фейковый db, у которого первый же select падает.
 */

import { describe, expect, it } from "bun:test";
import { ShadowEvalJobRunner } from "./shadow-eval-job-runner.ts";

type RunnerOpts = ConstructorParameters<typeof ShadowEvalJobRunner>[0];

function makeRunner() {
  const warns: Array<{ message: string; ctx?: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.reject(new Error("db down")),
      }),
    }),
  };
  const runner = new ShadowEvalJobRunner({
    db,
    pollMs: 60_000,
    log: {
      warn: (message: string, ctx?: Record<string, unknown>) => warns.push({ message, ctx }),
    },
  } as unknown as RunnerOpts);
  return { runner, warns };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ShadowEvalJobRunner lifecycle", () => {
  it("start() ставит таймер и сразу будит runner; ошибка тика уходит в log.warn", async () => {
    const { runner, warns } = makeRunner();
    try {
      runner.start();
      await tick();
      expect(warns).toHaveLength(1);
      expect(warns[0]?.message).toBe("shadow-eval queue tick failed");
      expect(warns[0]?.ctx).toMatchObject({ err: "db down" });
    } finally {
      runner.stop();
    }
  });

  it("повторный start() при живом таймере — no-op (без второго wake)", async () => {
    const { runner, warns } = makeRunner();
    try {
      runner.start();
      runner.start();
      await tick();
      expect(warns).toHaveLength(1);
    } finally {
      runner.stop();
    }
  });

  it("после stop() wake() не запускает runOnce", async () => {
    const { runner, warns } = makeRunner();
    runner.start();
    await tick();
    runner.stop();
    runner.wake();
    await tick();
    expect(warns).toHaveLength(1);
  });

  it("start() после stop() перезапускает цикл", async () => {
    const { runner, warns } = makeRunner();
    runner.start();
    await tick();
    runner.stop();
    runner.start();
    await tick();
    runner.stop();
    expect(warns).toHaveLength(2);
  });
});
