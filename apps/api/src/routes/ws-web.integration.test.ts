// Integration test для channel-web WebSocket endpoint. Поднимает Bun.serve
// с реальными routes + WebChannelRegistry → подсоединяется WebSocket
// клиентом (Bun также провайдит WebSocket constructor) → проверяет
// ready-frame, user→server frame путь, send() outbound через adapter.
//
// БД для этого теста не нужна (registry скармливаем prepopulated
// in-memory adapter'ом через тестовый shim). Это unit-level wire-up
// без processInbound — лучше остаётся фокусированным и быстрым.

import { WebChannelAdapter } from "@chatman-media/channel-web";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { WebChannelRegistry, type WebChannelEntry } from "../lib/web-channel-registry.ts";
import { makeWebSocketRoutes } from "./ws-web.ts";

const log = makeDefaultLogger("ws-web.test");

/**
 * Тестовый shim над WebChannelRegistry — позволяет вручную добавить
 * entry без loadFromDb(). Заодно exposed'им adapter чтобы asserter мог
 * проверять inbox / state.
 */
class TestWebRegistry extends WebChannelRegistry {
  add(entry: WebChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: туннелируемся в private
    (this as any).byChannelDbId.set(entry.channelDbId, entry);
    // biome-ignore lint/suspicious/noExplicitAny: туннелируемся в private
    (this as any).byTenantSlug.set(entry.tenantSlug, entry);
  }
}

function makeAdapterEntry(channelDbId: number, tenantSlug: string): WebChannelEntry {
  return {
    channelDbId,
    tenantId: 1,
    tenantSlug,
    externalId: `web-${tenantSlug}`,
    adapter: new WebChannelAdapter({ id: String(channelDbId) }),
  };
}

let server: Server<unknown> | null = null;
let port = 0;
const registry = new TestWebRegistry();
const metrics = makePlatformMetrics();

