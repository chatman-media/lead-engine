// In-memory fake-репозитории для unit-тестов pipeline'а. НЕ используются
// в production: apps/worker инстанциирует настоящие Drizzle-репы. testkit
// существует чтобы pipeline можно было тестировать без поднятия Postgres
// и чтобы публичный API repos был покрыт contract-тестами.

import type {
	ChannelIdentityRow,
	ContactRow,
	ConversationRow,
	MessageRow,
	OutboundQueueRow,
} from "./dal/index.ts";

export class FakeContactsRepo {
	private nextId = 1;
	private readonly rows = new Map<number, ContactRow>();
	constructor(public readonly tenantId: number) {}

	async byId(id: number): Promise<ContactRow | null> {
		return this.rows.get(id) ?? null;
	}
	async create(opts: {
		displayName?: string;
		attributesJson?: string;
	}): Promise<ContactRow> {
		const id = this.nextId++;
		const now = Math.floor(Date.now() / 1000);
		const row: ContactRow = {
			id,
			tenantId: this.tenantId,
			displayName: opts.displayName ?? null,
			attributesJson: opts.attributesJson ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.rows.set(id, row);
		return row;
	}
	async mergeAttributes(
		contactId: number,
		partial: Record<string, unknown>,
		nowEpoch: number,
	): Promise<ContactRow | null> {
		const existing = this.rows.get(contactId);
		if (!existing) return null;
		if (Object.keys(partial).length === 0) return existing;
		const current = existing.attributesJson
			? (JSON.parse(existing.attributesJson) as Record<string, unknown>)
			: {};
		const merged = { ...current, ...partial };
		existing.attributesJson = JSON.stringify(merged);
		existing.updatedAt = nowEpoch;
		return existing;
	}
	all(): ContactRow[] {
		return [...this.rows.values()];
	}
}

export class FakeChannelIdentitiesRepo {
	private nextId = 1;
	private readonly rows: ChannelIdentityRow[] = [];

	async find(
		channelId: number,
		externalUserId: string,
	): Promise<ChannelIdentityRow | null> {
		return (
			this.rows.find(
				(r) => r.channelId === channelId && r.externalUserId === externalUserId,
			) ?? null
		);
	}
	async create(opts: {
		contactId: number;
		channelId: number;
		externalUserId: string;
	}) {
		const row: ChannelIdentityRow = {
			id: this.nextId++,
			contactId: opts.contactId,
			channelId: opts.channelId,
			externalUserId: opts.externalUserId,
			createdAt: Math.floor(Date.now() / 1000),
		};
		this.rows.push(row);
		return row;
	}
	all(): ChannelIdentityRow[] {
		return [...this.rows];
	}
}

export class FakeConversationsRepo {
	private nextId = 1;
	private readonly rows: ConversationRow[] = [];
	constructor(public readonly tenantId: number) {}

