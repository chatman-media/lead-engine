# answer-step-eval — вклад опциональных LLM-шагов answerWithRag (#515)

- датасет: `packages/kb/evals/answer-steps.jsonl` (17 кейсов), повторов: 2
- chat: ollama/qwen3:latest; embed: ollama/bge-m3
- baseline = rewrite + multi-query + reflection включены; аблации выключают шаги

| Вариант | pass | recall | grounded | forbidden | LLM-вызовов/кейс | median мс/кейс |
|---|---|---|---|---|---|---|
| Baseline | 94.1% | 100.0% | 91.2% | 2 | 3.12 | 6219 |
| − query rewrite | 94.1% | 100.0% | 91.2% | 2 | 2.94 | 4144 |
| − multi-query | 91.2% | 100.0% | 88.2% | 2 | 2.12 | 3238 |
| − reflection | 94.1% | 100.0% | 88.2% | 2 | 2.18 | 3607 |
| prod default (только rewrite) | 94.1% | 100.0% | 91.2% | 2 | 1.18 | 2299 |
| minimal (все шаги выключены) | 94.1% | 100.0% | 85.3% | 2 | 1.00 | 1965 |

Пути ответа (суммарно по повторам):

- Baseline: ok=32, no_context=2
- − query rewrite: ok=32, no_context=2
- − multi-query: ok=32, no_context=2
- − reflection: ok=32, no_context=2
- prod default (только rewrite): ok=32, no_context=2
- minimal (все шаги выключены): ok=32, no_context=2
