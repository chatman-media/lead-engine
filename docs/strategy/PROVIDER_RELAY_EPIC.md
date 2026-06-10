# Epic: Cross-channel provider relay and brokered orders

_Created: 2026-06-09._

## Summary

Build a channel-agnostic broker flow where a customer can request a service in one
channel, a provider can negotiate and confirm in another channel, and Lead Engine
mediates the order, payment, commission, and final customer-facing response.

Example: a customer writes in Telegram asking for a massage booking. The system
creates an order, contacts a massage salon in WhatsApp, receives availability and
price, asks the customer to pay through the platform, takes commission, and sends
the confirmed booking back to both sides.

This is not raw message forwarding. It is a brokered marketplace/concierge flow:
messages are attached to an order, each side sees only the information intended
for it, and the system owns status, payment, commission, and audit trail.

## Goal

Let tenants fulfill customer requests through external providers without requiring
the customer and provider to use the same messenger.

Success criteria:

- Customer can start a service request from Telegram, WhatsApp, web, or another
  supported channel.
- Provider can receive and respond through Telegram, WhatsApp, web, or another
  supported channel.
- One `service_order` links customer conversation, provider request, status,
  quoted price, payment state, and commission.
- Customer-facing bot never depends on provider channel details.
- Provider-facing messages can be templated, redacted, and compliant with channel
  constraints such as WhatsApp templates/opt-in.
- Operator can see both sides, intervene, and send offers manually.

## Non-goals for MVP

- Open-ended anonymous two-way chat between customer and provider.
- Automatic provider payouts.
- Cold WhatsApp outreach to providers without explicit opt-in/onboarding.
- Multi-provider bidding UI for customers.
- Public provider marketplace pages.
- Replacing the existing concierge funnel model.

## Product decisions

1. `contacts` and `channel_identities` remain the channel-agnostic identity layer.
   Providers should also be contacts, then get a provider profile on top.
2. The order is the shared aggregate. Conversations stay per side/channel.
3. Provider replies are interpreted as updates to `provider_requests`, not blindly
   forwarded to customers.
4. The customer sees a normalized offer, not raw provider wording by default.
5. Payment capture should happen before revealing sensitive provider/customer
   contact details.
6. Commission is recorded as platform revenue on the order. Payout can stay manual
   in MVP.

## BPR-0 approved MVP policy

This section is the product and compliance source of truth for the first provider
relay implementation.

### MVP service category

The first slice is **massage booking** only:

- allowed: mobile or salon massage/spa booking, including Thai, oil, deep tissue,
  foot, couples, and similar wellness services;
- allowed request fields: massage type, duration, number of guests, preferred
  time window, approximate area, hotel/villa area without room or exact address,
  language preference, and non-sensitive notes;
- excluded from MVP: medical treatment, adult/sexual services, escort services,
  alcohol/drug-related services, childcare, transport, housing, exchange, and any
  regulated or high-liability service category.

Other marketplace categories remain useful catalog examples, but provider relay
automation must not use them until a separate category policy is approved.

### Customer data sharing before payment

Provider outreach before payment must be need-to-know and redacted.

| Data | Before payment | After payment and confirmation |
|---|---|---|
| Order identifier | Share internal order code only. | Same. |
| Customer name | Do not share full name. Use "client" or a short display label. | Share only if needed for venue entry or provider policy. |
| Messenger handle, phone, email | Do not share. | Share only by operator action when direct contact is required. |
| Exact address, room, villa number | Do not share. Share area/neighborhood only. | Share after paid order is confirmed and provider needs arrival details. |
| Date/time window | Share requested window or preferred slot. | Share final confirmed slot. |
| Service preferences | Share relevant massage type, duration, guest count, pressure/gender preferences. | Same, plus final agreed details. |
| Customer notes/media | Share only operator-approved redacted summary. | Share raw media only if explicitly approved and necessary. |
| Payment details, passport/KYC, documents | Never share with providers. | Never share with providers. |

The customer-facing offer can include provider display name, service summary,
price, time, and area. It must not include provider phone, private messenger
identity, or staff personal contacts before payment.

### Provider opt-in and onboarding copy

Provider outreach is allowed only when the provider has an active opt-in record
for the channel and category. The opt-in record must include:

