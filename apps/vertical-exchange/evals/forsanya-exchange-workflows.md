# Forsanya exchange workflow samples

Redacted Telegram export samples for exchange workflow evaluation. Source files stay local under `forsanya/`; card numbers, phones, payment URLs, crypto addresses and payment refs are redacted.

## 1. RUB→THB, QR/SBP, KYC, курьер в Паттайе, 10k THB

- id: `rub-qr-kyc-courier-pattaya-10k-thb`
- source: `forsanya/ChatExport_2026-05-30/result.json`
- messages: 42
- expected workflow: `intent_exchange`, `direction_rub_to_thb`, `amount_thb`, `rate_quote`, `kyc_required`, `delivery_method_courier`, `requisites_qr`, `receipt_request`, `complete`

## 2. USDT→THB, TRC20 wallet, доставка/банкомат, 60k THB

- id: `usdt-trc20-wallet-delivery-60k-thb`
- source: `forsanya/ChatExport_2026-05-30 (3)/result.json`
- messages: 45
- expected workflow: `intent_exchange`, `direction_usdt_to_thb`, `amount_usdt_or_thb_clarification`, `rate_quote`, `source_wallet_bybit_question`, `requisites_crypto_wallet`, `delivery_or_atm_clarification`, `complete`

## 3. RUB→THB, карта/Сбер, выдача через банкомат, 22k THB

- id: `rub-card-to-cardless-atm-22k-thb`
- source: `forsanya/ChatExport_2026-05-30 (4)/result.json`
- messages: 60
- expected workflow: `intent_exchange`, `direction_rub_to_thb`, `amount_calc`, `rate_quote`, `requisites_card`, `cardless_atm_or_delivery`, `complete`, `review_request`

## 4. RUB→THB, QR/SBP, первый обмен, вопросы про офис/курьера/банкомат

- id: `rub-qr-atm-first-time-faq`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- messages: 8
- expected workflow: `intent_exchange`, `direction_rub_to_thb`, `payment_method_qr_sbp`, `faq_office_courier_atm`, `requisites_card_or_qr_options`

## 5. RUB→THB, QR, KYC из-за QR, выдача 12900 THB через банкомат

- id: `rub-qr-kyc-cardless-atm-12900-thb`
- source: `forsanya/ChatExport_2026-05-30 (5)/result.json`
- messages: 37
- expected workflow: `intent_exchange`, `direction_rub_to_thb`, `payment_method_qr`, `kyc_required`, `document_upload`, `qr_generation`, `atm_presence_check`, `payout_amount`

## 6. RUB→THB, QR, перевод на Bangkok Bank, повторный клиент

- id: `rub-qr-bank-transfer-to-bangkok-bank`
- source: `forsanya/result.json`
- messages: 21
- expected workflow: `intent_exchange`, `requisites_qr`, `payment_link_ttl`, `client_bank_account_confirmation`, `thai_bank_payout`, `complete`

## 7. RUB→THB, Tinkoff, QR, Bangkok Bank payout

- id: `rub-qr-tinkoff-to-bangkok-bank`
- source: `forsanya/result.json`
- messages: 14
- expected workflow: `intent_exchange`, `rate_quote`, `source_bank_question`, `payment_method_qr`, `qr_generation`

## 8. RUB→THB, клиент просит вывести 45k THB на Bangkok Bank

- id: `rub-to-bangkok-bank-payout-45k-thb`
- source: `forsanya/result.json`
- messages: 24
- expected workflow: `intent_exchange`, `rate_quote`, `qr_generation`, `payout_method_bank_transfer`, `complete`

## 9. USDT→THB, Binance ID, малый обмен 2500 THB

- id: `usdt-binance-id-small-2500-thb`
- source: `forsanya/ChatExport_2026-05-30 (2)/result.json`
- messages: 16
- expected workflow: `intent_exchange`, `direction_usdt_to_thb`, `amount_thb`, `source_binance_or_wallet_question`, `requisites_binance_id`, `complete`

## 10. RUB→THB, Сбер/QR, проверка банка, cardless ATM 10k THB

- id: `rub-sber-cardless-atm-10k-thb`
- source: `forsanya/ChatExport_2026-05-30 (1)/result.json`
- messages: 31
- expected workflow: `intent_exchange`, `amount_thb`, `source_bank_sber`, `bank_availability_check`, `requisites_card`, `cardless_atm_instruction`, `complete`
