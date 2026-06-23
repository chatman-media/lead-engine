/**
 * Partner callback endpoint — публичный (auth не нужен, токен = auth).
 *
 * GET /api/partner/cb/:token            → HTML-страница с кнопками
 * GET /api/partner/cb/:token?a=confirm  → подтвердить заявку → advance lead
 * GET /api/partner/cb/:token?a=cancel   → отклонить → заметка на лид
 *
 * Токен одноразовый: после обработки leads.awaiting_token очищается.
 */

import { type Db, type NotificationService, withTenant } from "@chatman-media/conversation-engine";
import { Hono } from "hono";
import { verifyCallbackToken } from "../lib/partner-ping.ts";
import {
  dispatchWorkflowEffects,
  handleWebhookCallbackInTx,
  loadWebhookCallbackPageInTx,
  type WorkflowEffect,
} from "../lib/workflow-runtime.ts";

export function makePartnerCallbackRoutes(opts: {
  db: Db;
  callbackSecret: string;
  appUrl: string;
  notificationService?: NotificationService | null;
}): Hono {
  const app = new Hono();

  /**
   * GET /api/partner/cb/:token
   * Without ?a= param → show HTML landing page with Confirm / Cancel buttons.
   */
  app.get("/api/partner/cb/:token", async (c) => {
    const token = c.req.param("token");
    const action = c.req.query("a"); // 'confirm' | 'cancel' | undefined

    // Verify token
    const payload = await verifyCallbackToken(token, opts.callbackSecret);
    if (!payload) {
      return c.html(
        htmlPage(
          "Неверная ссылка",
          "❌ Ссылка недействительна или уже была использована.",
          "error",
        ),
      );
    }

    const { tenantId, leadId, stageId } = payload;

    // No action → show landing page
    if (!action) {
      const page = await withTenant(opts.db, tenantId, (tx) =>
        loadWebhookCallbackPageInTx(tx, { tenantId, leadId, stageId, token }),
      );
      if (page.kind === "no_lead") {
        return c.html(htmlPage("Лид не найден", "❌ Заявка не найдена в системе.", "error"));
      }
      if (page.kind === "already_processed") {
        return c.html(
          htmlPage("Уже обработано", "✅ Эта заявка уже была обработана ранее.", "success"),
        );
      }
      if (page.kind === "stage_mismatch") {
        return c.html(
          htmlPage("Уже обработано", "✅ Эта заявка уже была обработана ранее.", "success"),
        );
      }

      const confirmUrl = `${opts.appUrl}/api/partner/cb/${token}?a=confirm`;
      const cancelUrl = `${opts.appUrl}/api/partner/cb/${token}?a=cancel`;

      return c.html(
        htmlLanding({
          leadId,
          stageName: page.stageName,
          confirmUrl,
          cancelUrl,
        }),
      );
    }

    if (action === "confirm") {
      const now = Math.floor(Date.now() / 1000);
      const outcome = await withTenant(opts.db, tenantId, (tx) =>
        handleWebhookCallbackInTx(tx, {
          tenantId,
          leadId,
          stageId,
          token,
          action: "confirm",
          now,
        }),
      );
      dispatchEffectsIfAny(outcome);

      if (outcome.kind === "advanced") {
        return c.html(
          htmlPage(
            "Подтверждено!",
            `✅ Заявка #${leadId} переведена на этап «${outcome.toDisplayName}».`,
            "success",
          ),
        );
      }
      if (outcome.kind === "terminal") {
        return c.html(
          htmlPage(
            "Подтверждено!",
            "✅ Заявка подтверждена и находится на финальном этапе.",
            "success",
          ),
        );
      }
      if (outcome.kind === "no_lead") {
        return c.html(htmlPage("Лид не найден", "❌ Заявка не найдена в системе.", "error"));
      }
      if (outcome.kind === "already_processed" || outcome.kind === "stage_mismatch") {
        return c.html(
          htmlPage("Уже обработано", "✅ Эта заявка уже была обработана ранее.", "success"),
        );
      }
      return c.html(htmlPage("Подтверждено!", "✅ Подтверждение получено.", "success"));
    }

    if (action === "cancel") {
      const now = Math.floor(Date.now() / 1000);
      const outcome = await withTenant(opts.db, tenantId, (tx) =>
        handleWebhookCallbackInTx(tx, {
          tenantId,
          leadId,
          stageId,
          token,
          action: "cancel",
          now,
        }),
      );
      dispatchEffectsIfAny(outcome);

      if (outcome.kind === "no_lead") {
        return c.html(htmlPage("Лид не найден", "❌ Заявка не найдена в системе.", "error"));
      }
      if (outcome.kind === "already_processed" || outcome.kind === "stage_mismatch") {
        return c.html(
          htmlPage("Уже обработано", "✅ Эта заявка уже была обработана ранее.", "success"),
        );
      }

      return c.html(
        htmlPage(
          "Отклонено",
          `❌ Заявка #${leadId} отклонена партнёром. Менеджер свяжется с клиентом.`,
          "cancel",
        ),
      );
    }

    return c.html(htmlPage("Неверный запрос", "Неизвестное действие.", "error"));
  });

  function dispatchEffectsIfAny(
    outcome: { effects?: readonly WorkflowEffect[] } | { kind: string },
  ): void {
    dispatchWorkflowEffects(
      "effects" in outcome ? (outcome.effects ?? []) : [],
      opts.notificationService ?? null,
    );
  }

  return app;
}