- provider contact and channel identity;
- opted-in service categories, starting with `massage`;
- opt-in source, timestamp, locale, and operator/admin who recorded it;
- allowed message channel and WhatsApp template categories if WhatsApp is used;
- provider ability to pause or revoke opt-in.

Default onboarding copy:

```text
Lead Engine can send you massage booking requests from our tenants in <area> via
<channel>. Requests may include an anonymized customer label, requested time,
approximate area, guest count, duration, massage preferences, and redacted notes.
Do not contact the customer directly until the platform confirms the paid order.
Reply with available slot, provider price, and any cancellation constraint. Your
reply is stored in the order audit trail. Reply PAUSE/STOP to opt out.
```

Russian operator-facing variant:

```text
Lead Engine может присылать вам заявки на массаж от клиентов tenant'ов в <area>
через <channel>. До оплаты вы видите только обезличенную заявку: время, район,
количество гостей, длительность, пожелания и отредактированные заметки. Не
связывайтесь с клиентом напрямую до подтверждения оплаченного заказа. Ответьте
доступным временем, ценой провайдера и условиями отмены. Ответ хранится в аудите
заказа. Напишите PAUSE/STOP, чтобы отключить заявки.
```

### Cancellation and refund rules

- Before customer payment: customer can cancel for free; no provider contact
  details are released.
- If no provider can confirm within the quote TTL, the order moves to
  `failed`/`cancelled`; any captured payment is fully refunded.
- After payment but before provider confirmation: if the provider cannot fulfill
  the offer, the customer gets replacement options or a full refund.
- After paid provider confirmation: customer can cancel for a full refund until
  two hours before the confirmed appointment, excluding non-refundable payment
  processor fees when applicable.
- Inside the two-hour window, after provider dispatch, customer no-show, or after
  service start: refund is operator-mediated and must record a reason in
  `order_events`.
- Provider cancellation or no-show: customer gets replacement options or a full
  refund, and the provider event is recorded for routing quality.

Any stricter provider-specific cancellation policy must be shown to the customer
before payment and approved by an operator in MVP.

### Counter-offers

Providers may counter-offer time and price. The platform must treat provider
messages as raw input, not customer-visible text:

- provider can reply with one or more available slots and provider-side price;
- system may parse clear time/price replies into `provider_requests`;
- ambiguous replies, policy exceptions, or sensitive text require operator
  review;
- customer sees only a normalized offer approved by policy or operator;
- provider quote TTL defaults to 15 minutes, and customer offer TTL defaults to
  30 minutes unless the operator overrides it.

### Commission model

MVP supports both percentage commission and an optional fixed fee:

- default massage policy: `15%` platform commission on the provider quote;
- optional fixed service fee may be added per tenant/service and defaults to `0`;
- customer payable amount = provider quote + percentage commission + fixed fee +
  configured payment processing fee;
- provider payout amount = provider quote unless an operator records an adjusted
  settlement;
- payout stays manual in MVP, while order events and ledger fields store gross,
  commission, fixed fee, currency, payment state, and settlement status.

## Proposed data model

New tenant-scoped tables:

| Table | Purpose |
|---|---|
| `provider_profiles` | Provider business/person profile. References `contacts.id`; stores category, status, display metadata. |
| `provider_services` | Services a provider can fulfill: service type, area, capacity hints, pricing policy JSON. |
| `service_orders` | Customer-facing order: customer contact/conversation, request type, status, quoted price, payment state, commission. |
| `provider_requests` | Provider-side attempt/quote: order, provider, provider conversation, status, quote, expiration, raw response metadata. |
| `order_events` | Append-only timeline for status changes, relay events, payment events, operator actions. |

Candidate order statuses:

`intake`, `matching`, `awaiting_provider`, `provider_declined`,
`offer_ready`, `awaiting_customer_payment`, `paid`, `confirmed`,
`fulfilled`, `cancelled`, `failed`.

Candidate provider request statuses:

`draft`, `sent`, `seen`, `quoted`, `accepted`, `declined`, `expired`,
`cancelled`.

## Architecture notes

- All production reads/writes for these tables must go through `withTenant`.
- `outbound_queue` remains the only dispatch path.
- `ChannelAdapter` remains transport-only. Order orchestration should live above
  channel adapters.
- `conversations.channel_id` is the first-class channel relation for new inbound
  conversations. The legacy `conversations.source` field remains as a
  compatibility/inbox field (`bot`, `userbot`, `self_play`), but WhatsApp, web,
  Facebook, VK, Max, and Telegram bot conversations are no longer distinguished
  by `source` alone.
