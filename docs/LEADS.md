# Lead pipeline

End-to-end воронка кандидата от знакомства до подачи на визу. Бот сам ведёт диалог через RAG + persona, авто-собирает анкету, эскалирует решение оператору в TG-чат, после одобрения собирает структурированные данные на визу, и финально передаёт пакет с auto-generated `application_id` в чат подачи.

```
candidate writes  →  bot RAG-replies + collects intake (height/weight/photos/...)
                              ↓ (auto when the 8-condition gate passes)
                     intake_complete  →  card posted to LEADS_CHAT_ID
                                          [✅ Одобрить] [❌ Отклонить]
                              ↓ operator clicks
                          approved  →  bot DMs visa anketa template
                              ↓ (auto, immediately)
                       docs_pending  →  bot auto-extracts 32 visa fields
                                       admin can manually edit any
                                       bot answers her questions in support mode
                              ↓ operator clicks "→ на визу"
                       docs_complete  →  package posted to VISA_CHAT_ID
                                         with VS-YYYY-NNNN
                              ↓ operator clicks "✅ подал" after filing
                          submitted  →  bot keeps answering in support mode
                                         while the consulate decision is pending
```

## Configuration

Two TG group chats (operator-managed):

```bash
LEADS_CHAT_ID=-100123456789       # operator chat for new lead cards
VISA_CHAT_ID=-100987654321        # ops chat for the visa submission package
```

Bot must be a **member** of both (admin role lets it edit cards in place after approve/reject — recommended). When `LEADS_CHAT_ID` is unset, the pipeline still works through `/admin/leads` only — auto-intake auto-promote is disabled (would have nowhere to surface) and operator promotes manually via the chat page button.

## State machine

Operator-facing labels (UI funnel vocabulary) are in parentheses.

