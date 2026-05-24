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
