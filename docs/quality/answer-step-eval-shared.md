# answer-step-eval — вклад опциональных LLM-шагов answerWithRag (#515)

- датасет: `packages/kb/evals/answer-steps.jsonl` (17 кейсов), повторов: 2
- chat: ollama/qwen3:latest; embed: ollama/bge-m3
- baseline = rewrite + multi-query + reflection включены; аблации выключают шаги

| Вариант | pass | recall | grounded | forbidden | LLM-вызовов/кейс | median мс/кейс |
|---|---|---|---|---|---|---|
| Baseline | 85.3% | 91.2% | 76.5% | 2 | 3.12 | 5897 |
| − query rewrite | 79.4% | 88.2% | 70.6% | 2 | 2.94 | 3890 |
| − multi-query | 82.4% | 94.1% | 73.5% | 2 | 2.12 | 4206 |
| − reflection | 85.3% | 91.2% | 76.5% | 2 | 2.18 | 3859 |
| prod default (только rewrite) | 82.4% | 94.1% | 73.5% | 2 | 1.18 | 2568 |
| minimal (все шаги выключены) | 88.2% | 94.1% | 76.5% | 2 | 1.00 | 1733 |

Пути ответа (суммарно по повторам):

- Baseline: ok=30, ungrounded=2, no_context=2
- − query rewrite: ok=32, no_context=2
- − multi-query: ok=30, ungrounded=2, no_context=2
- − reflection: ok=32, no_context=2
- prod default (только rewrite): ok=32, no_context=2
- minimal (все шаги выключены): ok=32, no_context=2
