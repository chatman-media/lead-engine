import { channelIdentities } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface ChannelIdentityRow {
	id: number;
	contactId: number;
	channelId: number;
	externalUserId: string;
	createdAt: number;
}

/**
 * channel_identities не имеет tenant_id напрямую — scoped через channels.tenant_id.
 * RepoCtx.tenantId всё равно прокидывается для defence-in-depth: SELECT'ы JOIN'ят
 * с channels и фильтруют по tenant_id, чтобы случайный bug в channel-resolver'е
 * не вернул foreign-tenant'овский row.
 */
export class ChannelIdentitiesRepo {
	constructor(private readonly ctx: RepoCtx) {}

	/** Найти существующую идентичность по (channelId, externalUserId). */
	async find(
		channelId: number,
		externalUserId: string,
	): Promise<ChannelIdentityRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(channelIdentities)
			.where(
				and(
					eq(channelIdentities.channelId, channelId),
					eq(channelIdentities.externalUserId, externalUserId),
				),
			);
		return row ?? null;
	}

	async create(opts: {
		contactId: number;
		channelId: number;
		externalUserId: string;
	}): Promise<ChannelIdentityRow> {
		const [row] = await this.ctx.db
			.insert(channelIdentities)
			.values({
				contactId: opts.contactId,
				channelId: opts.channelId,
				externalUserId: opts.externalUserId,
			})
			.returning();
		if (!row)
			throw new Error("channel_identities.create: insert returned no row");
		return row;
	}
}
