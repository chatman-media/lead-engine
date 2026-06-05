# @chatman-media/channel-facebook

[![npm version](https://img.shields.io/npm/v/@chatman-media/channel-facebook?logo=npm&color=22c55e)](https://www.npmjs.com/package/@chatman-media/channel-facebook)
[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Facebook Messenger Platform channel adapter (Meta Graph) — text + attachments via webhook + Send API.

Part of the [**lead-engine**](https://github.com/chatman-media/lead-engine) monorepo — a multi-tenant SaaS platform for AI sales bots on Telegram / WhatsApp / Messenger.

It implements the same `ChannelAdapter` contract as [`@chatman-media/channel-whatsapp`](../channel-whatsapp) — both ride the Meta Graph API, so this package mirrors it closely. Differences: Messenger webhook events arrive as `entry[].messaging[]` (vs WhatsApp's `entry[].changes[]`), the send endpoint is `/me/messages`, and inbound media come as direct signed CDN URLs.

## Install

```bash
bun add @chatman-media/channel-facebook     # Bun
npm install @chatman-media/channel-facebook # npm / pnpm / yarn
```

## Usage

```ts
import { MessengerAdapter, verifyWebhookSubscription } from "@chatman-media/channel-facebook";

// Per-tenant: pageAccessToken comes from tenant_secrets, not env.
const adapter = new MessengerAdapter({ id: channelId, pageAccessToken });

// Webhook GET (Meta subscription handshake):
const v = verifyWebhookSubscription({ mode, token, challenge, expectedVerifyToken });
// → { ok, body, status }; reply v.body with v.status.

// Webhook POST (events): hand the raw payload to the adapter.
adapter.pushUpdate(payload); // parses entry[].messaging[] → Inbound[]

// Outbound (from the conversation engine / worker):
await adapter.send({ channelId, externalUserId: psid, parts: [{ kind: "text", text: "Hi!" }] });
```

## Notes

- **Signature**: verify the `X-Hub-Signature-256` HMAC (App Secret) on the webhook POST **before** tenant lookup — same as WhatsApp; done at the `apps/api` route layer.
- **24-hour window**: `send()` uses `messaging_type: "RESPONSE"`. Outside the 24h window since the user's last message, Meta only allows messages with a message tag.
- **Capabilities**: `text`, `photo`, `video`, `voice` (audio), `document` (file), `callbackQuery` (postbacks / quick replies), `typing` (sender_action). `edit`/`delete` are not supported by the Send API. Attachment captions aren't supported in a single send call.
- **Setup**: requires a Facebook Page + a Meta App with `pages_messaging` (App Review for production).

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)
