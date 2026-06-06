import { afterEach, describe, expect, it } from "bun:test";
import { loadWorkerConfig } from "./config.ts";

const TOUCHED = [
  "DATABASE_URL",
  "PLATFORM_MASTER_KEY",
  "DISPATCHER_POLL_MS",
  "WORKER_INFORMER_DIGEST_MS",
  "WORKER_OPS_WATCH_MS",
  "PLATFORM_OPERATOR_BOT_TOKEN",
  "PLATFORM_APP_URL",
];
const saved: Record<string, string | undefined> = {};

function setEnv(over: Record<string, string | undefined>) {
  for (const k of TOUCHED) saved[k] = process.env[k];
  for (const k of TOUCHED) delete process.env[k];
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadWorkerConfig", () => {
  it("бросает при отсутствии DATABASE_URL", () => {
    setEnv({ PLATFORM_MASTER_KEY: "k" });
    expect(() => loadWorkerConfig()).toThrow("DATABASE_URL");
  });

  it("бросает при отсутствии PLATFORM_MASTER_KEY", () => {
    setEnv({ DATABASE_URL: "db" });
    expect(() => loadWorkerConfig()).toThrow("PLATFORM_MASTER_KEY");
  });

  it("дефолты, когда необязательные env не заданы", () => {
    setEnv({ DATABASE_URL: "db", PLATFORM_MASTER_KEY: "k" });
    const c = loadWorkerConfig();
    expect(c.databaseUrl).toBe("db");
    expect(c.dispatcherPollMs).toBe(1000);
    expect(c.opsWatchMs).toBe(300000);
    expect(c.informerDigestMs).toBe(900000);
    expect(c.operatorBotToken).toBe("");
    expect(c.appUrl).toContain("leadengine");
  });

  it("override env-переменными", () => {
    setEnv({
      DATABASE_URL: "db",
      PLATFORM_MASTER_KEY: "k",
      DISPATCHER_POLL_MS: "250",
      WORKER_INFORMER_DIGEST_MS: "60000",
      PLATFORM_OPERATOR_BOT_TOKEN: "tok",
      PLATFORM_APP_URL: "https://x.io",
    });
    const c = loadWorkerConfig();
    expect(c.dispatcherPollMs).toBe(250);
    expect(c.informerDigestMs).toBe(60000);
    expect(c.operatorBotToken).toBe("tok");
    expect(c.appUrl).toBe("https://x.io");
  });
});
