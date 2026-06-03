# Exchange workflow model fit: Forsanya samples

This document maps the 10 redacted `forsanya` exchange samples to the current
Lead Engine exchange model before writing E2E mocks/tests.

Sources:

- `apps/vertical-exchange/evals/forsanya-exchange-workflows.jsonl`
- `apps/vertical-exchange/src/funnel-stages.ts`
- `apps/api/src/routes/admin-funnel.ts` seed template `exchange`
- `apps/api/src/lib/exchange/*.ts`

## Current model summary

Current universal funnel:

1. `intent_detected` — `form_fill`: intent and optional arrival date.
2. `exchange_request` — `form_fill`: `asset_from`, `network`, `amount_from`, `payout_method`.
3. `quote_calculated` — `rate_confirmation`: deterministic quote.
4. `verification_check` — `assessment`: verification status/CRM id.
5. `kyc_collection` — `document_upload`: video and document identity fields.
6. `risk_review` — `assessment`: pass/manual/reject.
7. `order_created` — `milestone`: exchange order id.
8. `requisites_sent` — `external_approval`: payment requisites and TTL.
9. `payment_proof_waiting` — `payment`: proof text/image.
10. `payment_verified` — `assessment`: source bank and matched amount.
11. `payout_or_completion` — `terminal_won`: final THB and payout code.

Important split:

- `exchange_orders.status` is a compact money lifecycle:
  `quote`, `awaiting_payment`, `paid`, `payout`, `completed`, `cancelled`, `expired`.
- Universal funnel stages above are the full business workflow visible to the
  operator. Admin exchange CRM now returns a computed `workflowStage` so the UI
  can show both layers instead of collapsing the process to seven order statuses.

Current deterministic tools:

- `compute_exchange_quote(asset, amount, network?)`
- `create_exchange_order(asset, amount, network?, payoutMethod?)`
- `fetch_exchange_requisites()`
- `verify_exchange_payment(proof?)`
- `issue_exchange_payout(payoutMethod, location)`

## Global mismatches before tests

### 1. Desired THB amount is now partially first-class

Real dialogs often start with target THB amount:

- “нужно 10 000 бат”
- “нужно 4 000 бат, рубли переведу”
- “за 1000 USDT сколько бат?”
- “22 000 бат обменяем”

Status: `compute_exchange_quote` and `create_exchange_order` now accept `amountMode = source_amount | target_thb`. The service can reverse-calculate the source amount when the customer says “нужно 10 000 бат”.

Still needed before robust E2E:

- persist requested side on `exchange_orders`, not only computed `amount_from/amount_to_thb`;
- add explicit funnel fields `amount_mode` and `amount_to_thb_requested`;
- add focused tests for tier boundaries and reverse quote rounding.

### 2. Tiered rates are by THB range, but DB has one rate per asset/network

Real rate cards are tiered by THB payout amount:

- RUB/THB: 2k–3k, <=7k, >=7k, >=20k, >=50k THB;
- USDT/THB: >=2k, >=10k, >=100k THB.

Current `exchange_rates` has unique `(tenant_id, asset, quote_asset, network)`;
`min_amount_from/max_amount_from` exist but cannot represent multiple active
bands for the same asset/network. Also for RUB the tiers are based on target THB,
not source RUB.

Needed:

- either separate `exchange_rate_tiers` table;
- or extend uniqueness to include tier key/range;
- range basis: `source_amount` vs `target_thb`;
- deterministic selection of tier and boundary rules.

### 3. Payout methods are now represented structurally

Current tools now support `office_cash`, `cardless_atm`, `courier_cash`, `thai_bank_transfer` plus legacy `atm`. Real samples include:

- courier cash delivery in Pattaya/hotel;
- cardless ATM with specific bank/color/phone/code;
- Thai bank transfer to Bangkok Bank;
- “любой банкомат” selection;
- customer at ATM before code issuance.

Still needed:

- dedicated provider mocks for courier availability and cardless ATM code issuance;
- richer UI for `payout_destination_json` instead of raw structured payload.

### 4. RUB payment method/source is partially modeled

Real RUB payment flows vary:

- QR/SBP dynamic link with amount and TTL;
- card transfer by phone/card;
- source bank checks: Sber, Tinkoff/T-Bank;
- first-party transfer requirement;
- third-party transfers require approval.

Status: orders now store `payment_method`, `payment_rail`, `source_bank`, `payer_name`, and `third_party_approved`. Provider can return wallet, Binance ID, static SBP/payment URL, or card-transfer text.

Still needed:

- amount-specific QR provider interface with `createPaymentLink(order)`;
- receipt-based first-party / third-party verification;
- stronger UI for source-bank and payer review.

### 5. KYC is now enforced before order creation

Status: `check_exchange_verification` reads contact verification state from `contacts.attributes_json`, and `create_exchange_order` returns `needsVerification` instead of creating an order when the contact is not verified. Orders persist `verification_id` when available.

Still needed:

- dedicated verification table/provider instead of attributes-only lookup;
- policy config: KYC always required vs only for QR/threshold/new client.

### 6. Fiat receipt verification and source bank extraction are missing

Current `verify_exchange_payment` auto-verifies only crypto TRC20. RUB returns
`needsOperator`. The funnel has `payment_proof_image` and `source_bank`, but no
receipt OCR/parser action updates the order.

Needed:

- `parse_exchange_receipt` or `verify_fiat_payment` tool;
- extract source bank, payer name, amount, timestamp, payment reference;
- manual confirmation endpoint should persist `proof_json` and `source_bank`.

### 7. Completion is mostly admin/manual

