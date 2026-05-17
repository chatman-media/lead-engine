# Example: basic RAG with in-memory store

Minimal working example — no database required.

```bash
bun install
OPENAI_API_KEY=sk-... bun run index.ts
```

The `InMemoryKbStore` in this example uses plain arrays + `unpdf` for search.
For production, replace it with a PostgreSQL + pgvector implementation.
