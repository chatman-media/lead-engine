# [@chatman-media/storage-v1.44.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.43.0...@chatman-media/storage-v1.44.0) (2026-06-19)


### Features

* **exchange:** модель покрытия операторов по точкам выдачи (B4a) ([#742](https://github.com/chatman-media/lead-engine/issues/742)) ([cdb5e1a](https://github.com/chatman-media/lead-engine/commit/cdb5e1ab413dfef6ccee8f52d49e3494439b8946))

# [@chatman-media/storage-v1.43.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.42.2...@chatman-media/storage-v1.43.0) (2026-06-19)


### Features

* **exchange:** каталог точек выдачи — фундамент ATM payout (B1) ([c68cdcb](https://github.com/chatman-media/lead-engine/commit/c68cdcb0c36bbb02206c356fa68ef5d5169f8b6d))

# [@chatman-media/storage-v1.42.2](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.42.1...@chatman-media/storage-v1.42.2) (2026-06-19)


### Bug Fixes

* **exchange:** нужен оператор → бот замолкает + одно уведомление; intake спрашивает всё сразу ([1c5349e](https://github.com/chatman-media/lead-engine/commit/1c5349ed4763634eaed806b4c637c48ff5cd0d05))

# [@chatman-media/storage-v1.42.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.42.0...@chatman-media/storage-v1.42.1) (2026-06-18)


### Bug Fixes

* **exchange:** на стадии «Курс рассчитан» не собираем поля курс/сумма ([51fc1fa](https://github.com/chatman-media/lead-engine/commit/51fc1fadfb010ab50aa07fa6c98405fec66d590e))

# [@chatman-media/storage-v1.42.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.41.0...@chatman-media/storage-v1.42.0) (2026-06-18)


### Features

* **sim:** управление сценариями симуляции из админки — CRUD ([#698](https://github.com/chatman-media/lead-engine/issues/698)) ([cb2a25d](https://github.com/chatman-media/lead-engine/commit/cb2a25dd5a90f8f754e5fee38ee9bac2a9d68b89))

# [@chatman-media/storage-v1.41.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.40.0...@chatman-media/storage-v1.41.0) (2026-06-18)


### Features

* **exchange,worker:** clearer funnel labels + cap proactive check-in pings ([7bcb8b8](https://github.com/chatman-media/lead-engine/commit/7bcb8b8dc2e7e8caf17edec3370470947728c59e))

# [@chatman-media/storage-v1.40.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.39.1...@chatman-media/storage-v1.40.0) (2026-06-16)


### Features

* **prompt:** director-хуки по стадии (applicableStages, как у skills) ([d256c96](https://github.com/chatman-media/lead-engine/commit/d256c9686cb9dbf90c9d2b79e443fe5b828bcccd)), closes [#676](https://github.com/chatman-media/lead-engine/issues/676)

# [@chatman-media/storage-v1.39.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.39.0...@chatman-media/storage-v1.39.1) (2026-06-15)


### Bug Fixes

* **exchange:** дублировать поля сделки на order_created/requisites_sent для re-quote ([d2673d1](https://github.com/chatman-media/lead-engine/commit/d2673d17c1bd01e25973544660a505a37637490d))

# [@chatman-media/storage-v1.39.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.38.0...@chatman-media/storage-v1.39.0) (2026-06-15)


### Features

* **operator-bot:** форум-топики — 1 топик на диалог ([#651](https://github.com/chatman-media/lead-engine/issues/651)) ([c075120](https://github.com/chatman-media/lead-engine/commit/c075120fa2cdbb14949f542c52cc3678811f5d0a)), closes [#32](https://github.com/chatman-media/lead-engine/issues/32) [#649](https://github.com/chatman-media/lead-engine/issues/649)

# [@chatman-media/storage-v1.38.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.37.1...@chatman-media/storage-v1.38.0) (2026-06-15)


### Features

* **operator-bot:** фундамент форум-топиков — bot-api + колонка диалога ([d06ae78](https://github.com/chatman-media/lead-engine/commit/d06ae7833de8b4dd9c5386b3cf3c1997e0b238a7))

# [@chatman-media/storage-v1.37.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.37.0...@chatman-media/storage-v1.37.1) (2026-06-15)


### Bug Fixes

* **exchange:** re-quote обновляет сделку (asset/amount на quote_calculated) — фикс «устаревшей сделки» ([50d1807](https://github.com/chatman-media/lead-engine/commit/50d1807bfe532be98ac21fe032d9a3511c61b2ce)), closes [#2](https://github.com/chatman-media/lead-engine/issues/2)

# [@chatman-media/storage-v1.37.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.36.0...@chatman-media/storage-v1.37.0) (2026-06-14)


### Bug Fixes

* **exchange:** сиды — payment_method в анкете вертикали, полнее payout, демо RUB ([8058be1](https://github.com/chatman-media/lead-engine/commit/8058be185d8ce7cf283889c791428f31409051e7))


### Features

* **exchange:** reply-слой берёт собранные поля из leadFieldValues (ctx) — Фаза 2a ([2a838da](https://github.com/chatman-media/lead-engine/commit/2a838da75a3f33f143718ee37a1baa2df276d18a))

# [@chatman-media/storage-v1.36.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.35.0...@chatman-media/storage-v1.36.0) (2026-06-14)


### Features

* **exchange:** тулы читают собранные поля воронки (leadFieldValues) — фаза 1 ([642d6ad](https://github.com/chatman-media/lead-engine/commit/642d6adf9ec8af1f986e6d9950c93786fb8a089f)), closes [642/#646](https://github.com/chatman-media/lead-engine/issues/646)

# [@chatman-media/storage-v1.35.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.34.0...@chatman-media/storage-v1.35.0) (2026-06-14)


### Features

* **bot:** раздел настроек поведения бота + 8 настроек (эпик [#623](https://github.com/chatman-media/lead-engine/issues/623)) ([56895b6](https://github.com/chatman-media/lead-engine/commit/56895b659b44db4d0a9861e805669ffcb2989bd7)), closes [#624](https://github.com/chatman-media/lead-engine/issues/624) [#625](https://github.com/chatman-media/lead-engine/issues/625) [#626](https://github.com/chatman-media/lead-engine/issues/626) [#628](https://github.com/chatman-media/lead-engine/issues/628) [#629](https://github.com/chatman-media/lead-engine/issues/629) [#631](https://github.com/chatman-media/lead-engine/issues/631) [#632](https://github.com/chatman-media/lead-engine/issues/632) [#633](https://github.com/chatman-media/lead-engine/issues/633) [#627](https://github.com/chatman-media/lead-engine/issues/627) [#630](https://github.com/chatman-media/lead-engine/issues/630)

# [@chatman-media/storage-v1.34.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.33.0...@chatman-media/storage-v1.34.0) (2026-06-14)


### Features

* **inbound:** обработка правок сообщений + настраиваемая пауза перед ответом ([dc8b117](https://github.com/chatman-media/lead-engine/commit/dc8b11741a0b3128d0f993234aff5d98dfce77b5))

# [@chatman-media/storage-v1.33.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.32.0...@chatman-media/storage-v1.33.0) (2026-06-13)


### Features

* **settings:** configurable bot context window (reply history limit) ([1951e12](https://github.com/chatman-media/lead-engine/commit/1951e1280acc06b6ab6bb2c466f62108a2b52c5a))

# [@chatman-media/storage-v1.32.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.31.1...@chatman-media/storage-v1.32.0) (2026-06-13)


### Features

* **exchange:** risk-review settings + engine (amount/first-deal/daily-limit) ([752950e](https://github.com/chatman-media/lead-engine/commit/752950eb0763a36d0436c8cfdd512ac641013013))

# [@chatman-media/storage-v1.31.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.31.0...@chatman-media/storage-v1.31.1) (2026-06-11)


### Bug Fixes

* **admin-ui:** open conversation notifications by target ([#586](https://github.com/chatman-media/lead-engine/issues/586)) ([c07f87e](https://github.com/chatman-media/lead-engine/commit/c07f87e97f88be116fdc23b76cf4f3bbc97c0ad5))

# [@chatman-media/storage-v1.31.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.30.0...@chatman-media/storage-v1.31.0) (2026-06-11)


### Features

* **exchange:** add silent auto handoff setting ([#571](https://github.com/chatman-media/lead-engine/issues/571)) ([7a961b5](https://github.com/chatman-media/lead-engine/commit/7a961b53306fb6b0b25d0141e04a42ca234cf430))

# [@chatman-media/storage-v1.30.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.29.1...@chatman-media/storage-v1.30.0) (2026-06-11)


### Features

* **exchange:** per-tenant quote currency (PHP default) + three-funnel client setup ([#552](https://github.com/chatman-media/lead-engine/issues/552)) ([a0afbe4](https://github.com/chatman-media/lead-engine/commit/a0afbe420791ef11e8bd90ccfba9c03065a67c45)), closes [#workflow](https://github.com/chatman-media/lead-engine/issues/workflow) [#services](https://github.com/chatman-media/lead-engine/issues/services)

# [@chatman-media/storage-v1.29.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.29.0...@chatman-media/storage-v1.29.1) (2026-06-10)


### Bug Fixes

* **storage:** scope uniq_kb_source_hash per tenant ([#548](https://github.com/chatman-media/lead-engine/issues/548)) ([286f33e](https://github.com/chatman-media/lead-engine/commit/286f33ea9bc05de0e5a7fbf81781eb17ce6827a5))

# [@chatman-media/storage-v1.29.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.28.0...@chatman-media/storage-v1.29.0) (2026-06-10)


### Features

* **partners:** partner settlement flow over partner_deals ([#545](https://github.com/chatman-media/lead-engine/issues/545)) ([d4e40a6](https://github.com/chatman-media/lead-engine/commit/d4e40a6e9454581fe32d82399b43eb3736dea8cc))

# [@chatman-media/storage-v1.28.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.27.0...@chatman-media/storage-v1.28.0) (2026-06-10)


### Features

* **provider-relay:** add rollout observability controls ([#471](https://github.com/chatman-media/lead-engine/issues/471)) ([207cd35](https://github.com/chatman-media/lead-engine/commit/207cd359eb095e70a08d6b31b9fb67e8f0dc8477))

# [@chatman-media/storage-v1.27.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.26.0...@chatman-media/storage-v1.27.0) (2026-06-10)


### Features

* **whatsapp:** enforce template outbound policy ([#463](https://github.com/chatman-media/lead-engine/issues/463)) ([9110933](https://github.com/chatman-media/lead-engine/commit/91109335196fda7a2c1e120350e13bb6321472fe))

# [@chatman-media/storage-v1.26.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.25.0...@chatman-media/storage-v1.26.0) (2026-06-10)


### Features

* **conversation-engine:** resolve conversations by channel ([#456](https://github.com/chatman-media/lead-engine/issues/456)) ([5c060c9](https://github.com/chatman-media/lead-engine/commit/5c060c944f973f019851740ac6c3c152759ed2a0))
* **quality:** promote tool proposals to regression cases ([#450](https://github.com/chatman-media/lead-engine/issues/450)) ([793e0ca](https://github.com/chatman-media/lead-engine/commit/793e0ca36d50be5a18e48ad9d3aa4d772009bb8f))

# [@chatman-media/storage-v1.25.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.24.0...@chatman-media/storage-v1.25.0) (2026-06-10)


### Features

* **conversation-engine:** add reactive operator bot previews ([#444](https://github.com/chatman-media/lead-engine/issues/444)) ([ced6e4d](https://github.com/chatman-media/lead-engine/commit/ced6e4ddd63bb6c607bee2627a1b290d605b78a8))
* **quality:** link tool proposals to artifacts ([#445](https://github.com/chatman-media/lead-engine/issues/445)) ([bf7e8c6](https://github.com/chatman-media/lead-engine/commit/bf7e8c6d89f9331e41206349c6f7b6a6439fc131))

# [@chatman-media/storage-v1.24.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.23.0...@chatman-media/storage-v1.24.0) (2026-06-09)


### Features

* **funnel:** add version history and rollback ([#439](https://github.com/chatman-media/lead-engine/issues/439)) ([ed51267](https://github.com/chatman-media/lead-engine/commit/ed51267af3d19e49f5fb47dcbd0b406f1171669c))
* **quality:** persist tool improvement proposals ([#433](https://github.com/chatman-media/lead-engine/issues/433)) ([ad3e1a7](https://github.com/chatman-media/lead-engine/commit/ad3e1a79c76320fe2446943d4145c8cdc71b97ae))

# [@chatman-media/storage-v1.23.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.22.0...@chatman-media/storage-v1.23.0) (2026-06-09)


### Bug Fixes

* **api:** make shadow eval queue durable ([#428](https://github.com/chatman-media/lead-engine/issues/428)) ([f3fba14](https://github.com/chatman-media/lead-engine/commit/f3fba148f06598a77063f9d2c1a83ebd302bf8c1))


### Features

* **kb:** store original uploaded files ([#431](https://github.com/chatman-media/lead-engine/issues/431)) ([1643ec3](https://github.com/chatman-media/lead-engine/commit/1643ec3ed3b2353e39e2f63d0592664fb1b9821e))

# [@chatman-media/storage-v1.22.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.21.0...@chatman-media/storage-v1.22.0) (2026-06-09)


### Features

* **conversation-engine:** add provider relay brokered orders ([#410](https://github.com/chatman-media/lead-engine/issues/410)) ([21305c8](https://github.com/chatman-media/lead-engine/commit/21305c83cbe640ee062b311c736659b28c916de6))

# [@chatman-media/storage-v1.21.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.20.0...@chatman-media/storage-v1.21.0) (2026-06-09)


### Bug Fixes

* **deploy:** ship early access landing ([#409](https://github.com/chatman-media/lead-engine/issues/409)) ([3a01000](https://github.com/chatman-media/lead-engine/commit/3a010003ff2543b5479f3076e0536fdbd7b767bf))


### Features

* **kb:** scope knowledge base by funnel stage ([#408](https://github.com/chatman-media/lead-engine/issues/408)) ([1c7ea02](https://github.com/chatman-media/lead-engine/commit/1c7ea02ca6afc6353eabd071e2c877e4775d65c6))

# [@chatman-media/storage-v1.20.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.19.0...@chatman-media/storage-v1.20.0) (2026-06-09)


### Features

* **api:** persist agentic tool telemetry ([#405](https://github.com/chatman-media/lead-engine/issues/405)) ([a27c336](https://github.com/chatman-media/lead-engine/commit/a27c336b25f55c7b74f9926eee5f3bab043e3a6b))

# [@chatman-media/storage-v1.19.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.18.0...@chatman-media/storage-v1.19.0) (2026-06-09)


### Features

* **channels:** add MAX messenger channel ([#360](https://github.com/chatman-media/lead-engine/issues/360)) ([3e57973](https://github.com/chatman-media/lead-engine/commit/3e579739840407462055fd809e43181dc0534445))

# [@chatman-media/storage-v1.18.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.17.0...@chatman-media/storage-v1.18.0) (2026-06-09)


### Features

* **channels:** add vk messenger channel ([#359](https://github.com/chatman-media/lead-engine/issues/359)) ([d4a43cc](https://github.com/chatman-media/lead-engine/commit/d4a43cc5ea653f523820bdc26a15f10b7294ce0e))

# [@chatman-media/storage-v1.17.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.16.0...@chatman-media/storage-v1.17.0) (2026-06-09)


### Features

* **api:** approve alpha early access requests ([#346](https://github.com/chatman-media/lead-engine/issues/346)) ([1f83ed2](https://github.com/chatman-media/lead-engine/commit/1f83ed2e4d5b0d385e1536e70b57e9267ce41c51))

# [@chatman-media/storage-v1.16.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.15.0...@chatman-media/storage-v1.16.0) (2026-06-09)


### Features

* **landing:** add alpha early access waitlist ([#343](https://github.com/chatman-media/lead-engine/issues/343)) ([583dba4](https://github.com/chatman-media/lead-engine/commit/583dba4e2c528cd907c6fb91994dad70e2f56320))

# [@chatman-media/storage-v1.15.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.14.0...@chatman-media/storage-v1.15.0) (2026-06-08)


### Features

* **saas:** add multi-business catalog and partner workflows ([#308](https://github.com/chatman-media/lead-engine/issues/308)) ([fd9317f](https://github.com/chatman-media/lead-engine/commit/fd9317fd9cb0f3772b69c71580cd92a8d6410198))

# [@chatman-media/storage-v1.14.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.13.0...@chatman-media/storage-v1.14.0) (2026-06-08)


### Features

* partner availability ping (stage webhook + Telegram) ([#295](https://github.com/chatman-media/lead-engine/issues/295)) ([628fa39](https://github.com/chatman-media/lead-engine/commit/628fa3911cc922f88eba3a9abedd6659b47c5f45))

# [@chatman-media/storage-v1.13.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.12.0...@chatman-media/storage-v1.13.0) (2026-06-07)


### Bug Fixes

* **storage:** update RLS table count 44→46 (outreach_campaigns migration 0039) ([4fcb50c](https://github.com/chatman-media/lead-engine/commit/4fcb50c5b66de45085594c7d4ad59ad0739c6179))


### Features

* **outreach:** drip campaign engine — leads → greeting at a rate ([#263](https://github.com/chatman-media/lead-engine/issues/263) C2/C3/C4/C5) ([#282](https://github.com/chatman-media/lead-engine/issues/282)) ([188dbfc](https://github.com/chatman-media/lead-engine/commit/188dbfca11a9148a981685212a6d98005fc5bf72))

# [@chatman-media/storage-v1.12.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.11.0...@chatman-media/storage-v1.12.0) (2026-06-06)


### Features

* **exchange:** real operator payout-code flow with push delivery + TTL ([#261](https://github.com/chatman-media/lead-engine/issues/261) A1) ([#273](https://github.com/chatman-media/lead-engine/issues/273)) ([4ee392f](https://github.com/chatman-media/lead-engine/commit/4ee392f05cd96f031c795b2a441dcfeb995ceae1))

# [@chatman-media/storage-v1.11.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.10.1...@chatman-media/storage-v1.11.0) (2026-06-06)


### Features

* **informer:** тихие часы (DND) + кнопка «Тест» + привязка к подключению ([#265](https://github.com/chatman-media/lead-engine/issues/265)) ([3d150c8](https://github.com/chatman-media/lead-engine/commit/3d150c886ad5370b10d1ba9edf2c7b469cf37886))

# [@chatman-media/storage-v1.10.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.10.0...@chatman-media/storage-v1.10.1) (2026-06-06)


### Bug Fixes

* **migrations:** перенумеровать 0032_admin_informer → 0036 (дубль номера ронял информер) ([#250](https://github.com/chatman-media/lead-engine/issues/250)) ([1856c83](https://github.com/chatman-media/lead-engine/commit/1856c8396c31c240e1224155711158aa20c9348f))

# [@chatman-media/storage-v1.10.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.9.0...@chatman-media/storage-v1.10.0) (2026-06-06)


### Features

* **exchange:** per-tenant частота обновления курсов + порог (Phase 1 backend) ([#234](https://github.com/chatman-media/lead-engine/issues/234)) ([1c80e3a](https://github.com/chatman-media/lead-engine/commit/1c80e3a018b9cc18ff232fa3d804ff738ff3ccfe))

# [@chatman-media/storage-v1.9.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.8.0...@chatman-media/storage-v1.9.0) (2026-06-06)


### Features

* **funnel:** per-stage goal/guidance — AI emits + persists (Phase 2 slice C-1) ([#208](https://github.com/chatman-media/lead-engine/issues/208)) ([aa44acd](https://github.com/chatman-media/lead-engine/commit/aa44acdf2d51e334c9ebe6aafe68e84c9e8a44c2))

# [@chatman-media/storage-v1.8.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.7.0...@chatman-media/storage-v1.8.0) (2026-06-06)


### Features

* **channels:** wire Facebook Messenger end-to-end (issue [#179](https://github.com/chatman-media/lead-engine/issues/179)) ([#203](https://github.com/chatman-media/lead-engine/issues/203)) ([18047ac](https://github.com/chatman-media/lead-engine/commit/18047ac522963c5b59834c174125082950d3a5e2)), closes [#181](https://github.com/chatman-media/lead-engine/issues/181)

# [@chatman-media/storage-v1.7.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.6.0...@chatman-media/storage-v1.7.0) (2026-06-06)


### Features

* **concierge:** вертикаль «Консьерж-сервис» — воронка как набор воркфлоу (Фаза 1 + Фаза 2) ([#180](https://github.com/chatman-media/lead-engine/issues/180)) ([16fce20](https://github.com/chatman-media/lead-engine/commit/16fce205ced728813d0cf7d0b63b17e24e0be423)), closes [#175](https://github.com/chatman-media/lead-engine/issues/175)

# [@chatman-media/storage-v1.6.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.5.0...@chatman-media/storage-v1.6.0) (2026-06-05)


### Features

* **notifications:** бот-информер владельца — уровни, дайджест, лента ([#182](https://github.com/chatman-media/lead-engine/issues/182)) ([5822964](https://github.com/chatman-media/lead-engine/commit/582296499270d47014078e7abfb91d76cec5a678))

# [@chatman-media/storage-v1.5.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.4.1...@chatman-media/storage-v1.5.0) (2026-06-05)


### Features

* **exchange:** онбординг + рефактор обмена + универсальный костяк воронки (phase) ([#160](https://github.com/chatman-media/lead-engine/issues/160)) ([3eed910](https://github.com/chatman-media/lead-engine/commit/3eed91030ec8b4d1f5644dff0d6122d5f67ad2b2))

# [@chatman-media/storage-v1.4.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.4.0...@chatman-media/storage-v1.4.1) (2026-06-03)


### Bug Fixes

* **storage:** allow video stage fields on legacy dbs ([865eb06](https://github.com/chatman-media/lead-engine/commit/865eb06eedc10179d14e7cbef9bf4fdcf9028e86))
* **verticals:** set funnels.vertical_template_id on install ([#141](https://github.com/chatman-media/lead-engine/issues/141)) ([c661a53](https://github.com/chatman-media/lead-engine/commit/c661a534e6f2c4d05e35831c823e4d048b95e5d5))

# [@chatman-media/storage-v1.4.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.3.0...@chatman-media/storage-v1.4.0) (2026-06-03)


### Bug Fixes

* **notifications:** migration, personal delivery, notifyOnAssignedOnly, tests ([63c53f9](https://github.com/chatman-media/lead-engine/commit/63c53f9fa328f31bc526eed9fcd2431118616730))
* **storage:** заменить глобальный unique(slug) на unique(tenant_id, slug) в skills ([#138](https://github.com/chatman-media/lead-engine/issues/138)) ([6191ada](https://github.com/chatman-media/lead-engine/commit/6191adad29e2021dc64c0813b331a8d33a00fadc))


### Features

* **conversations:** add operator inbox state ([1c608f6](https://github.com/chatman-media/lead-engine/commit/1c608f6c30c31b1d86e447ad7cd44d3915db1158))
* **exchange:** add approved rate tiers and payment rails ([e1fe071](https://github.com/chatman-media/lead-engine/commit/e1fe0711f58542925e987929cf975f5a01a39773))
* **exchange:** core infrastructure (models, tools, providers, migrations) ([75f84d7](https://github.com/chatman-media/lead-engine/commit/75f84d74b4a95d1ce486eb2428862d52d81c3ebc))
* **notifications:** group onboarding via /setup <token> (п.1) ([a186929](https://github.com/chatman-media/lead-engine/commit/a18692905d1aef1078465c9434acabd5e9f77c48))

# [@chatman-media/storage-v1.3.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.2.0...@chatman-media/storage-v1.3.0) (2026-05-25)


### Features

* GTM — billing auto-suspend, superadmin panel, usage alerts, reranker pipeline ([#128](https://github.com/chatman-media/lead-engine/issues/128)) ([cd5ee44](https://github.com/chatman-media/lead-engine/commit/cd5ee440a336eb9f29e7988935f6b352b558759d))

# [@chatman-media/storage-v1.2.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.1.0...@chatman-media/storage-v1.2.0) (2026-05-24)


### Features

* **auth:** forgot-password flow + team invite email ([#118](https://github.com/chatman-media/lead-engine/issues/118)) ([14f918f](https://github.com/chatman-media/lead-engine/commit/14f918f603593bfd59a84ddb3b3df73670cae801))
* **outreach:** batch message campaigns ([#108](https://github.com/chatman-media/lead-engine/issues/108)) ([48f9406](https://github.com/chatman-media/lead-engine/commit/48f94068cc41154a6a4b6cb7e63dd0202cbda90b))
* **templates:** message templates for outreach campaigns ([#116](https://github.com/chatman-media/lead-engine/issues/116)) ([489f15d](https://github.com/chatman-media/lead-engine/commit/489f15d43f2365fc2dc5d6c88dc2b5bf03cd14b3))

# [@chatman-media/storage-v1.1.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.0.1...@chatman-media/storage-v1.1.0) (2026-05-23)


### Features

* **gtm:** partner referral codes, recruitment_generic template, dashboard closures metric ([#89](https://github.com/chatman-media/lead-engine/issues/89)) ([b6384c6](https://github.com/chatman-media/lead-engine/commit/b6384c61793567e6143aba7bdc157feea0c88b71))

# [@chatman-media/storage-v1.0.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/storage-v1.0.0...@chatman-media/storage-v1.0.1) (2026-05-23)


### Bug Fixes

* **migrations:** add DROP POLICY IF EXISTS before CREATE POLICY ([#85](https://github.com/chatman-media/lead-engine/issues/85)) ([29a4d59](https://github.com/chatman-media/lead-engine/commit/29a4d59d4674c134d837a511dc709f3afd48a243))

# @chatman-media/storage-v1.0.0 (2026-05-23)


### Bug Fixes

* **release:** publish via bun instead of @semantic-release/npm (workspace: protocol) ([#66](https://github.com/chatman-media/lead-engine/issues/66)) ([942c3f9](https://github.com/chatman-media/lead-engine/commit/942c3f9a9f46f00b5cdb416d26303375bc20a7d6))


### Features

* admin-routes integration tests (14 tests) + expose storage integration helpers ([884b58e](https://github.com/chatman-media/lead-engine/commit/884b58ec46f8127abce1dfa7a4b3f8956f60200f))
* **api,admin-ui:** multi-admin invite flow (Q3'26 M4) ([6222764](https://github.com/chatman-media/lead-engine/commit/6222764a714cf1d6a59822b53592f893a70c86d5))
* **api,admin-ui:** per-tenant LLM usage tracking (calls/latency/errors) ([92f8627](https://github.com/chatman-media/lead-engine/commit/92f86279447aa82dce98b14ac61d36bbf40b3732))
* horizontal scaling — SKIP LOCKED claim + stuck recovery (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / M) ([26228a6](https://github.com/chatman-media/lead-engine/commit/26228a605f53b39e9c936be3395d8b1e0d99f326))
* migration 0007 — переключить conversations/leads/questionnaire_tokens FK на contacts + reset-script ([841e059](https://github.com/chatman-media/lead-engine/commit/841e0594cc1885dcafd844430d90eaf79df742e7))
* Persuasion Engine + bot wiring + roadmap features ([#83](https://github.com/chatman-media/lead-engine/issues/83)) ([c0ba642](https://github.com/chatman-media/lead-engine/commit/c0ba642d659ac8f0c09683b3980f089f509235c0))
* RLS contract validation + boot-time enforcement check ([7d68777](https://github.com/chatman-media/lead-engine/commit/7d68777d3b1e24bde23ba9fa9b1bcb0e737b41cf))
* **storage:** integration tests миграций через живой PG + cleanup CI (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / Q) ([cf71184](https://github.com/chatman-media/lead-engine/commit/cf711849674ed9048c3a98e5fd20f6665b3fbbbc))
* **storage:** multi-tenant фундамент — 8 новых таблиц + legacy tenant seed (Этап 6, часть 1) ([e5885bf](https://github.com/chatman-media/lead-engine/commit/e5885bf8ce94b89f6f6747af9c2fe702ae9f4cb9))
* **storage:** RLS-policies + withTenant helper (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / D) ([87da5e2](https://github.com/chatman-media/lead-engine/commit/87da5e2d8db03037864a0908fab6f4146614df50))
* **storage:** tenant_id во всех 28 существующих таблицах (Этап 6, часть 2) ([5893a9d](https://github.com/chatman-media/lead-engine/commit/5893a9d992999ea314870c1c6b291d4a16935973))
* **storage:** миграция 0003 — backfill users → contacts + channel_identities (Этап 8, часть 2) ([bf56a2e](https://github.com/chatman-media/lead-engine/commit/bf56a2e68d99c11189781e9081a45483e8ed0eae))
* **storage:** расширить schema до полной модели sales-guru (Этап 1) ([bfa982a](https://github.com/chatman-media/lead-engine/commit/bfa982a670cd833340edba03f164b82508e680ec))
* Stripe billing — migration 0006 + signature verify + webhook handler (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / O) ([25fada7](https://github.com/chatman-media/lead-engine/commit/25fada7a22a95a43e264c61818700571a0148d17))
* universal lead pipeline — configurable stages, fields & admin UI ([#72](https://github.com/chatman-media/lead-engine/issues/72)) ([0a8f7a6](https://github.com/chatman-media/lead-engine/commit/0a8f7a6e5a7096a627d916d005872cd3b58b9eb6))
