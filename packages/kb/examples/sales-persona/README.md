# Example: sales persona with NEPQ framework

Shows how to configure a `Style` and run `answerWithRag` with:

- A human-role persona that never admits to being AI
- NEPQ conversation framework with stage-specific guidance
- Cialdini hooks (social proof, scarcity, authority)
- Few-shot examples for consistent tone
- Hallucination guard (`reflect: true`)
- Hybrid search (`hybridSearch: true`)

```bash
# Requires Ollama running locally with qwen3 + bge-m3
bun run index.ts
```
