# Exchange candidate cases — Филиппины (PHP)

PHP-адаптации THB-кейсов: реплики клиента переписаны под Манилу/Макати/BGC,
песо, выдачу через GCash / Maya / cardless ATM (BDO/BPI) и переводы на местные
банки/кошельки. Структура та же — только реплики клиента (candidate-only).

Анонимизировано: телефоны, карты, счета, ссылки, крипто-адреса, ФИО — `[…]`.
Базис: соседний каталог THB-кейсов (`../*.md`), адаптация направлений и реалий.

| # | Файл | Направление | Сценарий |
|---|------|-------------|----------|
| 01 | `ph-01-rub-gcash-kyc-courier-makati-10k` | RUB→PHP | RUB→PHP, карта/QR, KYC, курьер в Макати, 10k PHP |
| 03 | `ph-03-usdt-binance-small-2500` | USDT→PHP | USDT→PHP, Binance ID, малый обмен 2500 PHP |
| 05 | `ph-05-rub-gcash-cardless-atm-10k` | RUB→PHP | RUB→PHP, проверка банка, cardless ATM BDO 10k PHP |
| 06 | `ph-06-rub-qr-first-time-faq` | RUB→PHP | RUB→PHP, первый обмен, вопросы про офис/курьера/ATM |
| 07 | `ph-07-rub-qr-kyc-reuse-35k` | RUB→PHP | RUB→PHP, KYC (паспорт из другого обменника), ATM, 35k RUB |
| 08 | `ph-08-usdt-trc20-atm-450` | USDT→PHP | USDT→PHP, TRC20 450, выдача в банкомате |
| 12 | `ph-12-rub-to-bdo-bank` | RUB→PHP | RUB→PHP, выплата переводом на BDO |
