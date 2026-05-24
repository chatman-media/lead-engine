# @chatman-media/kb-v1.0.0 (2026-05-24)


### Bug Fixes

* **api,kb:** PDF upload, coach-batch styleSlug, LLM live ping ([a4fc0ab](https://github.com/chatman-media/lead-engine/commit/a4fc0ab5ee82a8e5951ca3bc90b60ba935e597cc))
* **release:** publish via bun instead of @semantic-release/npm (workspace: protocol) ([#66](https://github.com/chatman-media/lead-engine/issues/66)) ([942c3f9](https://github.com/chatman-media/lead-engine/commit/942c3f9a9f46f00b5cdb416d26303375bc20a7d6))


### Features

* AI field extraction, funnel seed templates, lead UI, billing dashboard ([#73](https://github.com/chatman-media/lead-engine/issues/73)) ([8bb7187](https://github.com/chatman-media/lead-engine/commit/8bb71876d2e90224be029c87d4dd859a2b5671ad))
* GTM phase 1 — referral codes, sales bot, agentic booking tool ([#90](https://github.com/chatman-media/lead-engine/issues/90)) ([1bf8e4f](https://github.com/chatman-media/lead-engine/commit/1bf8e4f5ca2ca6cb70cf3de133aab4d8e523d7b4))
* **kb:** agentic tool-calling loop (cherry-pick from upstream rag@1.4.0) ([97358f1](https://github.com/chatman-media/lead-engine/commit/97358f15df92370664ad3b153d5e0ece41e66e9a)), closes [#12](https://github.com/chatman-media/lead-engine/issues/12)
* Persuasion Engine + bot wiring + roadmap features ([#83](https://github.com/chatman-media/lead-engine/issues/83)) ([c0ba642](https://github.com/chatman-media/lead-engine/commit/c0ba642d659ac8f0c09683b3980f089f509235c0))

## [1.2.1](https://github.com/chatman-media/rag/compare/v1.2.0...v1.2.1) (2026-05-17)


### Bug Fixes

* guard rerankers against out-of-range API indices ([77e28ff](https://github.com/chatman-media/rag/commit/77e28ff7769a28052ee6bdc6ef93a81725a7bfff))
* strip boolean keywords regardless of position in sanitizeFtsQuery ([7a749e6](https://github.com/chatman-media/rag/commit/7a749e648d0b4fa98b8df79e72af5ca2b550b317))

# [1.2.0](https://github.com/chatman-media/rag/compare/v1.1.0...v1.2.0) (2026-05-16)


### Features

* add structured output support with Zod schema validation ([45c763c](https://github.com/chatman-media/rag/commit/45c763c061ab2c9a42eb08355f187f978976ab83))

# [1.1.0](https://github.com/chatman-media/rag/compare/v1.0.0...v1.1.0) (2026-05-14)


### Features

* add tool calling support (single-cycle) to answerWithRag ([a0a67b1](https://github.com/chatman-media/rag/commit/a0a67b1a10a9936144f4205a17374f83d358e0ce))

# 1.0.0 (2026-05-14)


### Bug Fixes

* **ci:** add @types/bun and skipLibCheck to fix typecheck in CI ([b1d59e0](https://github.com/chatman-media/rag/commit/b1d59e0788682cc3ed6593d54fcbb3a005831b10))
* correct main repo references from tg-chatbot to lead-engine ([7e48cc9](https://github.com/chatman-media/rag/commit/7e48cc9734ccba170d35ca1196607297711957e6))
* correct package name to @chatman-media/chatbot_rag (underscore) ([f04fb7a](https://github.com/chatman-media/rag/commit/f04fb7af2aa0cde19dcbb2e58f9a5ec458945ea4))
* **lint:** eliminate all noNonNullAssertion warnings ([856fce6](https://github.com/chatman-media/rag/commit/856fce6a957309acaf7aca090223eb3f37d8e5e9))
* rename package from @chatman/rag to @chatman-media/chatbot-rag ([a8b9a9c](https://github.com/chatman-media/rag/commit/a8b9a9c91adf47e0a51ab44714b25ce1a49cf466))
* rename package to @chatman-media/rag ([18a19c0](https://github.com/chatman-media/rag/commit/18a19c0578fe24dde31c4776ff70673666f3e0d4))
* use local node_modules/.bin paths in npm scripts to avoid bun x isolation ([31297af](https://github.com/chatman-media/rag/commit/31297af7a8caf729862d3064a1493f5a2075c717))


### Features

* add basic-rag example with in-memory store (no database required) ([fbd8aa9](https://github.com/chatman-media/rag/commit/fbd8aa92a853bb075a22a2e9323cdc7157d5cdac))
* add reranker, eval, conversation store, A/B router, SSE server, npm build ([d94245c](https://github.com/chatman-media/rag/commit/d94245c2ff038d32001a29e4ae2ad44a3b1eef3b))
* add sales-persona example with NEPQ framework and stage routing ([548e6fd](https://github.com/chatman-media/rag/commit/548e6fdf7e3395a232a515447577431bc67c6ad3))
* add streaming, onTelemetry callback, and InMemoryKbStore ([898a697](https://github.com/chatman-media/rag/commit/898a6979484f535fbbb7bf83eff1e4b8e4fd497e))
* export reciprocalRankFusion and sanitizeFtsQuery as public utilities ([6315d03](https://github.com/chatman-media/rag/commit/6315d036c7d7b5563bfd74c92a226a51ffa700a5))
* initial release of @chatman/rag package ([0b28fb8](https://github.com/chatman-media/rag/commit/0b28fb87cb1a55156727f16978ba04aeb32a1fa6))
* retry/backoff, semantic cache, and section-aware chunking ([b071f5c](https://github.com/chatman-media/rag/commit/b071f5c07c65eb0f1a63f8889309b817cc2a8f27))