- WhatsApp proactive messages need a template-aware send path and provider opt-in
  records. Free-form WhatsApp provider messaging should only happen when the
  service window allows it.
- Do not leak raw customer identifiers to providers unless the order policy says
  they are safe to share.

## MVP flow

1. Customer sends request: "Need massage today around 18:00 near Chaweng".
2. Existing funnel/runtime classifies request type and creates or updates a
   `service_order`.
3. Provider router selects one provider.
4. System creates `provider_request` and sends provider a channel-specific
   message, using WhatsApp template if required.
5. Provider replies with availability/price or declines.
6. System updates `provider_request` and `service_order`.
7. Bot sends customer a normalized offer and payment instruction/link.
8. Customer pays platform.
9. System records commission and sends confirmation to provider and customer.
10. Operator can intervene at any point from admin UI.

## Tasks

### BPR-0: Product and compliance spec

**Outcome:** One approved spec for provider relay behavior.

Acceptance criteria:

- [x] Define which service categories are in MVP. Proposed first slice: massage.
- [x] Define exactly what customer data can be shared with providers before
  payment.
- [x] Define provider opt-in requirements and onboarding copy.
- [x] Define cancellation/refund rules for MVP.
- [x] Define whether providers can counter-offer price/time.
- [x] Define commission model: fixed, percentage, or both.

Dependencies: none.

### BPR-1: Provider data model and migrations

**Outcome:** Tenant-scoped provider and order tables exist with RLS.

Acceptance criteria:

- Add `provider_profiles`, `provider_services`, `service_orders`,
  `provider_requests`, and `order_events`.
- Reuse `contacts` and `channel_identities` for provider identities.
- Add status checks and indexes for pending provider requests/orders.
- Add RLS policies with `FORCE ROW LEVEL SECURITY`.
- Add storage integration tests proving tenant isolation.

Dependencies: BPR-0.

### BPR-2: Conversation channel identity cleanup

**Outcome:** Provider/customer conversations can be reliably tied to real channels.

Acceptance criteria:

- Add a first-class `channel_id` relation to conversations, or an equivalent
  mapping that distinguishes Telegram, WhatsApp, web, Facebook, VK, Max, and
  self-play.
- Migrate existing `source` behavior without breaking current inbox queries:
  legacy rows with `channel_id IS NULL` continue to be unique by `(user_id,
  source)`, while new rows are unique by `(user_id, channel_id)`.
- Update `resolveConversation` so WhatsApp/web conversations no longer collapse
  into `source='bot'`.
- Update pipeline and migration tests for Telegram, WhatsApp, and web.

Dependencies: BPR-1 can run in parallel, but relay runtime depends on this.

### BPR-3: Provider admin CRUD

**Outcome:** Operators can onboard providers and their channel identities.

Acceptance criteria:

- API routes to create/update/list/archive providers.
- API routes to attach provider contact identity to an existing channel.
- Store provider category, service area, service types, status, and notes.
- Validate channel identity uniqueness through existing `channel_identities`.
- Admin UI page with provider list, detail drawer, and status controls.

Dependencies: BPR-1.

### BPR-4: Service order DAL and lifecycle

**Outcome:** Orders and provider requests can be created and advanced safely.

Acceptance criteria:

- DAL methods for creating order, selecting active orders by customer contact,
  adding provider request, recording quote/decline, and appending events.
- Status transition helper validates allowed order/request transitions.
- Idempotency keys prevent duplicate provider requests on webhook retries.
- Integration tests cover happy path, duplicate inbound, decline, expiration,
  and tenant isolation.

Dependencies: BPR-1.

### BPR-5: Provider routing policy

**Outcome:** The system can choose which provider to ask first.

Acceptance criteria:

- Deterministic MVP router selects eligible provider by service type, area,
  active status, and recent load.
- Router returns "no provider available" with a reason.
- Operator override can assign a specific provider.
- Tests cover no-match, paused provider, and multiple eligible providers.

Dependencies: BPR-3, BPR-4.

### BPR-6: Provider relay orchestrator

**Outcome:** Customer request can trigger provider outreach through any supported
channel.

Acceptance criteria:

