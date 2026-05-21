import { contacts as contactsTable } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface ContactRow {
  id: number;
  tenantId: number;
  displayName: string | null;
  attributesJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export class ContactsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async byId(id: number): Promise<ContactRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.id, id), eq(contactsTable.tenantId, this.ctx.tenantId)));
    return row ?? null;
  }

  async create(opts: { displayName?: string; attributesJson?: string }): Promise<ContactRow> {
    const [row] = await this.ctx.db
      .insert(contactsTable)
      .values({
        tenantId: this.ctx.tenantId,
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(opts.attributesJson !== undefined ? { attributesJson: opts.attributesJson } : {}),
      })
      .returning();
    if (!row) throw new Error("contacts.create: insert returned no row");
    return row;
  }
}
