export const meta = {
  name: 'scrum-sprint',
  description: 'Прогнать спринт: для каждой карточки Todo — дизайн → план → код+PR → ревью+QA',
  phases: [
    { title: 'Design', detail: 'product-designer: спека + критерии приёмки' },
    { title: 'Plan', detail: 'tech-lead: подход + декомпозиция' },
    { title: 'Implement', detail: 'implementer: код в изолированном worktree + PR' },
    { title: 'Verify', detail: 'reviewer ∥ qa по PR' },
  ],
}

// args = { cards: [{itemId, number, title, url, body, labels}], repo, base, qaCommands: [] }
// args может прийти как объект ИЛИ как JSON-строка — нормализуем.
let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    a = {}
  }
}
a = a || {}
const cards = a.cards || []
const repo = a.repo || 'chatman-media/lead-engine'
const base = a.base || 'main'
const qaCommands = a.qaCommands || ['bun install', 'bun run typecheck', 'bun run check', 'bun run test']

if (!cards.length) {
  log('Нет карточек на вход — спринт пуст.')
  return []
}

log(`Спринт: ${cards.length} карточк(и) → ${cards.map((c) => `#${c.number}`).join(', ')}`)

const SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    problem: { type: 'string', description: 'Какую проблему пользователя решаем' },
    userStory: { type: 'string', description: 'Как <роль> я хочу <…> чтобы <…>' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Проверяемые критерии приёмки' },
    uxNotes: { type: 'string', description: 'UX/продуктовые заметки, состояния, крайние случаи' },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['problem', 'acceptanceCriteria', 'uxNotes'],
}

const PLAN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approach: { type: 'string', description: 'Выбранный технический подход' },
    affectedAreas: { type: 'array', items: { type: 'string' }, description: 'Пакеты/приложения/файлы, которых коснёмся' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Конкретные шаги реализации по порядку' },
    testStrategy: { type: 'string', description: 'Как покрыть тестами/как проверит QA' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['approach', 'steps', 'testStrategy'],
}

const IMPL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean' },
    prNumber: { type: ['number', 'null'] },
    prUrl: { type: ['string', 'null'] },
    branch: { type: ['string', 'null'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'Что сделано, человекочитаемо' },
    blockers: { type: 'string', description: 'Если success=false — почему' },
  },
  required: ['success', 'summary'],
}

const REVIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['severity', 'note'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
}

const QA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'blocked_infra'] },
    summary: { type: 'string' },
    ranCommands: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' }, description: 'Упавшие команды/критерии (для blocked_infra — инфра-причина + доказательство пред-существования)' },
    acceptanceChecked: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary'],
}

function cardBlock(card) {
  return [
    `Issue #${card.number}: ${card.title}`,
    card.url ? `URL: ${card.url}` : '',
    card.labels && card.labels.length ? `Labels: ${card.labels.join(', ')}` : '',
    '',
    '--- ТЕЛО ISSUE ---',
    (card.body || '(пусто)').slice(0, 8000),
    '--- КОНЕЦ ТЕЛА ---',
  ]
    .filter(Boolean)
    .join('\n')
}

const designPrompt = (card) => `Ты продуктовый дизайнер в команде. Репозиторий ${repo} (Bun-монорепо, продукт lead·engine — мульти-вертикальный AI-движок воронок).

Преврати задачу с доски в чёткую продуктовую спеку: проблема пользователя, user story, проверяемые критерии приёмки (acceptanceCriteria — то, по чему QA скажет «готово»), UX-заметки (состояния, ошибки, крайние случаи), и что вне скоупа.

${cardBlock(card)}

Критерии приёмки должны быть конкретными и проверяемыми. Не пиши код. Верни структуру.`

const planPrompt = (card, spec) => `Ты техлид/архитектор. Репозиторий ${repo}. Сначала изучи кодовую базу под задачу: прочитай AGENTS.md и релевантные части (grep/glob/read по затрагиваемым пакетам в apps/* и packages/*). НЕ пиши код — составь план.

ЗАДАЧА (issue #${card.number}: ${card.title}).
ПРОДУКТОВАЯ СПЕКА:
${JSON.stringify(spec, null, 2)}

Дай: подход (approach), конкретные затрагиваемые места (affectedAreas — реальные пути файлов/пакетов), пошаговый план реализации (steps), стратегию тестов (testStrategy — что именно покрыть и как QA проверит), риски. План должен быть исполнимым другим агентом без догадок.`

const implPrompt = (card, spec, plan) => `Ты инженер-исполнитель. Ты в ИЗОЛИРОВАННОМ git worktree на свежей ветке от origin/${base}. Реализуй задачу полностью и открой Pull Request.

Issue #${card.number}: ${card.title}
СПЕКА (критерии приёмки):
${JSON.stringify(spec, null, 2)}
ПЛАН:
${JSON.stringify(plan, null, 2)}

Правила (репозиторий ${repo}):
1. Прочитай AGENTS.md и следуй конвенциям: только Bun (никогда node/npm), форматтер/линтер biome.
2. Реализуй по плану. Добавь/обнови тесты под критерии приёмки.
3. Перед PR прогони и почини: \`bun run typecheck\` и \`bun run check\` (biome). Они ДОЛЖНЫ проходить. Тесты по затронутым пакетам по возможности тоже.
4. Закоммить, затем запушь ветку: \`git push -u origin HEAD\`.
5. Открой PR в base \`${base}\`: \`gh pr create --base ${base} --repo ${repo} --title "<краткий заголовок>" --body "<тело>"\`.
   Тело PR ОБЯЗАТЕЛЬНО содержит первой строкой \`Closes #${card.number}\`, затем разделы: что сделано, критерии приёмки (чек-лист), как тестировать (для QA).
6. Узнай номер: \`gh pr view --json number,url,headRefName\`.

Если реализовать нельзя (блокер) — НЕ создавай мусорный PR: верни success=false и опиши blockers.
Верни: success, prNumber, prUrl, branch, filesChanged, summary, blockers.`

