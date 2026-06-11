import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { adminEventBus } from "../lib/admin-event-bus.ts";

/**
 * GET /api/admin/events
 *
 * Server-Sent Events stream for real-time admin notifications.
 * Auth: same requireAuth middleware as other /api/admin/* routes.
 *
 * Event types:
 *   new_message      — inbound message persisted in a conversation
 *   stage_changed    — lead moved to a different stage
 *   conversation_mode — conversation switched between ai/human mode
 *   admin_notification — owner/operator informer notification persisted in admin_notifications
 *
 * Client reconnects automatically (native SSE behaviour).
 * Server sends a ping every 25s to keep the connection alive through proxies.
 */
export function makeAdminEventsRoutes(): Hono {
  const app = new Hono();

  app.get("/api/admin/events", (c) => {
    const tenantId = c.var.tenantId as number;

    return streamSSE(c, async (stream) => {
      const unsub = adminEventBus.subscribe(tenantId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      });

      const ping = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 15_000);

      await stream.onAbort(() => {
        unsub();
        clearInterval(ping);
      });

      // Hold the stream open until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });

  return app;
}
