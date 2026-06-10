import { describe, expect, it } from "bun:test";
import type { Inbound } from "@chatman-media/channel-core";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { ContactsRepo } from "./dal/index.ts";
import { processInbound } from "./process-inbound.ts";
import {
	FakeChannelIdentitiesRepo,
	FakeContactsRepo,
	FakeConversationsRepo,
	FakeMessagesRepo,
	FakeOutboundQueueRepo,
} from "./testkit.ts";
import type { ChannelContext, Clock, TenantContext } from "./types.ts";

const TENANT: TenantContext = {
	tenantId: 1,
	slug: "legacy",
	llmBillingMode: "byok",
};
const CHANNEL: ChannelContext = {
	channelId: 10,
	kind: "telegram_bot",
	externalId: "test_bot",
};

function fixedClock(epoch: number): Clock {
	return { nowEpoch: () => epoch };
}

function textInbound(
	externalUserId: string,
	externalMessageId: string,
	text: string,
): Inbound {
	return {
		channelId: "tg-1",
		externalMessageId,
		externalUserId,
		parts: [{ kind: "text", text }],
		receivedAt: 1700000000,
		raw: {},
	};
}

function makeTemplate(
	extractor: (text: string) => Record<string, unknown>,
): VerticalTemplate {
	return {
		slug: "test_v1",
		displayName: "Test",
		version: 1,
		funnelStages: [{ slug: "intake", kind: "intake", displayName: "Intake" }],
		hooks: {
			extractFields: (_ctx, text) => extractor(text),
		},
	};
}

function makeDeps(template?: VerticalTemplate) {
	const contacts = new FakeContactsRepo(TENANT.tenantId);
	const identities = new FakeChannelIdentitiesRepo();
	const conversations = new FakeConversationsRepo(TENANT.tenantId);
	const messages = new FakeMessagesRepo(TENANT.tenantId);
	const outbound = new FakeOutboundQueueRepo(TENANT.tenantId);
	return {
		tenant: TENANT,
		channel: CHANNEL,
		channelDbId: 10,
		contacts: contacts as unknown as ContactsRepo,
		identities: identities as unknown as Parameters<
			typeof processInbound
		>[1]["identities"],
		conversations: conversations as unknown as Parameters<
			typeof processInbound
		>[1]["conversations"],
		messages: messages as unknown as Parameters<
			typeof processInbound
		>[1]["messages"],
		outbound: outbound as unknown as Parameters<
			typeof processInbound
		>[1]["outbound"],
		...(template ? { template } : {}),
		clock: fixedClock(1700000000),
		_fakes: { contacts },
	};
}

describe("processInbound + extractFields hook", () => {
	it("вызывает template.hooks.extractFields и merge'нет результат в contact.attributes_json", async () => {
		let hookCalledWith: string | null = null;
		const template = makeTemplate((text) => {
			hookCalledWith = text;
			const m = /меня зовут (\S+)/i.exec(text);
			return m ? { name: m[1] } : {};
		});
		const deps = makeDeps(template);
		await processInbound(
			textInbound("u1", "100", "Привет, меня зовут Алина"),
			deps,
		);

		expect(hookCalledWith as string | null).toBe("Привет, меня зовут Алина");
		const contact = deps._fakes.contacts.all()[0]!;
		expect(JSON.parse(contact.attributesJson!)).toEqual({ name: "Алина" });
	});

	it("merge'нет несколько inbound'ов — атрибуты накапливаются", async () => {
		const template = makeTemplate((text) => {
			const out: Record<string, unknown> = {};
			const name = /меня зовут (\S+)/i.exec(text)?.[1];
			const age = /мне (\d+)/i.exec(text)?.[1];
			if (name) out.name = name;
			if (age) out.age = Number(age);
			return out;
		});
		const deps = makeDeps(template);
		await processInbound(textInbound("u1", "100", "Меня зовут Алина"), deps);
		await processInbound(textInbound("u1", "101", "Мне 25 лет"), deps);
		const contact = deps._fakes.contacts.all()[0]!;
		expect(JSON.parse(contact.attributesJson!)).toEqual({
			name: "Алина",
			age: 25,
		});
	});

	it("hook НЕ вызывается на дедуплицированном inbound (тот же external_message_id)", async () => {
		let calls = 0;
		const template = makeTemplate((_) => {
			calls += 1;
			return {};
		});
		const deps = makeDeps(template);
		const inbound = textInbound("u1", "100", "first");
		await processInbound(inbound, deps);
		await processInbound(inbound, deps);
		expect(calls).toBe(1);
	});

	it("hook НЕ вызывается на media-only inbound (text пустой)", async () => {
		let calls = 0;
		const template = makeTemplate((_) => {
			calls += 1;
			return { x: 1 };
		});
		const deps = makeDeps(template);
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "100",
			externalUserId: "u1",
			parts: [
				{ kind: "photo", mediaRef: { channelId: "tg-1", externalRef: "f" } },
			],
			receivedAt: 1700000000,
			raw: {},
		};
		await processInbound(inbound, deps);
		expect(calls).toBe(0);
	});

	it("hook-исключение не ломает pipeline — inbound persist'нет, reply pipeline не break'нет", async () => {
		const template = makeTemplate((_) => {
			throw new Error("LLM down");
		});
		const deps = makeDeps(template);
		const sinkLogs: Array<{ level: string; msg: string }> = [];
		const result = await processInbound(textInbound("u1", "100", "hi"), {
			...deps,
			sink: { log: (level, msg) => sinkLogs.push({ level, msg }) },
		});
		expect(result.persisted).toBe(true);
		expect(sinkLogs.some((l) => l.msg === "extractFields hook failed")).toBe(
			true,
		);
	});

	it("template без hooks.extractFields — pipeline работает как раньше (без merge)", async () => {
		const template: VerticalTemplate = {
			slug: "no_hooks",
			displayName: "No hooks",
			version: 1,
			funnelStages: [{ slug: "intake", kind: "intake", displayName: "Intake" }],
		};
		const deps = makeDeps(template);
		await processInbound(textInbound("u1", "100", "hi"), deps);
		const contact = deps._fakes.contacts.all()[0]!;
		expect(contact.attributesJson).toBeNull();
	});
});
