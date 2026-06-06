# KB-samples — стартовый справочник по вертикалям

Готовый контент для базы знаний (RAG), чтобы бот мог отвечать по делу в
разных категориях «из коробки», а не уходить в «уточню у партнёра».

Каждая поддиректория — отдельная вертикаль. Документы — обычный Markdown;
`seed-kb.ts` чанкует, эмбеддит и пишет в `kb_documents` + `kb_chunks`
(tenant-scoped, идемпотентно по `content_hash`).

## Как залить

```bash
DATABASE_URL=postgres://… \
LLM_EMBED_PROVIDER=openai \
LLM_EMBED_MODEL=text-embedding-3-small \
LLM_EMBED_DIM=1536 \
LLM_EMBED_API_KEY=sk-… \
# для OpenRouter: LLM_EMBED_BASE_URL=https://openrouter.ai/api/v1 + ключ sk-or-…
bun run apps/api/scripts/seed-kb.ts --tenant=<slug> --dir=apps/api/kb-samples/real_estate --topic=real_estate
```

> RAG включается только когда у тенанта настроен embed-конфиг (`anyEmbed=true`).
> Без эмбеддингов бот работает в LLM-only режиме и KB-ретрив недоступен —
> инструменты (например расчёт курса) при этом всё равно работают.

## Вертикали

- `real_estate/` — каталог объектов, просмотры, ипотека/оплата
- `exchange/` — FAQ по обмену (процесс, комиссии, реквизиты, KYC, лимиты)
- `recruitment/` — вакансии, требования, процесс трудоустройства
- `saas/` — продукт, тарифы, процесс демо/онбординга

Контент здесь — обезличенные ПРИМЕРЫ под демо. Замените на реальные данные
тенанта перед продакшеном.
