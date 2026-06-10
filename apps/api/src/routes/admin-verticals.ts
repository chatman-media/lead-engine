import {
  DrizzleKbStore,
  StylesRepo,
  type Db,
  withTenant,
} from "@chatman-media/conversation-engine";
import { ingestText, type KbScope } from "@chatman-media/kb";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { defaultRegistry, type VerticalKbDocSeed } from "@chatman-media/verticals";
import { funnels, styles as stylesTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { seedFunnelByKey, seedSkillsCatalogue } from "./admin-funnel.ts";

/**
 * Vertical plugin install endpoints.
 *
 *   GET  /api/admin/verticals           — список доступных вертикалей из реестра
 *   POST /api/admin/verticals/:slug/install — атомарная установка:
 *          funnel seed → skills seed → styles seed → KB docs ingest
 *
 * Идемпотентен: повторный install не ломает данные (funnel заменяется,
 * styles upsert'ятся по slug, KB-документы добавляются только если нет
 * дубликатов по title).
 */
export interface AdminVerticalsRoutesOpts {
  db: Db;
  /** Embedder для KB ingest (нужен для вертикалей с kbDocuments). */
  resolveEmbedder?: (tenantId: number) => EmbeddingClient;
}

function resolveVerticalKbDocScope(
  scope: VerticalKbDocSeed["scope"],
  funnelId: number | null,
): KbScope | null {
  if (!scope || scope.scopeType === "global") return null;
  if (!funnelId) return null;
  if (scope.scopeType === "funnel") return { scopeType: "funnel", funnelId };
  return { scopeType: "stage", funnelId, stageSlug: scope.stageSlug };
}

export function makeAdminVerticalsRoutes(opts: AdminVerticalsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/verticals
   * Возвращает список зарегистрированных вертикалей.
   */
  app.get("/api/admin/verticals", (c) => {
    const slugs = defaultRegistry.list();
    const items = slugs.map((slug) => {
      const tpl = defaultRegistry.tryLoad(slug);
      return {
        slug,
        displayName: tpl?.displayName ?? slug,
        version: tpl?.version ?? 0,
        hasStyles: (tpl?.styles?.length ?? 0) > 0,
        hasKbDocuments: (tpl?.kbDocuments?.length ?? 0) > 0,
        hasFunnel: !!tpl?.funnelSeedKey,
      };
    });
    return c.json({ items });
  });

  /**
   * POST /api/admin/verticals/:slug/install
   * Устанавливает вертикаль: воронка + навыки + стили + KB-документы.
   * Возвращает детальный отчёт по каждой стадии установки.
   */
  app.post("/api/admin/verticals/:slug/install", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const slug = c.req.param("slug");

    const tpl = defaultRegistry.tryLoad(slug);
    if (!tpl) {
      const available = defaultRegistry.list().join(", ");
      return c.json({ error: `vertical "${slug}" not found. Available: ${available}` }, 404);
    }

    const report: Record<string, unknown> = {};
    let installedFunnelId: number | null = null;

    // 1. Funnel seed
    if (tpl.funnelSeedKey) {
      const result = await seedFunnelByKey(opts.db, tenantId, tpl.funnelSeedKey, adminId);
      if ("error" in result) {
        return c.json({ error: `funnel seed failed: ${result.error}` }, 500);
      }
      installedFunnelId = result.funnelId;
      // Привязываем воронку к vertical template, чтобы runtime (index.ts →
      // resolveTemplate) и onboarding-детекция нашли её по
      // funnels.vertical_template_id. seedFunnelByKey переиспользует
      // существующую активную воронку, поэтому UPDATE по funnelId покрывает и
      // insert-, и existing-funnel случаи. Пишем registry slug (tpl.slug,
      // напр. "exchange_v1") — это ключ KNOWN_TEMPLATES.
      await withTenant(opts.db, tenantId, async (tx) => {
        await tx
          .update(funnels)
          .set({ verticalTemplateId: tpl.slug, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(funnels.id, result.funnelId));
      });
      report.funnel = { ...result, verticalTemplateId: tpl.slug };
    }

    // 2. Skills seed
    const skillsResult = await seedSkillsCatalogue(opts.db, tenantId);
    report.skills = skillsResult;

    // 3. Styles seed (upsert по slug — идемпотентно)
    if (tpl.styles && tpl.styles.length > 0) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      let stylesCreated = 0;
      let stylesUpdated = 0;

      await withTenant(opts.db, tenantId, async (tx) => {
        for (const [i, styleSeed] of tpl.styles!.entries()) {
          // Только ПЕРВЫЙ стиль шаблона становится активным (дефолт воронки);
          // остальные сидятся неактивными — оператор переключит их в Настройках.
          // Иначе у тенанта несколько активных стилей и reply-движок берёт
          // «самый свежий активный» недетерминированно (resolveTenantStyle).
          const makeActive = i === 0;
          // Идемпотентно по slug (вне зависимости от isActive), чтобы повторная
          // установка не плодила дубликаты неактивных стилей.
          const [existing] = await tx
            .select({ id: stylesTable.id })
            .from(stylesTable)
            .where(
              and(
                eq(stylesTable.tenantId, tenantId),
                eq(stylesTable.slug, styleSeed.slug),
                sql`deleted_at IS NULL`,
              ),
            )
            .limit(1);

          if (existing) {
            await tx
              .update(stylesTable)
              .set({
                displayName: styleSeed.displayName,
                configJson: styleSeed.configJson,
                isActive: makeActive,
              })
              .where(eq(stylesTable.id, existing.id));
            stylesUpdated++;
          } else {
            await tx.insert(stylesTable).values({
              tenantId,
              slug: styleSeed.slug,
              displayName: styleSeed.displayName,
              configJson: styleSeed.configJson,
              isActive: makeActive,
              version: 1,
              createdAt: nowEpoch,
            });
            stylesCreated++;
          }
        }
      });

      report.styles = { created: stylesCreated, updated: stylesUpdated };
    }

    // 4. KB documents ingest. Если embedder недоступен, сохраняем text-only
    // chunks: они участвуют в BM25/text fallback, но не в vector search.
    if (tpl.kbDocuments && tpl.kbDocuments.length > 0) {
      let embedder: EmbeddingClient | null = null;
      if (opts.resolveEmbedder) {
        try {
          embedder = opts.resolveEmbedder(tenantId);
        } catch {
          embedder = null;
        }
      }

      let docsIngested = 0;
      for (const doc of tpl.kbDocuments) {
        const scope = resolveVerticalKbDocScope(doc.scope, installedFunnelId);
        await withTenant(opts.db, tenantId, async (tx) => {
          const kb = new DrizzleKbStore({ db: tx, tenantId });
          await ingestText(
            { title: doc.title, body: doc.body },
            {
              kb,
              ...(embedder
                ? { embedder: embedder as unknown as Parameters<typeof ingestText>[1]["embedder"] }
                : {}),
              ...(doc.topic ? { topic: doc.topic } : {}),
              ...(scope ? { scope } : {}),
            },
          );
        });
        docsIngested++;
      }
      report.kbDocuments = {
        ingested: docsIngested,
        mode: embedder ? "embedded" : "text_only",
        ...(embedder ? {} : { warning: "embedder unavailable; stored text-only KB chunks" }),
      };
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "vertical.install",
      targetKind: "vertical",
      targetId: slug,
      details: report,
    });

    return c.json({ ok: true, slug, ...report });
  });

  return app;
}
