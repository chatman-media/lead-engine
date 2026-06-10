import { customerRequests } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export type CustomerRequestStatus = "open" | "won" | "lost" | "cancelled";

export interface CustomerRequestRow {
	id: number;
	tenantId: number;
	contactId: number;
	conversationId: number | null;
	leadId: number | null;
	funnelId: number | null;
	stageDefinitionId: number | null;
	requestType: string;
	status: CustomerRequestStatus;
	title: string | null;
	summary: string | null;
	metadataJson: string;
	createdAt: number;
	updatedAt: number;
	closedAt: number | null;
}

export class CustomerRequestsRepo {
	constructor(private readonly ctx: RepoCtx) {}

	async byId(id: number): Promise<CustomerRequestRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(customerRequests)
			.where(
				and(
					eq(customerRequests.id, id),
					eq(customerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.limit(1);
		return (row as CustomerRequestRow) ?? null;
	}

	async create(opts: {
		contactId: number;
		requestType: string;
		nowEpoch: number;
		conversationId?: number | null;
		leadId?: number | null;
		funnelId?: number | null;
		stageDefinitionId?: number | null;
		title?: string | null;
		summary?: string | null;
		metadataJson?: string;
	}): Promise<CustomerRequestRow> {
		const [row] = await this.ctx.db
			.insert(customerRequests)
			.values({
				tenantId: this.ctx.tenantId,
				contactId: opts.contactId,
				conversationId: opts.conversationId ?? null,
				leadId: opts.leadId ?? null,
				funnelId: opts.funnelId ?? null,
				stageDefinitionId: opts.stageDefinitionId ?? null,
				requestType: opts.requestType,
				status: "open",
				title: opts.title ?? null,
				summary: opts.summary ?? null,
				metadataJson: opts.metadataJson ?? "{}",
				createdAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
			})
			.returning();
		if (!row)
			throw new Error("customer_requests.create: insert returned no row");
		return row as CustomerRequestRow;
	}

	async listOpenByContact(contactId: number): Promise<CustomerRequestRow[]> {
		const rows = await this.ctx.db
			.select()
			.from(customerRequests)
			.where(
				and(
					eq(customerRequests.tenantId, this.ctx.tenantId),
					eq(customerRequests.contactId, contactId),
					eq(customerRequests.status, "open"),
				),
			)
			.orderBy(desc(customerRequests.updatedAt));
		return rows as CustomerRequestRow[];
	}

	async transitionStatus(
		id: number,
		status: CustomerRequestStatus,
		nowEpoch: number,
	): Promise<CustomerRequestRow | null> {
		const [row] = await this.ctx.db
			.update(customerRequests)
			.set({
				status,
				updatedAt: nowEpoch,
				closedAt: status === "open" ? null : nowEpoch,
			})
			.where(
				and(
					eq(customerRequests.id, id),
					eq(customerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		return (row as CustomerRequestRow) ?? null;
	}
}
