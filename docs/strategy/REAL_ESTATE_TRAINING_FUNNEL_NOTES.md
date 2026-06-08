# Real Estate Training Funnel Notes

_Created: 2026-06-08. Source video: `/Users/aleksandrkireev/Downloads/training_full.mp4`._

Saved transcription artifacts:

- `/Users/aleksandrkireev/Downloads/lead-engine-real-estate-training/training_full_transcript.md`
- `/Users/aleksandrkireev/Downloads/lead-engine-real-estate-training/training_full_segments.tsv`
- `/Users/aleksandrkireev/Downloads/lead-engine-real-estate-training/training_full_mlx_turbo_noprev.json`
- `/Users/aleksandrkireev/Downloads/lead-engine-real-estate-training/training_findings.md`

The repo stores the product summary, timestamps and implementation impact only. The
full transcript/audio stays outside git because it is large and mostly raw material.

## Executive Summary

The training is not only a real-estate playbook. It gives a reusable funnel rule:
every stage must actively move the client to the next stage. A stage is not just a
CRM label; it needs a goal, a question or CTA, an exit criterion, a blocker rule and
a response SLA.

For real estate this becomes: first split by `apartment vs house/villa`, then
`ready vs off-plan`, then qualify use case, location, budget, payment and meeting
format. For the platform this should become a global pattern for all vertical seeds
and AI-generated funnels.

## Universal Rules That Affect All Funnels

These are cross-vertical. They should not live only inside `real_estate` copy.

| Rule | What changes across all funnels | Code/product touchpoint |
|---|---|---|
| Stage must close into next stage | Every active stage needs an explicit next action, question/CTA and exit criterion. Avoid endless chat inside one stage. | `stage_definitions.goal`, `stage_definitions.guidance`, AI builder prompt, seed templates |
| First branch question | Every vertical needs its first useful segmentation question: real estate has object type; exchange has asset/amount; recruitment has role/status; concierge has request type. | `apps/vertical-*/src/intake.ts`, `SEED_TEMPLATES[*].fields` |
| Fast response SLA | High-intent leads decay quickly. Seed guidance should mention expected response speed and operator call/handoff timing where relevant. | per-stage `guidance`, notifications, operator tasks |
| Every message ends with progress | The bot should normally end with one focused question or next-step choice, not passive information. | style seeds, prompt composition, few-shots |
| Online/offline path split | The sales route depends on how the client can continue: meeting, call, Zoom, chat-only, document upload, payment proof. | intake fields, nextStages, stage guidance |
| Curated offer route | Show options intentionally: contrast constraint/risk, show strong fit, then reinforce the decision. Generalizes to offers/packages/rates/candidates. | offer-stage guidance, KB/RAG selection logic |
| Verified facts only | Do not invent prices, availability, legal terms, deadlines or guarantees. If unconfirmed, say it needs verification/operator. | KB guardrails, style hooks, `awaiting_operator` |
| Full-cycle value | The sale does not end at agreement. Payments, documents, delivery, onboarding or handover often drive trust, referrals and LTV. | `fulfill` stages, post-sale tasks, lifecycle metrics |
| Measure stage conversion | Track conversion and time from contact to call/meeting/offer/booking/payment/won. Optimize weak stages, not only final revenue. | phase stats, funnel analytics, dashboard |
| Ask for the close | When fit is confirmed, ask for the equivalent of booking/reservation/payment/next commitment. If client declines, extract the real objection. | close-stage guidance, objection fields, director hooks |
| Relationship/LTV | The bot should support a human relationship, not only one transaction. Useful for referrals, repeats, upgrades and renewals. | style seeds, post-sale stages, CRM notes |

## Hook Catalogue

The trainer did not present these as a clean named list of "hooks"; they were
spread through the session. The reusable hooks are:

| Hook | Real-estate form | Universal form | Timestamp |
|---|---|---|---|
| Location magnet | Each location has a "magnet": sea, school, lifestyle, liquidity. | Identify the strongest value magnet for any offer. | `00:04:04-00:04:39` |
| Expert guide | Agent is the client's market guide. | Bot/operator filters complexity and explains the path. | `01:28:34-01:28:55` |
| Question at the end | Every message ends with a question that moves the deal. | Every stage reply should advance or qualify. | `00:56:16`, `01:29:04` |
| Choice without choice | "First half of day or second?" | Offer two good next-step options instead of a vague yes/no. | `01:33:24-01:34:06`, `02:11:13` |
| Speed hook | Reply in one minute; call after several minutes if read and silent. | SLA and fast handoff for hot leads. | `01:46:20-01:46:30`, `02:48:39-02:49:21` |
| Four-cube qualification | Villa/apartment plus ready/off-plan. | First branch dimension plus delivery/status dimension. | `01:35:28-01:40:11` |
| Full-cycle support | Support through reservation, payments, contract and handover. | Fulfillment and post-sale support are part of the offer. | `01:40:12`, `01:48:29-01:49:14` |
| Price/exclusive terms | Better price, discount, developer terms, exclusive conditions. | Prove economic advantage where it is real and verified. | `01:41:18-01:42:03`, `02:16:29` |
| Social proof | Team bought, owner bought, proof from real deals. | Use concrete proof, not generic claims. | `01:43:45-01:45:27` |
| Anti-overpromise | Do not lie, invent or promise unconfirmed terms. | Build trust by naming verification boundaries. | `01:45:57-01:48:15` |
| Route design | Show constraint, wow option, then reinforce fit. | Sequence offers deliberately, not randomly. | `02:21:43-02:23:31` |
| Urgency and reservation | If the object fits, propose reservation. | Ask for the next commitment when fit is confirmed. | `02:46:30`, `02:49:36` |
| Human relationship | A person buys from a person. | Style should build trust and long-term relationship. | `02:43:45-02:44:26` |

