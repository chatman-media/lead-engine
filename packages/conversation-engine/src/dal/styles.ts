import { styles as stylesTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface StyleRow {
  id: number;
  tenantId: number;
  slug: string;
  displayName: string;
  configJson: string;
  isActive: boolean;
  version: number;
  parentId: number | null;
  createdAt: number;
  deletedAt: number | null;
}

/**
 * Sales-style repo. Стили — versioned: один slug может иметь несколько строк
 * с разными version'ами; uniq_styles_active_slug (partial unique WHERE
 * is_active=TRUE) гарантирует одну живую версию на slug в каждый момент.
 *
 * findActiveBySlug → live версия. byId → конкретная версия (для audit /
 * shadow-evaluations / rollback'ов).
 */
export class StylesRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async byId(id: number): Promise<StyleRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(stylesTable)
      .where(and(eq(stylesTable.id, id), eq(stylesTable.tenantId, this.ctx.tenantId)));
    return (row as StyleRow) ?? null;
  }

  async findActiveBySlug(slug: string): Promise<StyleRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(stylesTable)
      .where(
        and(
          eq(stylesTable.tenantId, this.ctx.tenantId),
          eq(stylesTable.slug, slug),
          eq(stylesTable.isActive, true),
          sql`deleted_at IS NULL`,
        ),
      );
    return (row as StyleRow) ?? null;
  }

  /** Все active не-soft-deleted стили tenant'а (для admin-UI dropdown). */
  async listActive(): Promise<StyleRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(stylesTable)
      .where(
        and(
          eq(stylesTable.tenantId, this.ctx.tenantId),
          eq(stylesTable.isActive, true),
          sql`deleted_at IS NULL`,
        ),
      );
    return rows as StyleRow[];
  }

  /** Все не-soft-deleted стили tenant'а (включая неактивные). */
  async listAll(): Promise<StyleRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(stylesTable)
      .where(and(eq(stylesTable.tenantId, this.ctx.tenantId), sql`deleted_at IS NULL`));
    return rows as StyleRow[];
  }

  async create(data: {
    slug: string;
    displayName: string;
    configJson: string;
    isActive: boolean;
  }): Promise<StyleRow> {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const [row] = await this.ctx.db
      .insert(stylesTable)
      .values({
        tenantId: this.ctx.tenantId,
        slug: data.slug,
        displayName: data.displayName,
        configJson: data.configJson,
        isActive: data.isActive,
        version: 1,
        createdAt: nowEpoch,
      })
      .returning();
    return row as StyleRow;
  }

  async update(
    id: number,
    data: Partial<{ displayName: string; configJson: string; isActive: boolean }>,
  ): Promise<StyleRow | null> {
    const [row] = await this.ctx.db
      .update(stylesTable)
      .set(data)
      .where(
        and(
          eq(stylesTable.id, id),
          eq(stylesTable.tenantId, this.ctx.tenantId),
          sql`deleted_at IS NULL`,
        ),
      )
      .returning();
    return (row as StyleRow) ?? null;
  }

  async softDelete(id: number): Promise<boolean> {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const rows = await this.ctx.db
      .update(stylesTable)
      .set({ deletedAt: nowEpoch, isActive: false })
      .where(
        and(
          eq(stylesTable.id, id),
          eq(stylesTable.tenantId, this.ctx.tenantId),
          sql`deleted_at IS NULL`,
        ),
      )
      .returning({ id: stylesTable.id });
    return rows.length > 0;
  }
}
