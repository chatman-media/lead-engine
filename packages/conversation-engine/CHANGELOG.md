# [@chatman-media/conversation-engine-v3.1.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v3.1.0...@chatman-media/conversation-engine-v3.1.1) (2026-06-10)


### Bug Fixes

* **storage:** scope uniq_kb_source_hash per tenant ([#548](https://github.com/chatman-media/lead-engine/issues/548)) ([286f33e](https://github.com/chatman-media/lead-engine/commit/286f33ea9bc05de0e5a7fbf81781eb17ce6827a5))

# [@chatman-media/conversation-engine-v3.1.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v3.0.0...@chatman-media/conversation-engine-v3.1.0) (2026-06-10)


### Features

* **exchange:** add runtime response guard contract ([#526](https://github.com/chatman-media/lead-engine/issues/526)) ([438d99e](https://github.com/chatman-media/lead-engine/commit/438d99eb464e99d101428d2488daf2d1437237bd))

# [@chatman-media/conversation-engine-v3.0.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v2.1.0...@chatman-media/conversation-engine-v3.0.0) (2026-06-10)


* feat(kb)!: прунинг LLM-шагов answerWithRag по результатам замера ([#515](https://github.com/chatman-media/lead-engine/issues/515)) ([#523](https://github.com/chatman-media/lead-engine/issues/523)) ([e5e75f3](https://github.com/chatman-media/lead-engine/commit/e5e75f3f07be06bad982a3290e5664d61ae14a8e))


### BREAKING CHANGES

* дефолт rewriteQueryBeforeRetrieval в RagReplyStrategy
сменился с true на false; для прежнего поведения передайте флаг явно.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [@chatman-media/conversation-engine-v2.1.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v2.0.0...@chatman-media/conversation-engine-v2.1.0) (2026-06-10)


### Features

* **exchange:** create actionable operator handoffs ([#522](https://github.com/chatman-media/lead-engine/issues/522)) ([1b9d40f](https://github.com/chatman-media/lead-engine/commit/1b9d40f29e37142928770ad4957b8fe6cf5ad23d))

# [@chatman-media/conversation-engine-v2.0.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.28.1...@chatman-media/conversation-engine-v2.0.0) (2026-06-10)


* refactor(conversation-engine)!: consolidate RagReplyStrategy resolvers into loadTurnContext ([#518](https://github.com/chatman-media/lead-engine/issues/518)) ([fcaf51c](https://github.com/chatman-media/lead-engine/commit/fcaf51cfeb162f720d2a4e015f3d938b4fb94f9e)), closes [#514](https://github.com/chatman-media/lead-engine/issues/514)


### BREAKING CHANGES

* RagReplyStrategyOpts больше не принимает resolve*-колбэки;
вместо них обязательный loadTurnContext. Конструктор RagReplyStrategy
одноаргументный.

Co-authored-by: Claude Fable 5 <noreply@anthropic.com>

# [@chatman-media/conversation-engine-v1.28.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.28.0...@chatman-media/conversation-engine-v1.28.1) (2026-06-10)


### Bug Fixes

* **conversation-engine:** avoid exchange intent redos ([#501](https://github.com/chatman-media/lead-engine/issues/501)) ([51e7444](https://github.com/chatman-media/lead-engine/commit/51e74440128c7eb864cb4426ea9a3fbddad99ce6))

# [@chatman-media/conversation-engine-v1.28.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.27.0...@chatman-media/conversation-engine-v1.28.0) (2026-06-10)


### Bug Fixes

* **provider-relay:** gate console outreach by feature flag ([#476](https://github.com/chatman-media/lead-engine/issues/476)) ([113ba42](https://github.com/chatman-media/lead-engine/commit/113ba4281ddfd77f595ec0df0d50b3090ed1fef0))


### Features

* **api:** add provider relay ops controls ([#472](https://github.com/chatman-media/lead-engine/issues/472)) ([8746d4e](https://github.com/chatman-media/lead-engine/commit/8746d4eca9d7cfe1b44b26249958ec0e31698a5b))
* **platform:** add provider order console ([#469](https://github.com/chatman-media/lead-engine/issues/469)) ([a1d286f](https://github.com/chatman-media/lead-engine/commit/a1d286f124cd54680484b8da8c8439a46f82017a))
* **provider-relay:** add rollout observability controls ([#471](https://github.com/chatman-media/lead-engine/issues/471)) ([207cd35](https://github.com/chatman-media/lead-engine/commit/207cd359eb095e70a08d6b31b9fb67e8f0dc8477))

# [@chatman-media/conversation-engine-v1.27.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.26.0...@chatman-media/conversation-engine-v1.27.0) (2026-06-10)


### Features

* **kb:** seed text-only vertical docs ([#462](https://github.com/chatman-media/lead-engine/issues/462)) ([392f591](https://github.com/chatman-media/lead-engine/commit/392f5916baa69b682e979586274d746b138149aa))
* **whatsapp:** enforce template outbound policy ([#463](https://github.com/chatman-media/lead-engine/issues/463)) ([9110933](https://github.com/chatman-media/lead-engine/commit/91109335196fda7a2c1e120350e13bb6321472fe))

# [@chatman-media/conversation-engine-v1.26.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.25.0...@chatman-media/conversation-engine-v1.26.0) (2026-06-10)


### Bug Fixes

* **conversation-engine:** harden exchange bot quote flow ([#459](https://github.com/chatman-media/lead-engine/issues/459)) ([6c11c83](https://github.com/chatman-media/lead-engine/commit/6c11c8343df2a1080b4251a1928a6ba30947d906))


### Features

* **conversation-engine:** resolve conversations by channel ([#456](https://github.com/chatman-media/lead-engine/issues/456)) ([5c060c9](https://github.com/chatman-media/lead-engine/commit/5c060c944f973f019851740ac6c3c152759ed2a0))

# [@chatman-media/conversation-engine-v1.25.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.24.0...@chatman-media/conversation-engine-v1.25.0) (2026-06-10)


### Features

* **conversation-engine:** add reactive operator bot previews ([#444](https://github.com/chatman-media/lead-engine/issues/444)) ([ced6e4d](https://github.com/chatman-media/lead-engine/commit/ced6e4ddd63bb6c607bee2627a1b290d605b78a8))

# [@chatman-media/conversation-engine-v1.24.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.23.0...@chatman-media/conversation-engine-v1.24.0) (2026-06-09)


### Features

* **conversation-engine:** add operator bot action callbacks ([#436](https://github.com/chatman-media/lead-engine/issues/436)) ([6f8085f](https://github.com/chatman-media/lead-engine/commit/6f8085f8046ed03f5b9278c172272bd7d919fa0c))

# [@chatman-media/conversation-engine-v1.23.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.22.0...@chatman-media/conversation-engine-v1.23.0) (2026-06-09)


### Features

* **api:** route reply templates per tenant ([#437](https://github.com/chatman-media/lead-engine/issues/437)) ([86082e8](https://github.com/chatman-media/lead-engine/commit/86082e81fd16e1cc8539b18b15692a2c7df8eaa3))

# [@chatman-media/conversation-engine-v1.22.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.21.0...@chatman-media/conversation-engine-v1.22.0) (2026-06-09)


### Features

* **conversation-engine:** enforce exchange policy guard in replies ([#427](https://github.com/chatman-media/lead-engine/issues/427)) ([dd2e759](https://github.com/chatman-media/lead-engine/commit/dd2e75958486df3cfe586c79a742080ef4bf01c6))

# [@chatman-media/conversation-engine-v1.21.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.20.0...@chatman-media/conversation-engine-v1.21.0) (2026-06-09)


### Features

* **conversation-engine:** add exchange policy guard ([#426](https://github.com/chatman-media/lead-engine/issues/426)) ([275c411](https://github.com/chatman-media/lead-engine/commit/275c411aa35e3589cbfe539df42b0e72ce0bea90))

# [@chatman-media/conversation-engine-v1.20.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.19.0...@chatman-media/conversation-engine-v1.20.0) (2026-06-09)


### Features

* **conversation-engine:** add provider relay brokered orders ([#410](https://github.com/chatman-media/lead-engine/issues/410)) ([21305c8](https://github.com/chatman-media/lead-engine/commit/21305c83cbe640ee062b311c736659b28c916de6))

# [@chatman-media/conversation-engine-v1.19.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.18.0...@chatman-media/conversation-engine-v1.19.0) (2026-06-09)


### Bug Fixes

* **api:** split inbound post-processing transactions ([#406](https://github.com/chatman-media/lead-engine/issues/406)) ([74c563d](https://github.com/chatman-media/lead-engine/commit/74c563d5b83890c5dce0d157be354cc91a7456a3))


### Features

* **kb:** scope knowledge base by funnel stage ([#408](https://github.com/chatman-media/lead-engine/issues/408)) ([1c7ea02](https://github.com/chatman-media/lead-engine/commit/1c7ea02ca6afc6353eabd071e2c877e4775d65c6))
* **outreach:** add operator broadcasts ([#407](https://github.com/chatman-media/lead-engine/issues/407)) ([914dd30](https://github.com/chatman-media/lead-engine/commit/914dd30a037aa44d2df44c1684c899812933ce72))

# [@chatman-media/conversation-engine-v1.18.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.17.1...@chatman-media/conversation-engine-v1.18.0) (2026-06-09)


### Features

* **api:** persist agentic tool telemetry ([#405](https://github.com/chatman-media/lead-engine/issues/405)) ([a27c336](https://github.com/chatman-media/lead-engine/commit/a27c336b25f55c7b74f9926eee5f3bab043e3a6b))

# [@chatman-media/conversation-engine-v1.17.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.17.0...@chatman-media/conversation-engine-v1.17.1) (2026-06-09)


### Bug Fixes

* **api:** transcribe voice before tenant transactions ([#401](https://github.com/chatman-media/lead-engine/issues/401)) ([81abacf](https://github.com/chatman-media/lead-engine/commit/81abacfb7c30fd8999f63ecc76838348b439f96e))

# [@chatman-media/conversation-engine-v1.17.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.16.0...@chatman-media/conversation-engine-v1.17.0) (2026-06-09)


### Features

* **channels:** add MAX messenger channel ([#360](https://github.com/chatman-media/lead-engine/issues/360)) ([3e57973](https://github.com/chatman-media/lead-engine/commit/3e579739840407462055fd809e43181dc0534445))

# [@chatman-media/conversation-engine-v1.16.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.15.0...@chatman-media/conversation-engine-v1.16.0) (2026-06-09)


### Features

* **channels:** add vk messenger channel ([#359](https://github.com/chatman-media/lead-engine/issues/359)) ([d4a43cc](https://github.com/chatman-media/lead-engine/commit/d4a43cc5ea653f523820bdc26a15f10b7294ce0e))

# [@chatman-media/conversation-engine-v1.15.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.14.0...@chatman-media/conversation-engine-v1.15.0) (2026-06-09)


### Features

* **api:** persist experiment style assignments ([#344](https://github.com/chatman-media/lead-engine/issues/344)) ([7d47573](https://github.com/chatman-media/lead-engine/commit/7d4757363b00635288d33a32fdf37c6bab6564de))

# [@chatman-media/conversation-engine-v1.14.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.13.0...@chatman-media/conversation-engine-v1.14.0) (2026-06-08)


### Features

* **saas:** add multi-business catalog and partner workflows ([#308](https://github.com/chatman-media/lead-engine/issues/308)) ([fd9317f](https://github.com/chatman-media/lead-engine/commit/fd9317fd9cb0f3772b69c71580cd92a8d6410198))

# [@chatman-media/conversation-engine-v1.13.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.12.1...@chatman-media/conversation-engine-v1.13.0) (2026-06-08)


### Features

* **verticals:** add visa_v1 + scooter_v1 vertical packages ([#293](https://github.com/chatman-media/lead-engine/issues/293)) ([0feef4b](https://github.com/chatman-media/lead-engine/commit/0feef4b8613a8f576864776ecafa9c758d1d47f3)), closes [#187](https://github.com/chatman-media/lead-engine/issues/187)

# [@chatman-media/conversation-engine-v1.12.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.12.0...@chatman-media/conversation-engine-v1.12.1) (2026-06-07)


### Bug Fixes

* **test:** cast experiment stub to any to satisfy ExperimentRow type ([c593a6f](https://github.com/chatman-media/lead-engine/commit/c593a6f785f29a606200dd05d80e324c0a11dc4c))

# [@chatman-media/conversation-engine-v1.12.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.11.0...@chatman-media/conversation-engine-v1.12.0) (2026-06-07)


### Features

* **exchange:** add reflect fallback and self-play judge ([#291](https://github.com/chatman-media/lead-engine/issues/291)) ([d52651f](https://github.com/chatman-media/lead-engine/commit/d52651fd0aa9fdc178f4ddb7d79284eeb951609a))

# [@chatman-media/conversation-engine-v1.11.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.10.0...@chatman-media/conversation-engine-v1.11.0) (2026-06-07)


### Features

* **concierge:** Фаза 3 — domain action tools + catalog admin ([#175](https://github.com/chatman-media/lead-engine/issues/175)) ([#289](https://github.com/chatman-media/lead-engine/issues/289)) ([a75d8a4](https://github.com/chatman-media/lead-engine/commit/a75d8a43c621725af804fa4800e4fee62142f6ea))

# [@chatman-media/conversation-engine-v1.10.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.9.0...@chatman-media/conversation-engine-v1.10.0) (2026-06-06)


### Features

* **informer:** тихие часы (DND) + кнопка «Тест» + привязка к подключению ([#265](https://github.com/chatman-media/lead-engine/issues/265)) ([3d150c8](https://github.com/chatman-media/lead-engine/commit/3d150c886ad5370b10d1ba9edf2c7b469cf37886))

# [@chatman-media/conversation-engine-v1.9.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.8.0...@chatman-media/conversation-engine-v1.9.0) (2026-06-06)


### Features

* **ops:** продвижение лида со страницы лида + пинг оператору на operator-гейте ([#243](https://github.com/chatman-media/lead-engine/issues/243)) ([34aee02](https://github.com/chatman-media/lead-engine/commit/34aee0242093c59b300c617ee70e923818b64dbb))

# [@chatman-media/conversation-engine-v1.8.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.7.0...@chatman-media/conversation-engine-v1.8.0) (2026-06-06)


### Features

* **sim:** dialog simulator — LLM «клиент» ведёт self_play-диалог в живом инбоксе ([#233](https://github.com/chatman-media/lead-engine/issues/233)) ([180c1a1](https://github.com/chatman-media/lead-engine/commit/180c1a1e2f904190a59360cd4e1276592cf17074))

# [@chatman-media/conversation-engine-v1.7.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.6.0...@chatman-media/conversation-engine-v1.7.0) (2026-06-06)


### Features

* **reply:** конвергенция R4+R5 — request_type в промпте + awaiting_operator (+ почин [#211](https://github.com/chatman-media/lead-engine/issues/211)) ([#225](https://github.com/chatman-media/lead-engine/issues/225)) ([e8619eb](https://github.com/chatman-media/lead-engine/commit/e8619ebcf21a16c4541307d1f4627c90bf9f7c79))

# [@chatman-media/conversation-engine-v1.6.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.5.0...@chatman-media/conversation-engine-v1.6.0) (2026-06-06)


### Features

* **reply:** bot uses per-stage goal/guidance (Phase 2 slice C-2) ([#211](https://github.com/chatman-media/lead-engine/issues/211)) ([dcd8dbc](https://github.com/chatman-media/lead-engine/commit/dcd8dbc20ec43afa39bb846693016362cfd76e4c))

# [@chatman-media/conversation-engine-v1.5.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.4.0...@chatman-media/conversation-engine-v1.5.0) (2026-06-06)


### Features

* **channels:** wire Facebook Messenger end-to-end (issue [#179](https://github.com/chatman-media/lead-engine/issues/179)) ([#203](https://github.com/chatman-media/lead-engine/issues/203)) ([18047ac](https://github.com/chatman-media/lead-engine/commit/18047ac522963c5b59834c174125082950d3a5e2)), closes [#181](https://github.com/chatman-media/lead-engine/issues/181)

# [@chatman-media/conversation-engine-v1.4.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.3.1...@chatman-media/conversation-engine-v1.4.0) (2026-06-06)


### Features

* **concierge:** вертикаль «Консьерж-сервис» — воронка как набор воркфлоу (Фаза 1 + Фаза 2) ([#180](https://github.com/chatman-media/lead-engine/issues/180)) ([16fce20](https://github.com/chatman-media/lead-engine/commit/16fce205ced728813d0cf7d0b63b17e24e0be423)), closes [#175](https://github.com/chatman-media/lead-engine/issues/175)

# [@chatman-media/conversation-engine-v1.3.1](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.3.0...@chatman-media/conversation-engine-v1.3.1) (2026-06-05)


### Bug Fixes

* **security:** resolve CodeQL code-scanning alerts (ReDoS, biased RNG, XSS, log/url) ([#184](https://github.com/chatman-media/lead-engine/issues/184)) ([a68bd16](https://github.com/chatman-media/lead-engine/commit/a68bd16ebf54b8ccb283a1f41c945e091cc3cd1d)), closes [js/xss-throu#dom](https://github.com/js/xss-throu/issues/dom)

# [@chatman-media/conversation-engine-v1.3.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.2.0...@chatman-media/conversation-engine-v1.3.0) (2026-06-05)


### Features

* **notifications:** бот-информер владельца — уровни, дайджест, лента ([#182](https://github.com/chatman-media/lead-engine/issues/182)) ([5822964](https://github.com/chatman-media/lead-engine/commit/582296499270d47014078e7abfb91d76cec5a678))

# [@chatman-media/conversation-engine-v1.2.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.1.0...@chatman-media/conversation-engine-v1.2.0) (2026-06-03)


### Bug Fixes

* **conversation-engine:** allow missing lead assignee ([729144e](https://github.com/chatman-media/lead-engine/commit/729144e09edf1eb2c80457a45cad81100045f7e5))
* **notifications:** migration, personal delivery, notifyOnAssignedOnly, tests ([63c53f9](https://github.com/chatman-media/lead-engine/commit/63c53f9fa328f31bc526eed9fcd2431118616730))
* **notifications:** show bot deep link, fix partial settings update ([9a6d7ec](https://github.com/chatman-media/lead-engine/commit/9a6d7ec6a089d531a5392affbd688d3222b1da80))
* resolve channel-telegram TDZ crash on API startup ([d1390b4](https://github.com/chatman-media/lead-engine/commit/d1390b46b69858100d0a44acfc61c4a805186224))


### Features

* **conversations:** add operator inbox state ([1c608f6](https://github.com/chatman-media/lead-engine/commit/1c608f6c30c31b1d86e447ad7cd44d3915db1158))
* **exchange:** core infrastructure (models, tools, providers, migrations) ([75f84d7](https://github.com/chatman-media/lead-engine/commit/75f84d74b4a95d1ce486eb2428862d52d81c3ebc))
* GTM — billing auto-suspend, superadmin panel, usage alerts, reranker pipeline ([#128](https://github.com/chatman-media/lead-engine/issues/128)) ([cd5ee44](https://github.com/chatman-media/lead-engine/commit/cd5ee440a336eb9f29e7988935f6b352b558759d))
* **notifications:** group onboarding via /setup <token> (п.1) ([a186929](https://github.com/chatman-media/lead-engine/commit/a18692905d1aef1078465c9434acabd5e9f77c48))
* **notifications:** test button per rule + message templates UI (п.3 + п.4) ([1bff32d](https://github.com/chatman-media/lead-engine/commit/1bff32dc7f89bd7d955b192f29394f4c02478d04))

# [@chatman-media/conversation-engine-v1.1.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/conversation-engine-v1.0.0...@chatman-media/conversation-engine-v1.1.0) (2026-05-24)


### Features

* retrieval refactor, per-plan rate limits, soft fallback, conversation compaction ([#125](https://github.com/chatman-media/lead-engine/issues/125)) ([4276dec](https://github.com/chatman-media/lead-engine/commit/4276decd27ae6ba323d1ad05d937612ff4acd13d)), closes [#118-123](https://github.com/chatman-media/lead-engine/issues/118-123)

# @chatman-media/conversation-engine-v1.0.0 (2026-05-24)


### Bug Fixes

* **conversation-engine:** claimPending теряла camelCase mapping → dispatcher всегда ловил no_adapter ([771c3de](https://github.com/chatman-media/lead-engine/commit/771c3de79c21955d8228362f46483e30961feee1))
* enable PDF upload in admin-ui + update stale process-inbound comment ([#52](https://github.com/chatman-media/lead-engine/issues/52)) ([39bb866](https://github.com/chatman-media/lead-engine/commit/39bb866b4f06f981d05e5955a32054e4b0c3dea9))
* **release:** publish via bun instead of @semantic-release/npm (workspace: protocol) ([#66](https://github.com/chatman-media/lead-engine/issues/66)) ([942c3f9](https://github.com/chatman-media/lead-engine/commit/942c3f9a9f46f00b5cdb416d26303375bc20a7d6))
* **sales:** LlmStageClassifier multi-tenant — accept tenantId на classify() call ([d974588](https://github.com/chatman-media/lead-engine/commit/d974588eef0a1d4bb63c952c8d8869cfb3213cd8))


### Features

* A/B routing — ExperimentsRepo + ABRouter wire-up (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / J) ([2d33c48](https://github.com/chatman-media/lead-engine/commit/2d33c48b66bfec205257c5ae76c2a228aef67c64))
* AI field extraction, funnel seed templates, lead UI, billing dashboard ([#73](https://github.com/chatman-media/lead-engine/issues/73)) ([8bb7187](https://github.com/chatman-media/lead-engine/commit/8bb71876d2e90224be029c87d4dd859a2b5671ad))
* **apps/api:** admin-API routes skeleton + tenant-context wire-up (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / S) ([f4dd99d](https://github.com/chatman-media/lead-engine/commit/f4dd99df592327426af4b3f6d4befd126b226767))
* **conversation-engine:** AES-256-GCM шифрование tenant_secrets (Этап 8, часть 1) ([2706047](https://github.com/chatman-media/lead-engine/commit/2706047aacbdc0b3a23d989c675e88b28d1e3563))
* **conversation-engine:** coach feedback — CoachAnalyzer + SkillOutcomesRepo (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / K) ([f094dcf](https://github.com/chatman-media/lead-engine/commit/f094dcfd443371c72225c791a3a95077ca891cc2))
* **conversation-engine:** DrizzleKbStore — tenant-scoped IKbStore (Этап 4, часть 2c-1) ([bbd4f5b](https://github.com/chatman-media/lead-engine/commit/bbd4f5b283642db959a87d97d0b7cdac8adf4d29))
* **conversation-engine:** extractFields hook integration (Этап 4, часть 2c-3a) ([ea5d7a2](https://github.com/chatman-media/lead-engine/commit/ea5d7a2731c825d0a7c7e141ee6e35798dbee424))
* **conversation-engine:** Lead lifecycle + funnel state machine (Этап 4, часть 2a) ([f840556](https://github.com/chatman-media/lead-engine/commit/f840556f70ea81991a481fa1acb9fa5883b683c5))
* **conversation-engine:** LlmReplyStrategy — минимальная LLM-генерация ответов (Этап 4, часть 2b) ([836afc4](https://github.com/chatman-media/lead-engine/commit/836afc46354e5ccc4f1eef5eb7af99177baf6346))
* **conversation-engine:** pipeline-каркас inbound → outbound (Этап 4, часть 1) ([e253d9d](https://github.com/chatman-media/lead-engine/commit/e253d9d1fa22d00390fd0084490f9a05f02c2cee))
* **conversation-engine:** sales-style resolver в RagReplyStrategy (Этап 4, часть 2c-3c) ([6753911](https://github.com/chatman-media/lead-engine/commit/6753911745658e39bd4d822f581bfcd9f89dd3ab))
* **conversation-engine:** Stage classifier — RegexStageClassifier + LlmStageClassifier (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / L) ([5296dc9](https://github.com/chatman-media/lead-engine/commit/5296dc98fc7079a78a05b4ffdfa5794ad37825ec))
* **dispatcher:** claimPending принимает kinds whitelist — worker не трогает web rows ([a498bde](https://github.com/chatman-media/lead-engine/commit/a498bdeab0a09a52f99432436f68393005dc8bc0))
* GTM phase 1 — referral codes, sales bot, agentic booking tool ([#90](https://github.com/chatman-media/lead-engine/issues/90)) ([1bf8e4f](https://github.com/chatman-media/lead-engine/commit/1bf8e4f5ca2ca6cb70cf3de133aab4d8e523d7b4))
* horizontal scaling — SKIP LOCKED claim + stuck recovery (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / M) ([26228a6](https://github.com/chatman-media/lead-engine/commit/26228a605f53b39e9c936be3395d8b1e0d99f326))
* LLM memory extraction через rag.extractUserFacts (Этап 4, часть 2c-3b) ([01a8e9b](https://github.com/chatman-media/lead-engine/commit/01a8e9b9b531a6fd042c3b57fe39ef8c6dff1ddd))
* MCP server, Ollama onboarding, vertical plugin install ([#104](https://github.com/chatman-media/lead-engine/issues/104)) ([563e930](https://github.com/chatman-media/lead-engine/commit/563e9306dedfd781cf74cd6fc5a7c6cf579fa165))
* Persuasion Engine + bot wiring + roadmap features ([#83](https://github.com/chatman-media/lead-engine/issues/83)) ([c0ba642](https://github.com/chatman-media/lead-engine/commit/c0ba642d659ac8f0c09683b3980f089f509235c0))
* RagReplyStrategy + wire-up в apps/api (Этап 4, часть 2c-2) ([0fab0d4](https://github.com/chatman-media/lead-engine/commit/0fab0d49fd6f707ffad83d18500ee0649e86f9c9))
* RLS contract validation + boot-time enforcement check ([7d68777](https://github.com/chatman-media/lead-engine/commit/7d68777d3b1e24bde23ba9fa9b1bcb0e737b41cf))
* **storage:** RLS-policies + withTenant helper (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / D) ([87da5e2](https://github.com/chatman-media/lead-engine/commit/87da5e2d8db03037864a0908fab6f4146614df50))
* **support-mode:** bot goes silent when lead stage has supportMode=true ([1692ad0](https://github.com/chatman-media/lead-engine/commit/1692ad001ad97d7535d824286796c2d0a62da290))
* **voice:** Whisper STT транскрипция голосовых сообщений ([#105](https://github.com/chatman-media/lead-engine/issues/105)) ([80e1b27](https://github.com/chatman-media/lead-engine/commit/80e1b279ab0bb442230372897bebe45797a0c5b8))
* **voice:** охват всех каналов + отображение в UI ([#107](https://github.com/chatman-media/lead-engine/issues/107)) ([74df733](https://github.com/chatman-media/lead-engine/commit/74df733b1286bc2ad69a4b0178065c551aba536e))
