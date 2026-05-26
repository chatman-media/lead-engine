import type { TgUpdate } from "@chatman-media/channel-telegram";
import type { OperatorBotHandler } from "@chatman-media/conversation-engine";
import { Hono } from "hono";

/**
 * Webhook для платформенного бота уведомлений операторов.
 * В отличие от ботов тенантов, этот бот один на всю платформу.
 */
export function makeOperatorBotWebhookRoutes(opts: {
  handler: OperatorBotHandler;
  webhookSecret: string;
}): Hono {
  const app = new Hono();

  app.post("/webhook/operator-bot", async (c) => {
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (got !== opts.webhookSecret) {
      return c.json({ error: "invalid secret" }, 401);
    }

    let update: TgUpdate;
    try {
      update = (await c.req.json()) as TgUpdate;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    try {
      await opts.handler.handleUpdate(update);
    } catch (err) {
      console.error("[operator-bot-webhook] error", err);
    }

    return c.json({ ok: true });
  });

  return app;
}
