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
- The current `conversations.source` compatibility shim maps non-Telegram
  channels to `bot`. This is acceptable for simple inbound support, but not for a
  real cross-channel provider relay. The epic should include migration toward a
  real `conversations.channel_id` or equivalent relation.
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

- Define which service categories are in MVP. Proposed first slice: massage.
- Define exactly what customer data can be shared with providers before payment.
- Define provider opt-in requirements and onboarding copy.
- Define cancellation/refund rules for MVP.
- Define whether providers can counter-offer price/time.
- Define commission model: fixed, percentage, or both.

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
  mapping that distinguishes Telegram, WhatsApp, web, Facebook, VK, and self-play.
- Migrate existing `source` behavior without breaking current inbox queries.
- Update `resolveConversation` so WhatsApp/web conversations no longer collapse
  into `source='bot'`.
- Update route and worker tests for Telegram, WhatsApp, and web.

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