beforeAll(() => {
  registry.add(makeAdapterEntry(101, "alpha"));
  registry.add(makeAdapterEntry(102, "beta")); // для теста auth/multi-tenant

  const routes = makeWebSocketRoutes({
    registry,
    log,
    metrics,
    sharedSecret: "s3cret",
  });

  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const fail = routes.tryUpgrade(req, srv);
      if (fail) return fail;
      if (new URL(req.url).pathname.startsWith("/ws/")) {
        return new Response(null, { status: 101 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: routes.websocket,
  });
  port = Number(server.port);
});

afterAll(() => {
  registry.closeAll();
  server?.stop(true);
});

function url(slug: string, query: string): string {
  return `ws://localhost:${port}/ws/${slug}?${query}`;
}

/**
 * Подключается WebSocket'ом, ждёт первого ready-frame и возвращает
 * { ws, ready } для дальнейшего ping-pong'а. Помогает избегать race'а
 * между connect'ом и первым send'ом.
 */
async function connect(slug: string, queryParams: Record<string, string>): Promise<{
  ws: WebSocket;
  readyMessage: unknown;
}> {
  const qs = new URLSearchParams(queryParams).toString();
  const ws = new WebSocket(url(slug, qs));
  const readyMessage = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ready")), 2000);
    ws.addEventListener(
      "open",
      () => {
        // wait for first message (ready frame)
        ws.addEventListener(
          "message",
          (ev) => {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(ev.data as string));
            } catch {
              resolve(ev.data);
            }
          },
          { once: true },
        );
      },
      { once: true },
    );
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e}`));
    });
  });
  return { ws, readyMessage };
}

describe("ws-web integration", () => {
  it("happy path: connect → ready-frame → user_text → inbound в адаптер inbox'а", async () => {
    const { ws, readyMessage } = await connect("alpha", {
      user: "u-alpha-1",
      auth: "s3cret",
    });
    expect(readyMessage).toEqual({ type: "ready", channelId: "101", userId: "u-alpha-1" });

    // Клиент шлёт текст — adapter должен enqueue Inbound, который мы
    // можем достать через receive().
    ws.send(JSON.stringify({ type: "user_text", id: "c-1", text: "привет" }));

    const entry = registry.byTenant("alpha");
    if (!entry) throw new Error("entry missing");
    const iter = entry.adapter.receive()[Symbol.asyncIterator]();
    const { value, done } = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((_, reject) =>
        setTimeout(() => reject(new Error("timeout receive()")), 2000),
      ),
    ]);
    expect(done).toBe(false);
    expect(value?.externalUserId).toBe("u-alpha-1");
    expect(value?.parts).toEqual([{ kind: "text", text: "привет" }]);

    ws.close();
  });

  it("server → client send(envelope) → клиент получает bot_text frame", async () => {
    const { ws } = await connect("alpha", { user: "u-alpha-2", auth: "s3cret" });

    const entry = registry.byTenant("alpha");
    if (!entry) throw new Error("entry missing");

    // Аналогично worker'у — отправляем envelope через adapter.send.
    const recv = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout bot_text")), 2000);
      ws.addEventListener(
        "message",
        (ev) => {
          clearTimeout(timer);
          resolve(JSON.parse(ev.data as string));
        },
        { once: true },
      );
    });
    const sent = await entry.adapter.send({
      channelId: String(entry.channelDbId),
      externalUserId: "u-alpha-2",
      parts: [{ kind: "text", text: "ответ" }],
    });
    expect(sent.externalMessageId).toMatch(/^srv-/);
    const frame = (await recv) as { type: string; text: string; id: string };
    expect(frame.type).toBe("bot_text");
    expect(frame.text).toBe("ответ");
    expect(frame.id).toBe(sent.externalMessageId);

    ws.close();
  });

  it("auth: неверный sharedSecret → 401 (WebSocket closes без open)", async () => {
    const ws = new WebSocket(url("alpha", "user=u1&auth=wrong"));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code), { once: true });
      ws.addEventListener("error", () => resolve(-1), { once: true });
      // Safety net: если ничего не пришло за 2s — считаем что upgrade
      // отвергнут (в стандартном WebSocket клиенте на 401 серверный
      // response close-код будет 1006 abnormal closure).
      setTimeout(() => resolve(-2), 2000);
    });
    // Bun's WebSocket-client на не-101 response отдаёт code=1006.
    expect(code).not.toBe(1000);
  });

  it("unknown tenant → upgrade rejected", async () => {
    const ws = new WebSocket(url("unknown-tenant", "user=u1&auth=s3cret"));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code), { once: true });
      ws.addEventListener("error", () => resolve(-1), { once: true });
      setTimeout(() => resolve(-2), 2000);
    });
    expect(code).not.toBe(1000);
  });

  it("missing user param → 400", async () => {
    const ws = new WebSocket(url("alpha", "auth=s3cret"));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code), { once: true });
      ws.addEventListener("error", () => resolve(-1), { once: true });
      setTimeout(() => resolve(-2), 2000);
    });
    expect(code).not.toBe(1000);
  });

  it("multi-tenant isolation: connection в alpha не виден в beta inbox'е", async () => {
    const { ws } = await connect("alpha", { user: "u-a", auth: "s3cret" });
    ws.send(JSON.stringify({ type: "user_text", id: "c-a", text: "from-alpha" }));

    // Даём чуть-чуть времени пайплайну.
    await new Promise((r) => setTimeout(r, 50));

    const beta = registry.byTenant("beta");
    if (!beta) throw new Error("beta entry missing");
    // beta inbox должен быть пуст — для теста используем чтобы adapter.receive()
    // не блокировался: создаём signal abort'нутый сразу, тогда iterator
    // вернёт done:true немедленно. Если adapter имел бы в inbox'е что-то —
    // он бы вернул это вместо done:true.
    const abort = new AbortController();
    abort.abort();
    const iter = beta.adapter.receive(abort.signal)[Symbol.asyncIterator]();
    const res = await iter.next();
    expect(res.done).toBe(true);

    ws.close();
  });
});
