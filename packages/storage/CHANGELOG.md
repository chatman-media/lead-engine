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