	async findByContactAndSource(
		contactId: number,
		source: string,
	): Promise<ConversationRow | null> {
		return (
			this.rows.find(
				(r) =>
					r.userId === contactId &&
					r.source === source &&
					r.tenantId === this.tenantId,
			) ?? null
		);
	}
	async create(opts: {
		contactId: number;
		source: string;
		mode?: "ai" | "queued" | "human";
		nowEpoch: number;
	}): Promise<ConversationRow> {
		const row: ConversationRow = {
			id: this.nextId++,
			tenantId: this.tenantId,
			userId: opts.contactId,
			source: opts.source,
			mode: opts.mode ?? "ai",
			status: "open",
			unreadCount: 0,
			lastMessageText: null,
			escalatedAt: null,
			assignedAdminId: null,
			lastMessageAt: opts.nowEpoch,
			createdAt: opts.nowEpoch,
			styleId: null,
			experimentId: null,
			currentStage: null,
			summaryJson: null,
			metaJson: null,
		};
		this.rows.push(row);
		return row;
	}
	async touchLastMessageAt(
		conversationId: number,
		nowEpoch: number,
	): Promise<void> {
		const row = this.rows.find((r) => r.id === conversationId);
		if (row) row.lastMessageAt = nowEpoch;
	}
	async updateInboxMetadata(
		conversationId: number,
		opts: {
			lastMessageText?: string;
			lastMessageAt?: number;
			incrementUnread?: boolean;
			status?: "open" | "pending" | "resolved";
		},
	): Promise<void> {
		const row = this.rows.find((r) => r.id === conversationId);
		if (!row) return;
		if (opts.lastMessageText !== undefined)
			row.lastMessageText = opts.lastMessageText;
		if (opts.lastMessageAt !== undefined)
			row.lastMessageAt = opts.lastMessageAt;
		if (opts.status !== undefined) row.status = opts.status;
		if (opts.incrementUnread) row.unreadCount += 1;
	}
	async markAsRead(conversationId: number): Promise<void> {
		const row = this.rows.find((r) => r.id === conversationId);
		if (row) row.unreadCount = 0;
	}
	async setAssignee(
		conversationId: number,
		adminId: number | null,
	): Promise<void> {
		const row = this.rows.find((r) => r.id === conversationId);
		if (row) row.assignedAdminId = adminId;
	}
	all(): ConversationRow[] {
		return [...this.rows];
	}
}

export class FakeMessagesRepo {
	private nextId = 1;
	private readonly rows: MessageRow[] = [];
	constructor(public readonly tenantId: number) {}

	async insert(opts: {
		conversationId: number;
		role: "user" | "assistant" | "human" | "system";
		text: string;
		externalMessageId?: string;
		metaJson?: string;
		stage?: string;
		nowEpoch: number;
	}): Promise<MessageRow> {
		const tgId =
			opts.externalMessageId !== undefined
				? Number(opts.externalMessageId)
				: null;
		const row: MessageRow = {
			id: this.nextId++,
			tenantId: this.tenantId,
			conversationId: opts.conversationId,
			role: opts.role,
			text: opts.text,
			tgMessageId: tgId !== null && !Number.isNaN(tgId) ? tgId : null,
			metaJson: opts.metaJson ?? null,
			createdAt: opts.nowEpoch,
			stage: opts.stage ?? null,
			deletedAt: null,
		};
		this.rows.push(row);
		return row;
	}
	async findUserByExternalId(
		conversationId: number,
		externalMessageId: string,
	): Promise<MessageRow | null> {
		const num = Number(externalMessageId);
		if (Number.isNaN(num)) return null;
		return (
			this.rows.find(
				(r) =>
					r.conversationId === conversationId &&
					r.role === "user" &&
					r.tgMessageId === num,
			) ?? null
		);
	}
	all(): MessageRow[] {
		return [...this.rows];
	}
}

export class FakeOutboundQueueRepo {
	private nextId = 1;
	private readonly rows: OutboundQueueRow[] = [];
	constructor(public readonly tenantId: number) {}

	async enqueue(opts: {
		channelId: number;
		conversationId?: number | null;
		envelope: { idempotencyKey?: string };
		scheduledAt?: number;
		nowEpoch: number;
	}): Promise<OutboundQueueRow> {
		if (opts.envelope.idempotencyKey) {
			const existing = this.rows.find(
				(r) => r.idempotencyKey === opts.envelope.idempotencyKey,
			);
			if (existing) return existing;
		}
		const row: OutboundQueueRow = {
			id: this.nextId++,
			tenantId: this.tenantId,
			channelId: opts.channelId,
			conversationId: opts.conversationId ?? null,
			payloadJson: JSON.stringify(opts.envelope),
			idempotencyKey: opts.envelope.idempotencyKey ?? null,
			scheduledAt: opts.scheduledAt ?? opts.nowEpoch,
			status: "pending",
			attempt: 0,
			lastError: null,
			externalMessageId: null,
			sentAt: null,
			createdAt: opts.nowEpoch,
		};
		this.rows.push(row);
		return row;
	}
	all(): OutboundQueueRow[] {
		return [...this.rows];
	}
}
