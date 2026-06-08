import type { Inbound } from "@chatman-media/channel-core";
import type { Db } from "@chatman-media/conversation-engine";
import type { FieldExtractor } from "./field-extractor.ts";
import {
	extractInboundText,
	type ServiceCatalogRuntime,
} from "./service-catalog-runtime.ts";

export interface PostInboundAutomationInput {
	db: Db;
	tenantId: number;
	contactId: number;
	conversationId?: number | null;
	inbound: Inbound;
	fieldExtractor?: FieldExtractor | null;
	serviceCatalogRuntime?: ServiceCatalogRuntime | null;
}

export async function runPostInboundAutomation(
	input: PostInboundAutomationInput,
): Promise<void> {
	const text = extractInboundText(input.inbound);
	if (!text) return;

	if (input.fieldExtractor) {
		await input.fieldExtractor
			.extract({
				tenantId: input.tenantId,
				contactId: input.contactId,
				text,
				db: input.db,
			})
			.catch(() => {});
	}

	if (input.serviceCatalogRuntime) {
		await input.serviceCatalogRuntime
			.extract({
				db: input.db,
				tenantId: input.tenantId,
				contactId: input.contactId,
				conversationId: input.conversationId ?? null,
				text,
				inbound: input.inbound,
			})
			.catch(() => {});
	}
}