const reviewPrompt = (card, spec, plan, impl) => `Ты ревьюер кода (строгий, но конструктивный). Репозиторий ${repo}.

Проверяется PR #${impl.prNumber} по issue #${card.number}: ${card.title}.
Смотри ИМЕННО диф этого PR: \`gh pr diff ${impl.prNumber} --repo ${repo}\` (локальные файлы могут быть на ${base}, не доверяй им — работай с дифом). Метаданные: \`gh pr view ${impl.prNumber} --repo ${repo} --json files,additions,deletions,title,body\`.

Контекст — критерии приёмки:
${JSON.stringify(spec.acceptanceCriteria || [], null, 2)}
План подхода: ${plan.approach}

Оцени: корректность, соответствие критериям приёмки и плану, безопасность (этот репо обрабатывает лиды/платежи — ищи SSRF/инъекции/утечки секретов/авторизацию), соблюдение конвенций репо, мёртвый код/дубли. Не запускай тесты — это делает QA.
Вердикт approve только если нет blocker/major находок. Верни verdict, summary, findings (severity+file+note).`

const qaPrompt = (card, spec, impl) => `Ты QA-инженер. Ты в ИЗОЛИРОВАННОМ git worktree. Прогони тестовый стенд по PR #${impl.prNumber} (issue #${card.number}: ${card.title}).

Шаги:
1. Выкатить ветку PR в свой worktree: \`gh pr checkout ${impl.prNumber} --repo ${repo}\`.
2. Прогнать по очереди команды стенда (каждую — из корня репо), фиксируя результат:
${qaCommands.map((c) => `   - \`${c}\``).join('\n')}
3. Сверить поведение с критериями приёмки:
${JSON.stringify(spec.acceptanceCriteria || [], null, 2)}

Вердикт (три исхода):
- **pass** — всё зелёное и критерии выполнены.
- **fail** — сломано ПО ВИНЕ PR (упал тест/typecheck/линт из-за изменений или не выполнен критерий).
- **blocked_infra** — критерии выполнены и PR-специфичные проверки зелёные, но обязательная команда стенда красная по ПРЕД-СУЩЕСТВУЮЩЕЙ причине, не внесённой PR. ДОКАЖИ это: та же команда так же падает на base/merge-base (прогон на до-PR версии даёт идентичную ошибку). Без доказательства — это fail.
В failures перечисли дословно команду/критерий и суть ошибки (для blocked_infra — инфра-причину + доказательство пред-существования).
Верни verdict, summary, ranCommands, failures, acceptanceChecked.`

const results = await pipeline(
  cards,
  // Stage 1 — Design
  (card) =>
    agent(designPrompt(card), {
      agentType: 'product-designer',
      label: `design:#${card.number}`,
      phase: 'Design',
      schema: SPEC,
    }).then((spec) => ({ card, spec })),
  // Stage 2 — Plan
  (acc) =>
    agent(planPrompt(acc.card, acc.spec), {
      agentType: 'tech-lead',
      label: `plan:#${acc.card.number}`,
      phase: 'Plan',
      schema: PLAN,
    }).then((plan) => ({ ...acc, plan })),
  // Stage 3 — Implement (worktree isolation: параллельные правки не конфликтуют)
  (acc) =>
    agent(implPrompt(acc.card, acc.spec, acc.plan), {
      agentType: 'implementer',
      label: `impl:#${acc.card.number}`,
      phase: 'Implement',
      isolation: 'worktree',
      schema: IMPL,
    }).then((impl) => ({ ...acc, impl })),
  // Stage 4 — Verify (review ∥ qa), только если есть живой PR
  (acc) => {
    if (!acc.impl || !acc.impl.success || !acc.impl.prNumber) {
      log(`#${acc.card.number}: реализация не дошла до PR — пропускаю ревью/QA`)
      return { ...acc, review: null, qa: null, skipped: true }
    }
    return parallel([
      () =>
        agent(reviewPrompt(acc.card, acc.spec, acc.plan, acc.impl), {
          agentType: 'reviewer',
          label: `review:#${acc.card.number}`,
          phase: 'Verify',
          schema: REVIEW,
        }),
      () =>
        agent(qaPrompt(acc.card, acc.spec, acc.impl), {
          agentType: 'qa',
          label: `qa:#${acc.card.number}`,
          phase: 'Verify',
          isolation: 'worktree',
          schema: QA,
        }),
    ]).then(([review, qa]) => ({ ...acc, review, qa }))
  },
)

return results.filter(Boolean)
