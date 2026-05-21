import type { IWebSocket } from "@chatman-media/channel-web";
import type { JsonLogger, PlatformMetrics } from "@chatman-media/observability";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { WebChannelRegistry } from "../lib/web-channel-registry.ts";

/**
 * Per-connection context, прикреплённый Bun'ом к каждому ServerWebSocket.
 * Хранит то, что мы зарезолвили на upgrade, чтобы message-handler не
 * лез снова в registry/auth.
 */
interface WsContext {
  tenantSlug: string;
  channelDbId: number;
  externalUserId: string;
}

/**
 * Bun's `ServerWebSocket` имеет более широкий API (subscribe, publish,
 * binaryType), а `IWebSocket` из channel-web — minimal contract.
 * Адаптируем: проксируем send/close, читаем readyState.
 *
 * Bun docs: readyState is 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED —
 * совпадает с web-standard и с WebChannelAdapter's WS_OPEN=1.
 */
function bunWsToIWebSocket(ws: ServerWebSocket<WsContext>): IWebSocket {
  return {
    send(data: string): void {
      ws.send(data);
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
    get readyState(): number {
      return ws.readyState;
    },
  };
}

export interface WsAuthOpts {
  /**
   * Опциональный shared-secret для pilot-stage. Клиент шлёт `?auth=X`
   * в query, мы сравниваем с этим значением. Пусто = auth выключен
   * (любой может подключиться от имени любого externalUserId — годится
   * для dev/staging, НЕ для prod).
   *
   * Production-grade auth — JWT с tenant_id + contact_id в claim'ах —
   * следующая итерация, после того как apps/admin-ui начнёт issu'ить
   * tokens для embedded-widget'а.
   */
  sharedSecret?: string;
}

export interface MakeWebSocketRoutesOpts extends WsAuthOpts {
  registry: WebChannelRegistry;
  log: JsonLogger;
  metrics?: PlatformMetrics;
  /** Префикс URL pathname'а, по которому accept'ится upgrade. Default: "/ws/". */
  pathPrefix?: string;
}

export interface WebSocketRoutes {
  /** Bun.serve({ websocket }) handler. */
  websocket: WebSocketHandler<WsContext>;
  /**
   * Попытаться upgrade'нуть request в WebSocket-connection. Возвращает
   * Response (если 401/404), или undefined если upgrade успешен (Bun
   * сам отвечает 101 Switching Protocols).
   */
  tryUpgrade(req: Request, server: Server<WsContext>): Response | undefined;
}

/**
 * WebSocket-роуты для channel-web. URL: `/ws/:tenantSlug?user=...&auth=...`.
 *
 * Flow:
 *   1. tryUpgrade парсит pathname → tenantSlug, query → externalUserId / auth.
 *   2. Резолвит web-канал из registry. 404 если нет или tenant unknown.
 *   3. Валидирует auth (если sharedSecret задан).
 *   4. `server.upgrade(req, { data: WsContext })` — Bun ответит 101.
 *   5. В `open` handler'е дёргаем adapter.acceptConnection — adapter шлёт
 *      ready-frame.
 *   6. В `message` handler'е — adapter.onClientFrame — pipeline'у через
 *      receive()-loop.
 *   7. В `close` handler'е — adapter.onDisconnect.
 */
export function makeWebSocketRoutes(opts: MakeWebSocketRoutesOpts): WebSocketRoutes {
  const prefix = opts.pathPrefix ?? "/ws/";

  const tryUpgrade = (req: Request, server: Server<WsContext>): Response | undefined => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return undefined;

    const tenantSlug = url.pathname.slice(prefix.length).split("/")[0] ?? "";
    if (tenantSlug.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "400" });
      return new Response("missing tenant slug", { status: 400 });
    }

    const externalUserId = url.searchParams.get("user")?.trim() ?? "";
    if (externalUserId.length === 0 || externalUserId.length > 128) {
      opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "400" });
      return new Response("invalid user param", { status: 400 });
    }

    if (opts.sharedSecret && opts.sharedSecret.length > 0) {
      const got = url.searchParams.get("auth") ?? "";
      if (got !== opts.sharedSecret) {
        opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "401" });
        return new Response("invalid auth", { status: 401 });
      }
    }

    const entry = opts.registry.byTenant(tenantSlug);
    if (!entry) {
      opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "404" });
      return new Response("no active web channel for tenant", { status: 404 });
    }

    const data: WsContext = {
      tenantSlug,
      channelDbId: entry.channelDbId,
      externalUserId,
    };
    const upgraded = server.upgrade(req, { data });
    if (!upgraded) {
      opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "426" });
      return new Response("websocket upgrade required", { status: 426 });
    }
    return undefined;
  };

  const websocket: WebSocketHandler<WsContext> = {
    open(ws: ServerWebSocket<WsContext>): void {
      const entry = opts.registry.byChannelId(ws.data.channelDbId);
      if (!entry) {
        // Канал был удалён между upgrade'ом и open'ом — exceedingly rare.
        ws.close(1011, "channel disappeared");
        return;
      }
      entry.adapter.acceptConnection(bunWsToIWebSocket(ws), ws.data.externalUserId);
      opts.metrics?.webhookRequests.inc(1, { channel: "web", status: "200" });
    },
    message(ws: ServerWebSocket<WsContext>, raw: string | Buffer): void {
      const entry = opts.registry.byChannelId(ws.data.channelDbId);
      if (!entry) return;
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        entry.adapter.onClientFrame(ws.data.externalUserId, text);
      } catch (err) {
        opts.log.error("web ws onClientFrame failed", {
          tenantSlug: ws.data.tenantSlug,
          externalUserId: ws.data.externalUserId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    },
    close(ws: ServerWebSocket<WsContext>): void {
      const entry = opts.registry.byChannelId(ws.data.channelDbId);
      entry?.adapter.onDisconnect(ws.data.externalUserId);
    },
  };

  return { websocket, tryUpgrade };
}
