import type { Database } from "bun:sqlite";

import {
  createConversationDetailHandler,
  createCreateExperimentHandler,
  createDeleteConversationHandler,
  createEditStyleHandler,
  createExperimentFunnelHandler,
  createGetStyleHandler,
  createListConversationsHandler,
  createListExperimentsHandler,
  createListStylesHandler,
  createListUsersHandler,
  createReleaseHandler,
  createReplyHandler,
  createSetExperimentStatusHandler,
  createStylePlaygroundHandler,
  createTakeHandler,
} from "./admin/api.ts";
import {
  createLoginHandler,
  createLogoutHandler,
  createMeHandler,
} from "./admin/auth.ts";
import { AdminBus } from "./admin/bus.ts";
import {
  createQuestionnaireGet,
  createQuestionnairePost,
} from "./questionnaire/routes.ts";
import { html, Router } from "./router.ts";
import { TelegramClient } from "./telegram/client.ts";
import { createWebhookHandler, type RagDeps } from "./telegram/webhook.ts";
import { mountTestHooks } from "./test-hooks.ts";

export interface AppDeps {
  db: Database;
  telegram: TelegramClient;
  webhookSecret: string;
  rag?: RagDeps;
  /** Optional pub/sub for the websocket layer. */
  bus?: AdminBus;
  /** Mounts /__test/* routes for Playwright; never enable in production. */
  enableTestHooks?: boolean;
  /** When true, the Telegram webhook awaits the full RAG/sendMessage
   *  pipeline before responding. Tests use this for deterministic
   *  assertions; production keeps it false (fire-and-forget) so we
   *  ack Bot API in <100ms and avoid retry storms. */
  awaitWebhookProcessing?: boolean;
}

export function createRouter(deps: AppDeps): Router {
  const router = new Router();

  router.get("/health", () =>
    html(
      `<!doctype html><html><head><meta charset="utf-8"><title>tg-chatbot health</title></head><body><main id="health">ok</main></body></html>`,
    ),
  );

  router.get("/", () =>
    html(
      `<!doctype html><html><head><meta charset="utf-8"><title>tg-chatbot</title></head><body><h1>tg-chatbot</h1></body></html>`,
    ),
  );

  router.post(
    "/telegram/:secret",
    createWebhookHandler({
      db: deps.db,
      telegram: deps.telegram,
      webhookSecret: deps.webhookSecret,
      rag: deps.rag,
      awaitProcessing: deps.awaitWebhookProcessing,
      onEvent: (event) => {
        if (!deps.bus) return;
        switch (event.type) {
          case "user-message-persisted":
          case "assistant-replied":
            deps.bus.publish({
              type: "message:new",
              conversationId: event.conversationId,
              tgUserId: event.tgUserId,
            });
            return;
          case "conversation-mode-changed":
            deps.bus.publish({
              type: "conversation:updated",
              conversationId: event.conversationId,
            });
            return;
        }
      },
    }),
  );

  router.get("/q/:token", createQuestionnaireGet(deps.db));
  router.post("/q/:token", createQuestionnairePost(deps.db));

  router.post("/admin/api/login", createLoginHandler(deps.db));
  router.post("/admin/api/logout", createLogoutHandler(deps.db));
  router.get("/admin/api/me", createMeHandler(deps.db));

  const apiDeps = {
    db: deps.db,
    telegram: deps.telegram,
    // Thread the LLM clients through so the style playground endpoint can
    // run dry-run completions. Other admin endpoints don't need this; the
    // playground returns 503 when rag is undefined.
    ...(deps.rag
      ? {
          rag: {
            chat: deps.rag.chat,
            embedder: deps.rag.embedder,
            ...(deps.rag.topK !== undefined ? { topK: deps.rag.topK } : {}),
            ...(deps.rag.maxDistance !== undefined
              ? { maxDistance: deps.rag.maxDistance }
              : {}),
          },
        }
      : {}),
    onConversationChanged: (conversationId: number) => {
      deps.bus?.publish({ type: "conversation:updated", conversationId });
    },
    onMessageSent: ({
      conversationId,
      tgUserId,
    }: {
      conversationId: number;
      tgUserId: number;
    }) => {
      deps.bus?.publish({ type: "message:new", conversationId, tgUserId });
    },
  };
  router.get("/admin/api/users", createListUsersHandler(apiDeps));
  router.get(
    "/admin/api/conversations",
    createListConversationsHandler(apiDeps),
  );
  router.get(
    "/admin/api/conversations/:id",
    createConversationDetailHandler(apiDeps),
  );
  router.post(
    "/admin/api/conversations/:id/take",
    createTakeHandler(apiDeps),
  );
  router.post(
    "/admin/api/conversations/:id/release",
    createReleaseHandler(apiDeps),
  );
  router.post(
    "/admin/api/conversations/:id/reply",
    createReplyHandler(apiDeps),
  );
  router.delete(
    "/admin/api/conversations/:id",
    createDeleteConversationHandler(apiDeps),
  );

  // Sales-style engine endpoints (Phase 2b).
  router.get("/admin/api/styles", createListStylesHandler(apiDeps));
  router.get("/admin/api/styles/:id", createGetStyleHandler(apiDeps));
  router.patch("/admin/api/styles/:id", createEditStyleHandler(apiDeps));
  router.post(
    "/admin/api/styles/:id/playground",
    createStylePlaygroundHandler(apiDeps),
  );
  router.get("/admin/api/experiments", createListExperimentsHandler(apiDeps));
  router.post(
    "/admin/api/experiments",
    createCreateExperimentHandler(apiDeps),
  );
  router.patch(
    "/admin/api/experiments/:id",
    createSetExperimentStatusHandler(apiDeps),
  );
  router.get(
    "/admin/api/experiments/:id/funnel",
    createExperimentFunnelHandler(apiDeps),
  );

  if (deps.enableTestHooks) {
    mountTestHooks(router, deps.db);
  }

  return router;
}
