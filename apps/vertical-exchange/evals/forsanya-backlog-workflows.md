# Forsanya exchange workflow backlog

Additional redacted workflow candidates found in local Telegram exports after the
first 10 E2E fixtures. This file intentionally stores only scenario summaries,
source anchors and expected workflow tags; raw Telegram exports in `forsanya/`
may contain sensitive data and should not be committed.

Use these later as candidates for new JSONL fixtures and E2E mocks after the
current tool-level coverage is stable.

## 1. RUB→THB, QR/SBP, high amount split into several ATM payouts

- candidate id: `rub-qr-high-87400-thb-split-atm-payout`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `265864` → `265975`
- why useful: large target THB amount, operator splits issuance into several
  withdrawals and tracks remaining balance.
- expected workflow: `intent_exchange`, `direction_rub_to_thb`,
  `amount_thb_high`, `payment_method_qr`, `kyc_required`,
  `split_payout_plan`, `atm_payout_partial`, `remaining_balance`,
  `complete_or_continue`
- mocks needed later: payout provider with partial issuance and remaining THB.

## 2. USDT→THB, ATM payout, discount question before exchange

- candidate id: `usdt-atm-discount-question-16900-thb`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `273679` → `273683`
- why useful: customer asks about promotion/discount while specifying USDT,
  approximate target THB and yellow/green ATM preference.
- expected workflow: `intent_exchange`, `direction_usdt_to_thb`,
  `amount_thb_approx`, `payout_method_atm`, `promotion_question`,
  `rate_quote`, `discount_policy_response`, `continue_or_dropoff`
- mocks needed later: promotion policy and FAQ/RAG response assertions.

## 3. RUB→THB, customer challenges tier/rate for exact 20,300 THB

- candidate id: `rub-sbp-rate-confirmation-20300-thb`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `308327` → `308358`
- why useful: customer proposes the expected rate, asks if it is correct, then
  receives exact cardless ATM instructions.
- expected workflow: `intent_exchange`, `direction_rub_to_thb`,
  `rate_confirmation_question`, `amount_thb`, `payment_method_sbp_qr`,
  `atm_selection`, `cardless_atm_code`, `complete`
- mocks needed later: rate boundary assertion and cardless ATM code provider.

## 4. RUB→THB, source amount 35,000 RUB and limited ATM colors nearby

- candidate id: `rub-sbp-source-rub-35000-green-yellow-atm`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `315276` → `315289`
- why useful: source-side amount in RUB, customer asks how much THB they get
  and requires confirmation that only green/yellow ATMs are available.
- expected workflow: `intent_exchange`, `direction_rub_to_thb`,
  `amount_source_rub`, `compute_forward_quote`, `payment_method_sbp_qr`,
  `atm_availability_check`, `operator_confirmation_required`
- mocks needed later: ATM availability provider and forward quote by source RUB.

## 5. RUB→THB, target 23,400 THB, any ATM accepted

- candidate id: `rub-qr-any-atm-23400-thb`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `316450` → `316504`
- why useful: straightforward QR payment with flexible ATM payout; good
  regression fixture for the common happy path.
- expected workflow: `intent_exchange`, `direction_rub_to_thb`,
  `amount_thb`, `payment_method_qr`, `payout_method_any_atm`,
  `qr_requisites`, `cardless_atm_code`, `complete`, `review_request`
- mocks needed later: cardless ATM code provider and receipt confirmation.

## 6. USDT→THB, Trust Wallet, large target amount and partial payout problem

- candidate id: `usdt-trust-wallet-49000-thb-partial-payout`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `317097` → `317143`
- why useful: customer uses Trust Wallet, asks for 49,000 THB, operator cannot
  issue full amount immediately and discusses partial payout/refund/retry.
- expected workflow: `intent_exchange`, `direction_usdt_to_thb`,
  `amount_thb`, `source_wallet_trust`, `crypto_requisites`,
  `payout_method_any_atm`, `payout_insufficient_cash`,
  `partial_payout_or_refund`, `retry_later`
- mocks needed later: payout shortage state and customer choice branch.

## 7. KYC reuse: customer asks if previous passport/video is enough

- candidate id: `kyc-reuse-existing-documents-question`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- anchor ids: `242062` and `256107`
- why useful: existing customer asks whether prior passport/photo/video can be
  reused instead of passing full KYC again.
- expected workflow: `intent_exchange`, `kyc_required`,
  `kyc_existing_documents_question`, `verification_lookup`,
  `verified_or_needs_update`, `resume_exchange`
- mocks needed later: verification CRM lookup with statuses
  `verified`, `expired`, `needs_refresh`.

## 8. Third-party / family cards split payout request

- candidate id: `third-party-family-cards-split-request`
- source: `forsanya/result.json`
- anchor ids: `280955` → `284575`
- why useful: customer requests splitting transfers across family members’
  cards/accounts; this stresses third-party payment rules and operator approval.
- expected workflow: `intent_exchange`, `third_party_payment_detected`,
  `split_recipients_request`, `risk_check`, `operator_approval_required`,
  `approved_or_rejected`, `continue_exchange`
- mocks needed later: third-party risk policy and admin approval flag.

## 9. High-value repeat client complains about delay and urgent credit payment

- candidate id: `repeat-client-complaint-urgent-credit-payment`
- source: `forsanya/result.json`
- anchor ids: `296799` → `296849`
- why useful: unhappy repeat/high-value customer, urgency due to upcoming credit
  payment, operator explains intermediary rate/constraints.
- expected workflow: `intent_exchange`, `repeat_client_context`,
  `urgent_deadline`, `customer_complaint`, `retention_response`,
  `manual_quote_adjustment`, `continue_or_escalate`
- mocks needed later: conversation memory, urgency flag and human escalation.

## 10. Bank limit / delayed remaining payout

- candidate id: `bank-limit-delayed-remaining-payout`
- source: `forsanya/result.json`
- anchor ids: `336773` → `336777`
- why useful: payout is blocked by bank limits/connectivity; operator promises
  remaining amount later or via colleagues.
- expected workflow: `payout_in_progress`, `provider_limit_detected`,
  `remaining_balance`, `delay_notification`, `retry_or_alternative_provider`,
  `operator_followup_required`
- mocks needed later: payout provider failure modes, retry scheduling and
  reminder/task creation.

## Suggested implementation order

1. Add JSONL fixtures for cases 3, 4 and 5 first: they are deterministic rate /
   ATM happy-path variants.
2. Add cases 1, 6 and 10 when partial payout / provider failure state exists.
3. Add cases 7 and 8 when verification CRM and third-party approval are modeled
   as first-class admin states.
4. Add cases 2 and 9 when LLM/RAG text assertions and escalation policy are
   stable enough to test without brittle wording checks.
