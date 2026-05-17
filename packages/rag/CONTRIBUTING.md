# Contributing to @chatman-media/rag

Thanks for taking the time to contribute!

## Development setup

```bash
# Clone and install
git clone https://github.com/chatman-media/rag.git
cd chatbot_rag
bun install

# Type check
bun run typecheck

# Lint and format
bun run check
bun run format
```

No test runner is bundled in this package — integration tests live in the host
[sales-guru](https://github.com/chatman-media/sales-guru) project which has a
real PostgreSQL + pgvector setup.

## Project structure

```
src/
├── index.ts              # Public API — re-exports everything
├── types.ts              # IKbStore, KbSearchHit (storage interfaces)
├── styles.ts             # Style, FunnelStage, SkillForPrompt (sales schema)
├── answer.ts             # answerWithRag — main entry point
├── answer-types.ts       # AnswerInput, AnswerResult, AnswerTelemetry
├── chat.ts               # ChatClient interface + OpenAI implementation
├── embed.ts              # EmbeddingClient interface + OpenAI implementation
├── ingest.ts             # ingestFile / ingestText / ingestDirectory
├── chunk.ts              # Text splitting with overlap
├── parse-pdf.ts          # PDF text extraction (unpdf)
├── prompt.ts             # composeSystemPrompt (sales-style engine)
├── system-prompt.ts      # buildSystemPrompt (legacy simple mode)
├── fact-checker.ts       # Unified KB grounding + vacancy accuracy guard
├── reflect.ts            # Legacy hallucination verifier (superseded by fact-checker)
├── rewrite-query.ts      # Query expansion for follow-up questions
├── sanitize.ts           # Strip <think>, markdown, AI lead-ins from LLM output
├── text-style-rules.ts   # Pluggable text transforms (em-dash, ellipsis, …)
├── topic-classifier.ts   # Deterministic regex topic routing
├── persona-shortcuts.ts  # Bypass RAG for identity / smalltalk questions
├── extract-user-facts.ts # Extract candidate facts from conversation
├── summarize-conversation.ts # Compress long conversations to a paragraph
├── grade-skills.ts       # Post-hoc persuasion-skill usage grading
└── providers/
    ├── ollama-chat.ts    # Ollama chat client
    ├── ollama-embed.ts   # Ollama embedding client
    └── openrouter-chat.ts # OpenRouter chat client
```

## Adding a new LLM provider

1. Create `src/providers/<name>-chat.ts` implementing `ChatClient`:

```ts
import { ChatApiError, type ChatClient, type ChatMessage } from "../chat.ts";

export class MyChatClient implements ChatClient {
  async complete(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    // call your API, return the reply string
  }
}
```

2. Export it from `src/index.ts`.

## Adding a text style rule

Style rules in `src/text-style-rules.ts` post-process every LLM reply.
They must be **idempotent** and **pure** (no I/O, no state):

```ts
export const myRule: TextStyleRule = {
  name: "my-rule",
  description: "what it does",
  apply: (s) => s.replace(/pattern/g, "replacement"),
};
```

Add it to `DEFAULT_STYLE_RULES` in the same file.

## Submitting a PR

- Keep PRs focused — one concern per PR.
- Run `bun run typecheck` and `bun run check` before pushing.
- Describe _why_ the change is needed, not just _what_ it does.
