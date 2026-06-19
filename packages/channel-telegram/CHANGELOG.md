# [@chatman-media/channel-telegram-v1.10.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.9.0...@chatman-media/channel-telegram-v1.10.0) (2026-06-19)


### Features

* **i18n:** plumb telegram language_code via Inbound.channelLangHint ([f79ca3d](https://github.com/chatman-media/lead-engine/commit/f79ca3d5025c871833c4282a94606b880b231194)), closes [#735](https://github.com/chatman-media/lead-engine/issues/735)

# [@chatman-media/channel-telegram-v1.9.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.8.0...@chatman-media/channel-telegram-v1.9.0) (2026-06-15)


### Features

* **operator-bot:** форум-топики — 1 топик на диалог ([#651](https://github.com/chatman-media/lead-engine/issues/651)) ([c075120](https://github.com/chatman-media/lead-engine/commit/c075120fa2cdbb14949f542c52cc3678811f5d0a)), closes [#32](https://github.com/chatman-media/lead-engine/issues/32) [#649](https://github.com/chatman-media/lead-engine/issues/649)

# [@chatman-media/channel-telegram-v1.8.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.7.0...@chatman-media/channel-telegram-v1.8.0) (2026-06-15)


### Features

* **operator-bot:** фундамент форум-топиков — bot-api + колонка диалога ([d06ae78](https://github.com/chatman-media/lead-engine/commit/d06ae7833de8b4dd9c5386b3cf3c1997e0b238a7))

# [@chatman-media/channel-telegram-v1.7.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.6.0...@chatman-media/channel-telegram-v1.7.0) (2026-06-15)


### Features

* **operator-bot:** свой ответ клиенту сразу из чата (без канны-заготовки) ([aafe318](https://github.com/chatman-media/lead-engine/commit/aafe3182cb4958fd70272e1083025ff8144c1c15))

# [@chatman-media/channel-telegram-v1.6.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.5.0...@chatman-media/channel-telegram-v1.6.0) (2026-06-14)


### Features

* **inbound:** обработка правок сообщений + настраиваемая пауза перед ответом ([dc8b117](https://github.com/chatman-media/lead-engine/commit/dc8b11741a0b3128d0f993234aff5d98dfce77b5))

# [@chatman-media/channel-telegram-v1.5.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.4.0...@chatman-media/channel-telegram-v1.5.0) (2026-06-12)


### Features

* **exchange:** show handoff media to operators ([#578](https://github.com/chatman-media/lead-engine/issues/578)) ([9dd3cee](https://github.com/chatman-media/lead-engine/commit/9dd3cee3a559be63f9cb613ee94c173248f66edc))

# [@chatman-media/channel-telegram-v1.4.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.3.0...@chatman-media/channel-telegram-v1.4.0) (2026-06-11)


### Features

* **exchange:** ship handoff fixes and rolling context summary ([#579](https://github.com/chatman-media/lead-engine/issues/579)) ([317a29b](https://github.com/chatman-media/lead-engine/commit/317a29bbca5924ab6f12fdd450062c179c735c7a)), closes [#576](https://github.com/chatman-media/lead-engine/issues/576) [#578](https://github.com/chatman-media/lead-engine/issues/578)

# [@chatman-media/channel-telegram-v1.3.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.2.0...@chatman-media/channel-telegram-v1.3.0) (2026-06-10)


### Features

* **conversation-engine:** add reactive operator bot previews ([#444](https://github.com/chatman-media/lead-engine/issues/444)) ([ced6e4d](https://github.com/chatman-media/lead-engine/commit/ced6e4ddd63bb6c607bee2627a1b290d605b78a8))

# [@chatman-media/channel-telegram-v1.2.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.1.0...@chatman-media/channel-telegram-v1.2.0) (2026-06-09)


### Features

* **conversation-engine:** add operator bot action callbacks ([#436](https://github.com/chatman-media/lead-engine/issues/436)) ([6f8085f](https://github.com/chatman-media/lead-engine/commit/6f8085f8046ed03f5b9278c172272bd7d919fa0c))

# [@chatman-media/channel-telegram-v1.1.0](https://github.com/chatman-media/lead-engine/compare/@chatman-media/channel-telegram-v1.0.0...@chatman-media/channel-telegram-v1.1.0) (2026-06-03)


### Bug Fixes

* resolve channel-telegram TDZ crash on API startup ([d1390b4](https://github.com/chatman-media/lead-engine/commit/d1390b46b69858100d0a44acfc61c4a805186224))


### Features

* **exchange:** core infrastructure (models, tools, providers, migrations) ([75f84d7](https://github.com/chatman-media/lead-engine/commit/75f84d74b4a95d1ce486eb2428862d52d81c3ebc))

# @chatman-media/channel-telegram-v1.0.0 (2026-05-23)


### Bug Fixes

* **release:** publish via bun instead of @semantic-release/npm (workspace: protocol) ([#66](https://github.com/chatman-media/lead-engine/issues/66)) ([942c3f9](https://github.com/chatman-media/lead-engine/commit/942c3f9a9f46f00b5cdb416d26303375bc20a7d6))


### Features

* **channel-telegram:** full MTProto userbot — health events + downloadMedia + signalTyping (Issue [#3](https://github.com/chatman-media/lead-engine/issues/3) / G) ([dc307af](https://github.com/chatman-media/lead-engine/commit/dc307af5ca0365bf0867a4527ed9617a05d4d41d))
* **channel-telegram:** MTProto userbot adapter — connect/receive/send (Этап 2b-cont) ([b24f9d9](https://github.com/chatman-media/lead-engine/commit/b24f9d948cb5d2137f3adbf6c1e82653e01830d8))
* **channel-telegram:** TelegramBotAdapter поверх ChannelAdapter (Этап 2b, часть 1) ([7c02207](https://github.com/chatman-media/lead-engine/commit/7c022071fa0316471c485584a1175624a413047e)), closes [#3](https://github.com/chatman-media/lead-engine/issues/3)
* онбординг-мастер + Telegram userbot (личный аккаунт) ([#67](https://github.com/chatman-media/lead-engine/issues/67)) ([b6d70de](https://github.com/chatman-media/lead-engine/commit/b6d70ded4d91c791c526eb17eaeedb68c5d1a2d6))
