# Exchange candidate cases

15 разных кейсов обменника — только реплики клиента (candidate-only), для тестов/KB бота.
Анонимизировано: телефоны, карты, счета, ссылки, крипто-адреса, ФИО получателей — `[…]`.
Источник: redacted Telegram-экспорты (повторные клиенты разложены по отдельным сделкам).

| # | Файл | Направление | Сценарий |
|---|------|-------------|----------|
| 01 | `01-rub-tinkoff-qr-kyc-courier-pattaya-10k` | RUB→THB | RUB→THB, Тинькофф/QR, KYC, курьер в Паттайе, 10k THB |
| 02 | `02-usdt-trc20-wallet-delivery-60k` | USDT→THB | USDT→THB, TRC20-кошелёк, доставка/банкомат, 60k THB |
| 03 | `03-usdt-binance-id-small-2500` | USDT→THB | USDT→THB, Binance ID, малый обмен 2500 THB |
| 04 | `04-rub-card-sber-cardless-atm-22k` | RUB→THB | RUB→THB, карта/Сбер, выдача через банкомат, 22k THB |
| 05 | `05-rub-sber-cardless-atm-10k` | RUB→THB | RUB→THB, Сбер/QR, проверка банка, cardless ATM 10k THB |
| 06 | `06-rub-qr-first-time-faq` | RUB→THB | RUB→THB, QR/СБП, первый обмен, вопросы про офис/курьера/банкомат |
| 07 | `07-rub-qr-kyc-reuse-35k` | RUB→THB | RUB→THB, QR, KYC (паспорт из другого обменника), зелёный банкомат, 35k RUB |
| 08 | `08-usdt-trc20-atm-450` | USDT→THB | USDT→THB, TRC20 450, выдача в банкомате |
| 09 | `09-rub-atm-unavailable-complaint` | RUB→THB | RUB→THB, нужного банкомата нет, 2ч ожидания, частичная выдача, жалоба |
| 10 | `10-rub-then-usdt-two-ops-split` | Две операции подряд: RUB→THB сплит + сразу USDT→THB | Две операции подряд: RUB→THB сплит + сразу USDT→THB, 87k+33k THB |
| 11 | `11-usdt-urgent-partial-payout` | USDT→THB (Trust) | USDT→THB (Trust), нехватка суммы, частичная выдача, срочность к встрече |
| 12 | `12-rub-tinkoff-qr-bangkok-bank` | RUB→THB | RUB→THB, Тинькофф/QR, выплата на Bangkok Bank |
| 13 | `13-thb-to-rub-third-party-cards` | THB→RUB | THB→RUB, СБП не подключён, выплата на карты родственников (мама Сбер) |
| 14 | `14-thb-rub-roundtrip-rate-dispute` | THB↔RUB туда-обратно | THB↔RUB туда-обратно, спор о курсе и потере |
| 15 | `15-urgent-credit-late-night-complaint` | THB→RUB срочно под кредит | THB→RUB срочно под кредит, ночью, выплата отцу (СБП), жалоба на игнор |