`issue_exchange_payout` can move order to `payout`, but does not complete without
admin status update. Real dialogs often finish with “Спасибо за обмен” right
after operator action.

Needed:

- explicit `complete_exchange_order` action or admin-assisted completion event;
- store final payout artifact: code, bank, phone, amount, courier confirmation;
- drive CRM turnover only after `completed`.

## Case-by-case fit

| Case | Fits current model | Current mocked coverage / remaining gaps |
|---|---:|---|
| `rub-qr-kyc-courier-pattaya-10k-thb` | High | Covered by tool E2E: target THB reverse quote, KYC gate, SBP requisites, receipt capture, courier payout metadata. Remaining: real dynamic QR API and OCR parser. |
| `usdt-trc20-wallet-delivery-60k-thb` | High | Covered by tool E2E: USDT TRC20 wallet requisites, target THB quote, courier payout metadata. Remaining: real AML/on-chain/provider callback path. |
| `rub-card-to-cardless-atm-22k-thb` | High | Covered by tool E2E: card transfer rail, source bank, target THB quote, cardless ATM payout metadata. Remaining: bank availability/code provider. |
| `rub-qr-atm-first-time-faq` | Medium/high | Covered by tool E2E: source amount quote, SBP requisites and cardless ATM payout. Remaining: FAQ/RAG text assertions and first-time risk copy. |
| `rub-qr-kyc-cardless-atm-12900-thb` | High | Covered by tool E2E: unverified contact returns `needsVerification`, verified contact creates order, SBP requisites and ATM payout metadata. Remaining: document upload entity/review status. |
| `rub-qr-bank-transfer-to-bangkok-bank` | High | Covered by tool E2E: SBP requisites, receipt capture and Thai bank transfer payout metadata. Remaining: real bank transfer confirmation/provider. |
| `rub-qr-tinkoff-to-bangkok-bank` | High | Covered by tool E2E: source bank, SBP rail and Thai bank payout metadata. Remaining: bank-specific QR API and receipt parser. |
| `rub-to-bangkok-bank-payout-45k-thb` | High | Covered by tool E2E: repeat-style THB target quote, SBP rail and Thai bank payout metadata. Remaining: repeat-client recipient confirmation memory. |
| `usdt-binance-id-small-2500-thb` | High | Covered by tool E2E: Binance ID rail and office cash payout metadata. Remaining: Binance proof verification callback/path. |
| `rub-sber-cardless-atm-10k-thb` | High | Covered by tool E2E: Sber/card transfer rail and cardless ATM payout metadata. Remaining: actual ATM code issuance provider. |

## Recommended E2E mock design

Implemented baseline: deterministic tool-level and route-level mocks now cover
the exchange action layer without real banking/API dependencies.

Current test files:

- `apps/api/src/lib/exchange/tools.forsanya.integration.test.ts`
  - 10 redacted Forsanya workflow scenarios + fixture sanity check;
  - runs `compute_exchange_quote` → `create_exchange_order` →
    `fetch_exchange_requisites` → `verify_exchange_payment` →
    admin/manual paid transition → `issue_exchange_payout`;
  - asserts `exchange_orders` side effects: `amount_mode`,
    `requested_amount`, payment rail/source bank, payout method,
    `verification_id`, `proof_json`.
- `apps/api/src/routes/admin-exchange.integration.test.ts`
  - admin auth, rate-card approval, hot-reload callback, requisites secret
    save, order CRM, operator patch, turnover and tenant isolation;
  - creates a real exchange order through `makeExchangeTools` after admin
    rates/requisites are saved through HTTP routes.

Run focused checks:

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun test apps/api/src/routes/admin-exchange.integration.test.ts \
           apps/api/src/lib/exchange/tools.forsanya.integration.test.ts
```

Design rule: do not start with LLM text assertions. Keep deterministic workflow
runner mocks around the same tools/actions the agent must call.

Mock/service coverage:

1. Rate-card/rate provider
   - tiered RUB/THB by target THB;
   - tiered USDT/THB by target THB/source USDT;
   - supports forward and reverse quote.

2. Verification mock
   - stored in `contacts.attributes_json.exchangeKyc`;
   - returns `needsVerification` and persists `verification_id`.

3. Requisites mock
   - crypto wallet address;
   - Binance ID;
   - SBP/payment link by tenant secret;
   - RUB card requisites by tenant secret;
   - operator-needed fallback.

4. Receipt/proof mock
   - stores fixture receipt metadata into `proof_json`;
   - returns source bank, amount, payer name, reference from tool args;
   - supports `needsOperator`.

5. Payout mock
   - courier/cardless ATM/Thai bank/office methods are persisted on order;
   - payout code is currently operator/admin supplied before
     `issue_exchange_payout`.

6. Risk checks
   - duplicate active order;
   - third-party payment;
   - high amount;
   - QR requires KYC.

E2E assertions should check DB side effects:

- lead fields populated from dialog;
- stage transitions are valid;
- `exchange_orders` snapshot has expected amounts/rate/status;
- `requisites_json`, `proof_json`, `risk_json`, `verification_id` are set;
- outbound messages contain no invented numbers/requisites;
- unresolved operator cases enter `awaiting_operator`/support mode or return `needsOperator`.

## Remaining production gaps after E2E mocks

1. Amount-specific real QR provider interface/API integration.
2. OCR/receipt parser with review status and admin correction flow.
3. Real payout providers for courier availability, cardless ATM code issuance
   and Thai bank transfer confirmation.
4. Provider injection seam if we need per-partner mocks beyond tenant secrets.
5. Persist quote/order state back into universal funnel fields for mixed
   universal-step analytics.
6. Add LLM/dialog-level tests after deterministic tool/action tests remain
   stable.