- Orchestrator creates `service_order` and `provider_request`.
- Enqueues provider outbound through `outbound_queue`.
- Uses provider channel identity to build `OutboundEnvelope`.
- Writes `order_events` for sent, failed, retry, and cancelled states.
- Does not run provider outreach inside the inbound transaction.
- Tests verify no LLM or network work happens inside a DB transaction.

Dependencies: BPR-2, BPR-4, BPR-5.

### BPR-7: Provider inbound response handling

**Outcome:** Provider replies update the linked provider request/order.

Acceptance criteria:

- Incoming provider messages are associated with the open `provider_request`.
- Simple parser extracts availability, price, and decline intent.
- Ambiguous provider replies notify operator instead of updating customer.
- Provider media/documents are stored as message metadata and attached to events.
- Customer is not notified until an offer is ready or operator approves it.

Dependencies: BPR-6.

### BPR-8: Customer-facing offer and confirmation flow

**Outcome:** Customer receives normalized offers and confirmations.

Acceptance criteria:

- Reply strategy can include current order context in the customer prompt.
- Bot sends normalized provider offer with price/time/location summary.
- Customer acceptance moves order to `awaiting_customer_payment`.
- Payment success moves order to `paid`/`confirmed`.
- Provider confirmation message is sent after payment success.
- Operator can manually send or edit offer before customer sees it.

Dependencies: BPR-7, BPR-9.

### BPR-9: Payment and commission ledger

**Outcome:** Platform can collect from customer and record commission.

Acceptance criteria:

- Order stores quoted amount, customer payable amount, commission amount, and
  currency.
- Payment intent/session is linked to `service_orders`.
- Webhook updates payment state idempotently.
- Commission is recorded even if provider payout is manual.
- Refund/cancel path records event and final state.

Dependencies: BPR-4.

### BPR-10: WhatsApp template-aware outbound

**Outcome:** Provider WhatsApp outreach supports compliant first messages.

Acceptance criteria:

- Extend outbound model to represent template messages, or add a WhatsApp-specific
  metadata path that worker can validate.
- Provider onboarding records opt-in source, timestamp, and message categories.
- Sending to WhatsApp outside free-form window requires an approved template.
- Failed WhatsApp template send marks provider request as failed and notifies
  operator.
- Tests cover template payload building and free-form rejection path.

Dependencies: BPR-3, BPR-6.

### BPR-11: Operator order console

**Outcome:** Admin UI can run the broker workflow manually when AI is unsure.

Acceptance criteria:

- Order list with status, customer, provider, service type, amount, and SLA.
- Order detail shows customer thread, provider request thread, events, and payment
  state.
- Actions: assign provider, send provider request, approve quote, send customer
  offer, cancel order, mark fulfilled.
- UI makes clear which messages are customer-visible and provider-visible.

Dependencies: BPR-4, BPR-7, BPR-8.

### BPR-12: Observability, audit, and rollout controls

**Outcome:** Feature is safe to operate tenant by tenant.

Acceptance criteria:

- Tenant feature flag for provider relay.
- Metrics: orders created, provider response rate, time to quote, paid orders,
  commission, failures by channel.
- Audit events for provider assignment, quote approval, payment transitions, and
  manual overrides.
- Runbook section for stuck orders and WhatsApp send failures.
- Integration tests cover end-to-end Telegram customer to WhatsApp provider flow
  with fake adapters.

Dependencies: all runtime tasks.

## Suggested implementation slices

1. **Slice A: Manual broker MVP**
   - BPR-1, BPR-3, BPR-4, BPR-11 partial.
   - Operator creates order and provider request manually. No AI automation.

2. **Slice B: Automated provider outreach**
   - BPR-2, BPR-5, BPR-6, BPR-7.
   - Customer request creates order and contacts provider automatically.

3. **Slice C: Payment-gated confirmation**
   - BPR-8, BPR-9.
   - Customer pays platform before provider gets final confirmation.

4. **Slice D: WhatsApp-compliant production path**
   - BPR-10, BPR-12.
   - Provider outreach works safely outside Telegram-first environments.

## Definition of done for the epic

- A customer in Telegram can book through a provider in WhatsApp in a test tenant.
- Operator can inspect and override every transition.
- Payment state and commission are persisted and auditable.
- Provider outreach respects channel constraints.
- RLS tests cover all new tenant-scoped tables.
- `bun run typecheck`, `bun test` for touched packages, and `bun run check` pass.