## Real-Estate Specific Decisions

These should stay real-estate specific:

- First qualification question: apartment or house/villa.
- Second split: ready property or under construction/off-plan.
- Qualification fields: own use, rental income, investment, visa/residency, bedroom
  count, preferred area, budget, payment plan, ownership preference, online/offline
  meeting format.
- Route logic: viewing path should be intentional; do not show random objects.
- Deal stages after reservation should include contract/legal/payment/handover
  support, not jump straight to final transfer.

## Cross-Funnel Refactor Candidates

No hard schema migration is required immediately. The current `goal` and
`guidance` columns can carry the behavior, but the convention should be made
explicit in seeds and builder prompts.

Recommended order:

1. Add a shared "stage behavior contract" convention to the AI funnel builder:
   `goal`, `next_question`, `exit_criteria`, `blocker`, `operator_handoff`,
   `response_sla`.
2. Update `SEED_TEMPLATES` gradually so every implemented vertical has stage
   guidance that closes to the next step.
3. Update generated style seeds so every style has the universal hooks:
   commitment, authority, reciprocity/full-cycle value, verified-facts boundary,
   appropriate urgency and relationship/LTV.
4. Add validation warnings, not blocking errors, when an AI-generated active
   stage has no useful `goal` or `guidance`.
5. Later, if dashboards need structured reporting, split `guidance` into typed
   columns or JSON. Until then, keep it as text to avoid a broad migration.

## Code Touchpoints

- `apps/api/src/routes/admin-funnel.ts` — seed templates, fields, per-stage goals
  and guidance. This is where cross-vertical seed behavior currently lives.
- `apps/api/src/routes/admin-workflow.ts` — AI funnel builder prompt and
  normalization. This is the right place to make the stage behavior contract a
  default generation requirement.
- `apps/api/src/routes/admin-director-hooks.ts` — tenant-specific persuasion hooks.
  Useful for operator-editable versions of the hook catalogue.
- `apps/vertical-*/src/intake.ts` — vertical-specific first branch and
  qualification fields.
- `apps/vertical-*/src/styles/*.ts` — reusable persuasion hooks and tone.
- `packages/verticals/src/phases.ts` — universal phase backbone. The training
  reinforces that `fulfill` often matters for LTV, but it should remain optional
  because not every vertical needs a separate fulfillment phase.
- `packages/kb` and prompt composition — verified facts only; do not invent
  availability, price, terms or legal details.

## Applied To Real Estate In This Pass

- Intake starts with apartment vs house/villa.
- Added ready/off-plan qualification.
- Added ownership preference and meeting format fields.
- Seed guidance now includes fast response, question-at-end, online/offline split,
  alternative close and no-unverified-promises rule.
- Added reservation fields and a `handover_support` fulfill stage.
- Real-estate styles now carry commitment, full-cycle, verified-data and
  relationship hooks.

## Important Timestamps

- `00:00:59-00:01:38` — LTV, repeat commission and trust.
- `01:27:01-01:31:34` — welcome, quick qualification, question at the end.
- `01:30:41-01:30:55` — compact qualification fields.
- `01:31:41-01:34:06` — offline/online split and alternative close.
- `01:35:28-01:40:11` — apartment/villa and ready/off-plan cubes.
- `01:40:12-01:46:11` — full cycle, price, service, knowledge, experience, honesty.
- `01:46:20-01:49:14` — response speed and full-cycle alignment.
- `02:06:00-02:07:36` — meeting and route as sales mechanism.
- `02:21:43-02:23:31` — route pattern: constraint, strong fit, reinforcement.
- `02:24:24-02:26:21` — post-reservation support through contract/payment.
- `02:39:14-02:40:51` — measure stage conversions.
- `02:43:45-02:44:26` — human relationship and referrals.
- `02:45:20-02:49:51` — ask for buying/reservation and surface real objection.
