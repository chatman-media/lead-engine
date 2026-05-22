# @chatman-media/llm-router

[![npm version](https://img.shields.io/npm/v/@chatman-media/llm-router?logo=npm&color=22c55e)](https://www.npmjs.com/package/@chatman-media/llm-router)
[![CI](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/chatman-media/lead-engine/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Per-tenant LLM routing: BYOK / platform-managed / Ollama. Routes `(tenantId, purpose)` → a concrete `ChatClient` / `EmbeddingClient`.

Part of the [**lead-engine**](https://github.com/chatman-media/lead-engine) monorepo — a multi-tenant SaaS platform for AI sales bots on Telegram / WhatsApp.

## Install

```bash
bun add @chatman-media/llm-router     # Bun
npm install @chatman-media/llm-router # npm / pnpm / yarn
```

## License

[MIT](LICENSE) — Alexander Kireev / [chatman-media](https://github.com/chatman-media)
