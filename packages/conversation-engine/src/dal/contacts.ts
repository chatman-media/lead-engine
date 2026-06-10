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
			.where(
				and(
					eq(contactsTable.id, id),
					eq(contactsTable.tenantId, this.ctx.tenantId),
				),
			);
		return row ?? null;
	}

	async create(opts: {
		displayName?: string;
		attributesJson?: string;
	}): Promise<ContactRow> {
		const [row] = await this.ctx.db
			.insert(contactsTable)
			.values({
				tenantId: this.ctx.tenantId,
				...(opts.displayName !== undefined
					? { displayName: opts.displayName }
					: {}),
				...(opts.attributesJson !== undefined
					? { attributesJson: opts.attributesJson }
					: {}),
			})
			.returning();
		if (!row) throw new Error("contacts.create: insert returned no row");
		return row;
	}

	/**
	 * Merge'нет partialAttributes поверх существующих contact.attributes_json
	 * и обновит updated_at. Если partial пустой — no-op (без UPDATE).
	 *
	 * JSON merging — shallow: ключи верхнего уровня в partial перезаписывают
	 * существующие; вложенные объекты НЕ деep-merge'атся (это позволяет
	 * вертикали atomically заменить целый struct, например visa_docs).
	 *
	 * Возвращает обновлённый ContactRow.
	 */
	async mergeAttributes(
		contactId: number,
		partial: Record<string, unknown>,
		nowEpoch: number,
	): Promise<ContactRow | null> {
		if (Object.keys(partial).length === 0) {
			return this.byId(contactId);
		}
		const existing = await this.byId(contactId);
		if (!existing) return null;
		const merged: Record<string, unknown> = existing.attributesJson
			? { ...(JSON.parse(existing.attributesJson) as Record<string, unknown>) }
			: {};
		for (const [k, v] of Object.entries(partial)) {
			merged[k] = v;
		}
		const [row] = await this.ctx.db
			.update(contactsTable)
			.set({ attributesJson: JSON.stringify(merged), updatedAt: nowEpoch })
			.where(
				and(
					eq(contactsTable.id, contactId),
					eq(contactsTable.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		return row ?? null;
	}
}
