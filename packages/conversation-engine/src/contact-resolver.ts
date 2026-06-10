import type { Inbound } from "@chatman-media/channel-core";
import type {
	ChannelIdentitiesRepo,
	ContactRow,
	ContactsRepo,
} from "./dal/index.ts";

/**
 * Резолвит Contact по входящему сообщению. Если ChannelIdentity для
 * (channel, externalUserId) уже есть — возвращает существующий Contact;
 * иначе создаёт новый Contact + ChannelIdentity. Идемпотентно при
 * параллельных webhooks (на уровне БД UNIQUE(channel_id, external_user_id)
 * защищает от дублей).
 */
export async function resolveContact(opts: {
	inbound: Inbound;
	channelDbId: number;
	contacts: ContactsRepo;
	identities: ChannelIdentitiesRepo;
}): Promise<ContactRow> {
	const existingIdentity = await opts.identities.find(
		opts.channelDbId,
		opts.inbound.externalUserId,
	);
	if (existingIdentity) {
		const contact = await opts.contacts.byId(existingIdentity.contactId);
		if (!contact) {
			throw new Error(
				`resolveContact: identity ${existingIdentity.id} points to missing contact ${existingIdentity.contactId}`,
			);
		}
		return contact;
	}

	// Нового Contact'а заводим с display_name из inbound.externalUsername;
	// переименовать позже сможет оператор в admin-UI.
	const contact = await opts.contacts.create({
		...(opts.inbound.externalUsername
			? { displayName: opts.inbound.externalUsername }
			: {}),
	});
	await opts.identities.create({
		contactId: contact.id,
		channelId: opts.channelDbId,
		externalUserId: opts.inbound.externalUserId,
	});
	return contact;
}
