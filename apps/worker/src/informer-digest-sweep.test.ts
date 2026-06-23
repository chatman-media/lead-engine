import type { AdminNotificationRow, Db } from "@chatman-media/conversation-engine";
import { describe, expect, it, spyOn } from "bun:test";
import {
  type InformerDigestSender,
  InformerDigestSweeper,
  isDigestDue,
  renderDigest,
} from "./informer-digest-sweep.ts";

const ep = (h: number, day = 5) => Math.floor(Date.UTC(2026, 5, day, h, 0, 0) / 1000); // июнь

function s(over: Partial<Parameters<typeof isDigestDue>[0]> = {}) {
  return {
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "UTC",
    informerLastDigestAt: null as number | null,
    ...over,
  };
}

describe("isDigestDue (daily)", () => {
  it("off → никогда", () => {
    expect(isDigestDue(s({ informerDigest: "off" }), ep(12))).toBe(false);
  });
  it("час достигнут, ещё не слали сегодня → due", () => {
    expect(isDigestDue(s(), ep(10))).toBe(true);
  });
  it("до digest-часа → not due", () => {
    expect(isDigestDue(s(), ep(8))).toBe(false);
  });
  it("уже слали сегодня → not due", () => {
    expect(isDigestDue(s({ informerLastDigestAt: ep(9) }), ep(12))).toBe(false);
  });
  it("слали вчера → due на следующий день", () => {
    expect(isDigestDue(s({ informerLastDigestAt: ep(9, 4) }), ep(10, 5))).toBe(true);
  });
});

describe("isDigestDue (shift)", () => {
  const sh = (over = {}) => s({ informerDigest: "shift", informerDigestHour: 9, ...over });
  it("первый слот (09) → due", () => {
    expect(isDigestDue(sh(), ep(10))).toBe(true);
  });
  it("второй слот (21) после утреннего → due снова", () => {
    expect(isDigestDue(sh({ informerLastDigestAt: ep(10) }), ep(22))).toBe(true);
  });
  it("тот же слот повторно → not due", () => {
    expect(isDigestDue(sh({ informerLastDigestAt: ep(10) }), ep(12))).toBe(false);
  });
});

describe("renderDigest", () => {
  const row = (over: Partial<AdminNotificationRow>): AdminNotificationRow =>
    ({ topic: "leads", severity: "info", title: "t", body: "", ...over }) as AdminNotificationRow;

  it("группирует по теме и считает", () => {
    const html = renderDigest(
      [row({ topic: "leads" }), row({ topic: "leads" }), row({ topic: "orders" })],
      0,
    );
    expect(html).toContain("накопилось 3");
    expect(html).toContain("🆕 Лиды: 2");
    expect(html).toContain("💱 Заявки: 1");
  });

  it("выносит важное и показывает счётчик эскалаций", () => {
    const html = renderDigest(
      [row({ severity: "critical", title: "Канал упал", topic: "system" })],
      4,
    );
    expect(html).toContain("Важное:");
    expect(html).toContain("Канал упал");
    expect(html).toContain("ждут оператора: <b>4</b>");
  });

  it("экранирует HTML в title/body важного", () => {
    const html = renderDigest(
      [row({ severity: "important", title: '<b>&"x"</b>', body: "a'<i>" })],
      0,
    );
    expect(html).toContain("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
    expect(html).toContain("a&#39;&lt;i&gt;");
  });
});

// ── Sweeper-механика на фейках (без БД и без сети) ──────────────────────────

/** db.select().from().where() → rows; transaction отсутствует → withTenant падает. */
function fakeDbWithTenants(rows: Array<{ id: number }>): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Db;
}

/** db.select() кидает сразу → sweep() reject'ится (error-ветка run-loop'а). */
function fakeDbThrows(err: Error): Db {
  return {
    select: () => {
      throw err;
    },
  } as unknown as Db;
}

describe("InformerDigestSweeper: конструктор sender'а", () => {
  it("botToken задан → sender шлёт sendMessage через Telegram Bot API (HTML)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const sweeper = new InformerDigestSweeper(fakeDbWithTenants([]), {
        intervalMs: 1,
        botToken: "123:abc",
      });
      const sender = (sweeper as unknown as { sender: InformerDigestSender }).sender;
      expect(sender).not.toBeNull();
      await sender.send("4242", "<b>сводка</b>");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/bot123:abc/sendMessage");
    expect(calls[0]!.body.chat_id).toBe("4242");
    expect(calls[0]!.body.text).toBe("<b>сводка</b>");
    expect(calls[0]!.body.parse_mode).toBe("HTML");
    expect(calls[0]!.body.disable_web_page_preview).toBe(true);
  });

  it("botToken пуст → sender = null (digest отключён)", () => {
    const sweeper = new InformerDigestSweeper(fakeDbWithTenants([]), {
      intervalMs: 1,
      botToken: "",
    });
    expect((sweeper as unknown as { sender: InformerDigestSender | null }).sender).toBeNull();
  });
});

describe("InformerDigestSweeper: run/stop/sweep на фейках", () => {
  it("run: sweep-ошибка логируется, abort останавливает loop", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sweeper = new InformerDigestSweeper(fakeDbThrows(new Error("db down")), {
        intervalMs: 1,
        botToken: "",
        sender: null,
      });
      const ac = new AbortController();
      const done = sweeper.run(ac.signal);
      await new Promise((r) => setTimeout(r, 25));
      ac.abort();
      await done;
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[informer-digest] error"))).toBe(
        true,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stop() до run() → loop не стартует (мгновенный return)", async () => {
    const sweeper = new InformerDigestSweeper(fakeDbThrows(new Error("never called")), {
      intervalMs: 1,
      botToken: "",
      sender: null,
    });
    sweeper.stop();
    await sweeper.run(); // без сигнала: ветка `signal?.` тоже покрыта
  });

  it("sweep: ошибка sweepTenant per-tenant ловится, остальные тенанты не страдают", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // fake db без transaction → withTenant внутри sweepTenant кидает per-tenant.
      const sweeper = new InformerDigestSweeper(fakeDbWithTenants([{ id: 1 }, { id: 2 }]), {
        intervalMs: 1,
        botToken: "",
        sender: null,
      });
      await sweeper.sweep(); // не должен кинуть наружу
      const tenantErrors = errSpy.mock.calls.filter((c) =>
        String(c[0]).startsWith("[informer-digest] tenant="),
      );
      expect(tenantErrors).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