// ─── HTML helpers ───────────────────────────────────────────────────────────

function htmlPage(title: string, message: string, kind: "success" | "cancel" | "error"): string {
  const icon = kind === "success" ? "✅" : kind === "cancel" ? "❌" : "⚠️";
  const color = kind === "success" ? "#22c55e" : kind === "cancel" ? "#f97316" : "#ef4444";
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; }
  .card { background: #fff; border-radius: 16px; padding: 40px 32px;
    max-width: 400px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin: 16px 0 8px; color: #0f172a; }
  p { color: #64748b; line-height: 1.6; }
  .icon { font-size: 3rem; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px;
    font-size: .85rem; font-weight: 600; color: ${color}; background: ${color}18; margin-top: 12px; }
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <div class="badge">Lead Engine</div>
</div>
</body></html>`;
}

function htmlLanding(opts: {
  leadId: number;
  stageName: string;
  confirmUrl: string;
  cancelUrl: string;
}): string {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Партнёрская заявка — Lead Engine</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; }
  .card { background: #fff; border-radius: 16px; padding: 40px 32px;
    max-width: 440px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin: 12px 0 8px; color: #0f172a; }
  p { color: #64748b; line-height: 1.6; margin-bottom: 28px; }
  .icon { font-size: 2.8rem; }
  .btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  a { display: inline-block; padding: 12px 28px; border-radius: 10px;
    font-size: 1rem; font-weight: 600; text-decoration: none; transition: opacity .15s; }
  a:hover { opacity: .85; }
  .confirm { background: #22c55e; color: #fff; }
  .cancel  { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
  .meta { margin-top: 20px; font-size: .8rem; color: #94a3b8; }
</style></head><body>
<div class="card">
  <div class="icon">🤝</div>
  <h1>Партнёрская заявка</h1>
  <p>Пожалуйста, подтвердите или отклоните заявку <strong>#${opts.leadId}</strong>
  (этап: <em>${opts.stageName}</em>).</p>
  <div class="btns">
    <a class="confirm" href="${opts.confirmUrl}">✅ Подтвердить</a>
    <a class="cancel"  href="${opts.cancelUrl}">❌ Отклонить</a>
  </div>
  <div class="meta">Lead Engine · Partner Handoff</div>
</div>
</body></html>`;
}
