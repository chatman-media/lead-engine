import { TelegramApiError, TelegramClient } from "@chatman-media/channel-telegram";
import {
  type Db,
  getDecryptedSecret,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { ChatClient } from "@chatman-media/llm-router";
import {
  channels,
  llmProviderConfigs,
  tenantSecrets,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Health-check endpoint для tenant'а. Запускается из admin-UI кнопкой
 * "Запустить проверку". Возвращает per-component статус — pass / warn /
 * fail с latency и optional error message.
 *
 * Checks:
 *   1. channel.telegram — bot token валиден (Telegram getMe не throw'ит)
 *   2. llm.chat — provider config есть + apiKey decryptable; если ?live=1
 *      делает реальный ChatClient.complete("hi", numPredict:1) ping
 *   3. llm.embed — то же для embed-purpose
 *   4. kb — есть хотя бы один document
 *
 * ?live=1 — включает live LLM-вызов (стоит ~1 токен). По умолчанию off.
 */
export interface AdminDiagnosticsRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /**
   * Optional: если передан, `/api/admin/diagnostics?live=1` сделает
   * реальный ChatClient.complete() ping для проверки LLM connectivity.
   * Стоит ~1 токен — не вызывается по умолчанию.
   */
  resolveChat?: (tenantId: number) => ChatClient;
  /** Custom fetch для тестов (intercept'ит Telegram getMe). */
  fetchImpl?: typeof fetch;
}

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  latencyMs?: number;
  message?: string;
}

export function makeAdminDiagnosticsRoutes(
  opts: AdminDiagnosticsRoutesOpts,
): Hono {
  const app = new Hono();

  app.get("/api/admin/diagnostics", async (c) => {
    const tenantId = c.var.tenantId;
    const livePing = c.req.query("live") === "1";
    const checks: CheckResult[] = [];

    await withTenant(opts.db, tenantId, async (tx) => {
      // 1. Telegram channel — есть ли активный + token валиден.
      const tgStart = performance.now();
      const [tgChannel] = await tx
        .select({
          id: channels.id,
          externalId: channels.externalId,
          credentialsRef: channels.credentialsRef,
        })
        .from(channels)
        .where(
          and(
            eq(channels.tenantId, tenantId),
            eq(channels.kind, "telegram_bot"),
            eq(channels.status, "active"),
          ),
        )
        .limit(1);
      if (!tgChannel) {
        checks.push({
          name: "channel.telegram",
          status: "fail",
          message: "Нет активного Telegram-канала",
        });
      } else if (!tgChannel.credentialsRef) {
        checks.push({
          name: "channel.telegram",
          status: "fail",
          message: "Канал есть, но credentials_ref пустой — token не сохранён",
        });
      } else {
        let token: string | null = null;
        try {
          token = await getDecryptedSecret({
            db: tx,
            tenantId,
            key: tgChannel.credentialsRef,
            masterKeyHex: opts.masterKeyHex,
          });
        } catch (err) {
          checks.push({
            name: "channel.telegram",
            status: "fail",
            message: `Decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
            latencyMs: Math.round(performance.now() - tgStart),
          });
        }
        if (token) {
          // Validate via getMe.
          const client = new TelegramClient({
            token,
            ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
          });
          try {
            const me = await client.getMe();
            checks.push({
              name: "channel.telegram",
              status: "pass",
              latencyMs: Math.round(performance.now() - tgStart),
              message: `@${me.username} (bot id ${me.id})`,
            });
          } catch (err) {
            const status =
              err instanceof TelegramApiError && (err.statusCode === 401 || err.statusCode === 404)
                ? "fail"
                : "warn";
            checks.push({
              name: "channel.telegram",
              status,
              latencyMs: Math.round(performance.now() - tgStart),
              message:
                err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
        } else if (token === null) {
          // Decrypt уже зафиксировался выше; skip иначе double-push.
          if (!checks.some((c) => c.name === "channel.telegram")) {
            checks.push({
              name: "channel.telegram",
              status: "fail",
              message: "Token не найден в tenant_secrets",
              latencyMs: Math.round(performance.now() - tgStart),
            });
          }
        }
      }

      // 2. LLM chat — config + decryptable secret.
      const chatStart = performance.now();
      const [chatCfg] = await tx
        .select({
          provider: llmProviderConfigs.provider,
          model: llmProviderConfigs.model,
          secretRef: llmProviderConfigs.secretRef,
        })
        .from(llmProviderConfigs)
        .where(
          and(
            eq(llmProviderConfigs.tenantId, tenantId),
            eq(llmProviderConfigs.purpose, "chat"),
          ),
        );
      if (!chatCfg) {
        checks.push({
          name: "llm.chat",
          status: "fail",
          message: "LLM chat config не настроен",
        });
      } else if (chatCfg.provider !== "ollama" && !chatCfg.secretRef) {
        checks.push({
          name: "llm.chat",
          status: "fail",
          message: `${chatCfg.provider} требует apiKey, но secret_ref пустой`,
        });
      } else if (chatCfg.secretRef) {
        try {
          const secret = await getDecryptedSecret({
            db: tx,
            tenantId,
            key: chatCfg.secretRef,
            masterKeyHex: opts.masterKeyHex,
          });
          if (!secret) {
            checks.push({
              name: "llm.chat",
              status: "fail",
              message: "apiKey не найден в tenant_secrets",
            });
          } else {
            checks.push({
              name: "llm.chat",
              status: "pass",
              latencyMs: Math.round(performance.now() - chatStart),
              message: `${chatCfg.provider} / ${chatCfg.model}`,
            });
          }
        } catch (err) {
          checks.push({
            name: "llm.chat",
            status: "fail",
            message: `Decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        // Ollama no-key path.
        checks.push({
          name: "llm.chat",
          status: "pass",
          message: `${chatCfg.provider} / ${chatCfg.model} (local)`,
        });
      }

      // 2b. LLM live ping — только если ?live=1 и resolveChat передан.
      if (
        livePing &&
        opts.resolveChat &&
        checks.some((ch) => ch.name === "llm.chat" && ch.status === "pass")
      ) {
        const pingStart = performance.now();
        try {
          const client = opts.resolveChat(tenantId);
          await client.complete([{ role: "user", content: "hi" }], { numPredict: 1 });
          checks.push({
            name: "llm.ping",
            status: "pass",
            latencyMs: Math.round(performance.now() - pingStart),
            message: "live LLM response received",
          });
        } catch (err) {
          checks.push({
            name: "llm.ping",
            status: "fail",
            latencyMs: Math.round(performance.now() - pingStart),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3. LLM embed — optional но даёт RAG.
      const [embedCfg] = await tx
        .select({
          provider: llmProviderConfigs.provider,
          model: llmProviderConfigs.model,
          secretRef: llmProviderConfigs.secretRef,
          embedDim: llmProviderConfigs.embedDim,
        })
        .from(llmProviderConfigs)
        .where(
          and(
            eq(llmProviderConfigs.tenantId, tenantId),
            eq(llmProviderConfigs.purpose, "embed"),
          ),
        );
      if (!embedCfg) {
        checks.push({
          name: "llm.embed",
          status: "warn",
          message: "Embed не настроен — RAG-ответы по KB недоступны",
        });
      } else {
        checks.push({
          name: "llm.embed",
          status: "pass",
          message: `${embedCfg.provider} / ${embedCfg.model} (dim=${embedCfg.embedDim ?? "?"})`,
        });
      }

      // 4. tenant_secrets sanity — мастер-ключ работает (decrypt'ит хотя
      // бы один существующий secret). Не отдельный check сам по себе —
      // покрывается в (1) и (2) выше. Skip отдельный проход.
      const [anySecret] = await tx
        .select({ key: tenantSecrets.key })
        .from(tenantSecrets)
        .where(eq(tenantSecrets.tenantId, tenantId))
        .limit(1);
      if (!anySecret) {
        checks.push({
          name: "tenant_secrets",
          status: "warn",
          message: "Нет ни одного зашифрованного secret'а",
        });
      }
    });

    const passed = checks.filter((c) => c.status === "pass").length;
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    const overall: CheckStatus = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";

    return c.json({
      checks,
      summary: {
        overall,
        passed,
        failed,
        warned,
        total: checks.length,
      },
    });
  });

  return app;
}