| State | Meaning | How you get here | What bot does |
|-------|---------|-----------------|---------------|
| `intake_pending` (заполнение анкеты) | Default for any new candidate | Created on first message | Collects intake via natural conversation; auto-extracts fields each turn |
| `intake_complete` (ожидает решения) | Anketa filled — awaiting operator decision | 8-condition gate passes | Posts card to ops chat; tells candidate "ждите, отправили запрос" |
| `approved` (одобрено) | Operator approved | inline button OR `/admin/api/leads/:id/approve` | Sends 4-message visa anketa pack to candidate; transitions to `docs_pending` |
| `partner_review` (ожидает апрув партнёров) | Anketa + 2 videos shown to the Chinese partner club, awaiting their decision | Defined for the partner-review gate; transition wiring is tracked with the proactive-messaging work | — |
| `rejected` (отклонён) | Operator rejected (terminal) | inline button OR endpoint | Sends polite rejection (or operator's custom reason) |
| `docs_pending` (ожидание документов) | Bot collecting visa form; ~10 days | After approve | Auto-extracts 32 fields from each candidate message; operator can edit any; bot answers questions in **support mode** |
| `docs_complete` (подача на документы) | All visa data + package posted | Operator clicks "→ на визу" (`/admin/api/leads/:id/submit-to-visa`) | Allocates `VS-YYYY-NNNN`, posts to VISA_CHAT_ID, DMs candidate "передаём в работу" |
| `submitted` (подача на визу) | Operator confirmed consulate filing; ~4-5 days | Operator clicks "✅ подал" (`/admin/api/leads/:id/mark-submitted`) | DMs candidate "заявка подана" + application id; keeps answering in **support mode** while the consulate decision is pending |
| `ready_to_work` (готова к работе) | Success terminal — visa granted, candidate ready to depart | Defined for the funnel; transition wiring is tracked with the proactive-messaging work | — |
| `closed` (закрыт) | Terminal cleanup state | Manual / stale-sweep auto-close | — |

Expected stage durations (operator-quoted, used for proactive check-ins and UI
hints) live in [src/leads/sla.ts](../src/leads/sla.ts) — 10 days for
`docs_pending`, 4-5 days for `submitted`. These are distinct from the
stale-sweep auto-close thresholds.

## Intake schema

The candidate is sent `INTAKE_TEMPLATE` — a **15-point checklist** (name, age,
height, weight, nationality, marital status, children, languages, work
experience, passport expiry, city + departure readiness, photos, videos,
passport photo, dance video). The `IntakeFields` interface
([src/leads/templates.ts](../src/leads/templates.ts)) tracks ~17 fields:
text fields are LLM-extracted, media counts are SQL-aggregated from
`messages.meta_json`.

Promotion to `intake_complete` is gated by `isIntakeComplete` — an **8-condition
gate** (a subset of the tracked fields):

| Condition | Source | Threshold |
|-----------|--------|-----------|
| `height` | LLM extracts from text | non-empty |
| `weight` | LLM extracts from text | non-empty |
| `city` | LLM extracts from text | non-empty |
| `departure_readiness` | LLM extracts from text | non-empty |
| `photos_count` | SQL count of `meta.media.type='photo'` | ≥ 6 |
| `videos_count` | SQL count of `meta.media.type='video'` | ≥ 2 |
| `passport_photo_received` | Vision classification (`countPhotosByClass`) when `VISION_ENABLED`; fallback heuristic `photos_count ≥ 7` | true |
| `dance_video_received` | Heuristic: `videos_count ≥ 3` → assume dance-video present | true |

When all 8 conditions hold + state == `intake_pending` → auto-transition to `intake_complete`. Operator confirms by eye in TG before pressing approve.

## Visa-docs schema

Auto-extracted by [src/leads/visa-docs.ts](../src/leads/visa-docs.ts) once per `docs_pending` turn. Mirrors the long English visa anketa — 32 fields covering identity (incl. birth province, other-nationality / permanent-residence questions), passport, contact (incl. mobile phone), parents, China history, work/education/travel as free-form blocks. Schema in `VisaFields` interface. 18 of them are required (must-haves before consulate submission); the admin UI shows a `N/18 (xx%)` progress strip.

Operator's manual edits via `PATCH /admin/api/leads/:id/visa-docs` are **preserved** across subsequent extractor runs — the LLM prompt explicitly asks not to re-emit unchanged fields, and the merge logic only overwrites fields the LLM newly returns.

## Режим ожидания (support mode)

After approval the candidate spends ~2 weeks waiting: ~10 days while she gathers
and sends her documents (`docs_pending`), then 3-4 days while the consulate
processes the filed application (`submitted`). During both stages the bot is
**not** selling — it answers her questions in **support mode**.

- Detection: `resolveSupportPhase` in [src/telegram/process-inbound.ts](../src/telegram/process-inbound.ts)
  maps `docs_pending` → `"docs"` and `submitted` → `"submitted"`. The phase is
  threaded as `AnswerInput.supportPhase` into `answerWithRag`.
- Prompt: `composeSystemPrompt` ([src/sales/prompt.ts](../src/sales/prompt.ts))
  drops the sales blocks (framework / hooks / skills / few-shot / funnel-stage
  guidance) and substitutes a calm FAQ-support block. Persona, voice, guardrails,
  KB grounding and KB context stay — visa-FAQ retrieval keeps working.
- No escalation: in support mode a `NO_CONTEXT` turn does **not** queue the chat
  or send the sales call-to-action. The bot sends a soft reassurance and stays
  in `ai` mode. The "оператор" keyword still escalates manually.
- The bot does **not** proactively message the candidate during the wait — it
  only replies when she writes. Timed check-ins / reminders are a future
  enhancement (see [ROADMAP.md](ROADMAP.md)).
- `docs_pending` leads get a longer stale-sweep cutoff (30 days vs the usual 14)
  so a candidate mid-process isn't auto-closed as lost — see
  [src/leads/stale-sweep.ts](../src/leads/stale-sweep.ts).

## Operator interactions

### TG-chat-driven (Phase 1+4)

- **Approve / reject**: click inline button on lead card. Bot edits the card in-place to show the decision and removes the buttons.
- **Relay**: reply to a lead card with text / photo / video / document. Bot dispatches the content to the candidate's DM (passes through `file_id` — no re-upload). Bot acks under your message: `✅ отправлено в lead #N`. Recorded as `role='human'` with `meta.source='operator-relay'` so admin chat view shows it as operator-originated.

### Admin UI (any state)

- `/admin/leads` — pipeline list with filter pills by state. Each card shows intake progress + buttons appropriate to current state.
- `анкета` button (with a RU/EN toggle) — DMs the candidate the 15-point intake checklist in the chosen language. English is for international candidates who fill in English; Russian is the default.
- Button **`→ Lead`** on `/admin/chats/:id` — manual promote when auto-intake hasn't (or when `LEADS_CHAT_ID` is unset).
- Inline edit of visa fields — click `изменить` next to any field; Enter saves, Esc cancels; long fields render as textarea.
- `→ на визу` — allocates `application_id`, posts visa package to VISA_CHAT_ID, transitions to `docs_complete`. Idempotent on the id (re-press shows `↻ на визу` — re-posts same package, same id).
- `✅ подал` — shown on `docs_complete` leads. Records that the operator filed the application with the consulate: transitions to `submitted` and DMs the candidate her application id. The chat stays in `ai` mode (support mode handles the consulate wait).

## Templates

All operator-curated wording lives as plain string constants in [src/leads/templates.ts](../src/leads/templates.ts) so iteration doesn't require code review:

- `INTAKE_TEMPLATE` / `INTAKE_TEMPLATE_EN` — 15-point intake checklist, Russian and English. The operator picks the language per-lead via the RU/EN toggle next to the `анкета` button (`POST /admin/api/leads/:id/send-intake?lang=ru|en`, defaults to `ru`).
- `APPROVAL_PROLOGUE` — sent right after approve.
- `CONTRACT_TERMS` — verbatim contract terms (1500 ¥ penalty etc.).
- `VISA_ANKETA_TEMPLATE` — long English visa form (values filled in English, as in the passport).
- `VISA_PHOTO_REQUIREMENTS` — passport photo size + filled passport pages.
- `REJECTION_DEFAULT` — fallback rejection text (operator can pass `{reason: "..."}` to override).
- `AWAITING_APPROVAL_REPLY` — what the candidate sees while operator decides.
- `DOCS_COMPLETE_REPLY` — sent on `submit-to-visa` (promises a message with the application number).
- `SUBMITTED_REPLY` — sent on `mark-submitted`; substitutes `{applicationId}` and fulfils that promise.

## Files

| File | Role |
|------|------|
| [`migrations/pg_schema.sql`](../migrations/pg_schema.sql) | Single idempotent schema — `leads`, `lead_events`, `lead_notes` tables |
| [`src/db/repos/leads.ts`](../src/db/repos/leads.ts) | LeadsRepo: state transitions, `application_id` allocation, ops-card lookup |
| [`src/leads/templates.ts`](../src/leads/templates.ts) | All operator-facing message templates + `IntakeFields` schema |
| [`src/leads/intake.ts`](../src/leads/intake.ts) | Auto-extract intake fields from candidate messages |
| [`src/leads/visa-docs.ts`](../src/leads/visa-docs.ts) | Auto-extract 32 visa-application fields (18 required) |
| [`src/leads/service.ts`](../src/leads/service.ts) | LeadsService: card formatting, ops-chat posting, candidate relays, decision side effects |
| [`src/leads/stale-sweep.ts`](../src/leads/stale-sweep.ts) | Ghosted-lead auto-close (14d default, 30d for `docs_pending`) |
| [`src/admin/routes/leads.ts`](../src/admin/routes/leads.ts) | Lead REST handlers + `createLeadCallbackHandler` (TG approve/reject buttons) |
| [`src/telegram/lead-hooks.ts`](../src/telegram/lead-hooks.ts) | Post-reply hooks: auto-intake update, visa-docs update |
| [`src/telegram/process-inbound.ts`](../src/telegram/process-inbound.ts) | `resolveSupportPhase` — support mode while waiting on the visa process |
| [`admin-ui/src/pages/Leads.tsx`](../admin-ui/src/pages/Leads.tsx) | Pipeline view + per-card visa-docs editor |

## Tests

| Layer | File | Coverage |
|-------|------|----------|
| Repo | [`tests/unit/leads.test.ts`](../tests/unit/leads.test.ts) | state transitions, decision FK, application_id sequencing, byOpsMessage |
| Intake | [`tests/unit/intake.test.ts`](../tests/unit/intake.test.ts) | LLM parse, media SQL counter, threshold flags, isIntakeComplete |
| Visa docs | [`tests/unit/visa-docs.test.ts`](../tests/unit/visa-docs.test.ts) | parser shape, oversized/unknown-key filtering, completeness counter |
| Service | [`tests/unit/leads-relay.test.ts`](../tests/unit/leads-relay.test.ts) | relayFromOperator paths (text/photo/video/document), empty-input, meta persistence |
| Admin | [`tests/unit/admin-api.test.ts`](../tests/unit/admin-api.test.ts) | endpoints — list/promote/approve/reject/submit/mark-submitted/visa-docs PATCH/detail |
| Stale-sweep | [`tests/unit/stale-sweep.test.ts`](../tests/unit/stale-sweep.test.ts) | per-state cutoff — `docs_pending` 30d vs 14d default |
| Support prompt | [`tests/unit/sales/prompt.test.ts`](../tests/unit/sales/prompt.test.ts) | `composeSystemPrompt` support mode — sales blocks dropped, persona/KB kept |

## Operations checklist

- [ ] Create the two TG group chats; add the bot
- [ ] Promote bot to admin in `LEADS_CHAT_ID` (so it can edit cards)
- [ ] Set `LEADS_CHAT_ID` and `VISA_CHAT_ID` in `.env`
- [ ] Restart container — `docker compose restart app`
- [ ] Verify in `/admin/status` → "Leads pipeline" card that both chats show "configured"
- [ ] First candidate: send a test message → confirm bot replies with persona, intake fields accumulate in `/admin/leads`
- [ ] When auto-promote fires, click approve → confirm anketa templates land in candidate's DM
- [ ] Pop a photo into the LEADS chat as a reply to the card → confirm relay to candidate works
- [ ] After visa form filled, press `→ visa submit` → confirm package + application_id appears in VISA chat
