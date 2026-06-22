import { describe, expect, it } from "bun:test";
import { startTypingKeepalive } from "./typing-keepalive.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("startTypingKeepalive", () => {
  it("шлёт «печатает…» сразу (синхронно, до первого интервала)", () => {
    let count = 0;
    const stop = startTypingKeepalive(async () => {
      count++;
    });
    expect(count).toBe(1);
    stop();
  });

  it("переподнимает по интервалу, пока не вызван stop()", async () => {
    let count = 0;
    const stop = startTypingKeepalive(
      async () => {
        count++;
      },
      { intervalMs: 15, maxMs: 1000 },
    );
    await sleep(55);
    expect(count).toBeGreaterThanOrEqual(3); // 1 immediate + ~3 интервала
    const atStop = count;
    stop();
    await sleep(45);
    expect(count).toBe(atStop); // после stop — новых вызовов нет
  });

  it("stop() идемпотентен", () => {
    let count = 0;
    const stop = startTypingKeepalive(
      async () => {
        count++;
      },
      { intervalMs: 10 },
    );
    stop();
    stop();
    expect(count).toBe(1);
  });

  it("ошибки signal() не всплывают и не останавливают переподнятие", async () => {
    let count = 0;
    const stop = startTypingKeepalive(
      async () => {
        count++;
        throw new Error("boom");
      },
      { intervalMs: 15 },
    );
    await sleep(40);
    expect(count).toBeGreaterThanOrEqual(2);
    stop();
  });

  it("maxMs гасит таймер сам, если stop() не вызван", async () => {
    let count = 0;
    startTypingKeepalive(
      async () => {
        count++;
      },
      { intervalMs: 10, maxMs: 25 },
    );
    await sleep(50);
    const afterMax = count;
    await sleep(40);
    expect(count).toBe(afterMax); // после maxMs новых вызовов нет
  });
});
