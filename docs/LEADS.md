# Lead pipeline

End-to-end воронка кандидата от знакомства до подачи на визу. Бот сам ведёт диалог через RAG + persona, авто-собирает анкету, эскалирует решение оператору в TG-чат, после одобрения собирает структурированные данные на визу, и финально передаёт пакет с auto-generated `application_id` в чат подачи.

```
candidate writes  →  bot RAG-replies + collects intake (height/weight/photos/...)
                              ↓ (auto when 7-item intake complete)
                     intake_complete  →  card posted to LEADS_CHAT_ID
                                          [✅ Одобрить] [❌ Отклонить]
                              ↓ operator clicks
                          approved  →  bot DMs visa anketa template
                              ↓
                       docs_pending  →  bot auto-extracts 27 visa fields
                                       admin can manually edit any
                              ↓ operator clicks "→ visa submit"
                       docs_complete  →  package posted to VISA_CHAT_ID
                                         with VS-YYYY-NNNN
                              ↓
                          submitted  →  operator submits to consulate
```

## Configuration

Two TG group chats (operator-managed):

```bash
LEADS_CHAT_ID=-100123456789       # operator chat for new lead cards
VISA_CHAT_ID=-100987654321        # ops chat for the visa submission package
```

Bot must be a **member** of both (admin role lets it edit cards in place after approve/reject — recommended). When `LEADS_CHAT_ID` is unset, the pipeline still works through `/admin/leads` only — auto-intake auto-promote is disabled (would have nowhere to surface) and operator promotes manually via the chat page button.

## State machine

| State | Meaning | How you get here | What bot does |
|-------|---------|-----------------|---------------|
| `intake_pending` | Default for any new candidate | Created on first message | Collects 7 items via natural conversation; auto-extracts fields each turn |
| `intake_complete` | Anketa filled — awaiting operator decision | All 7 items received | Posts card to ops chat; tells candidate "ждите, отправили запрос" |
| `approved` | Operator approved | inline button OR `/admin/api/leads/:id/approve` | Sends 4-message visa anketa pack to candidate; transitions to `docs_pending` |
| `rejected` | Operator rejected (terminal) | inline button OR endpoint | Sends polite rejection (or operator's custom reason) |
| `docs_pending` | Bot collecting visa form | After approve | Auto-extracts 27 fields from each candidate message; operator can edit any |
| `docs_complete` | All visa data + package posted | Operator clicks "→ visa submit" | Allocates `VS-YYYY-NNNN`, posts to VISA_CHAT_ID, DMs candidate "передаём в работу" |
| `submitted` | Operator confirmed consulate submission | Manual transition (or `/admin/api/leads/:id/submit-to-visa` re-call) | — |
| `closed` | Terminal cleanup state | Manual | — |

## Intake schema (7 items)

Auto-tracked via [src/leads/intake.ts](../src/leads/intake.ts). Three are LLM-extracted from text, four are SQL-counted from media metadata.

| Field | Source | Threshold |
|-------|--------|-----------|
| `height` | LLM extracts from text | non-empty |
| `weight` | LLM extracts from text | non-empty |
| `city` | LLM extracts from text | non-empty |
| `departure_readiness` | LLM extracts from text | non-empty |
| `photos_count` | SQL `json_extract($.media.type='photo')` | ≥ 6 |
| `videos_count` | SQL `json_extract($.media.type='video')` | ≥ 2 |
| `passport_photo_received` | Heuristic: photos_count ≥ 7 → assume passport-photo present | true |
| `dance_video_received` | Heuristic: videos_count ≥ 3 → assume dance-video present | true |

When all 8 conditions hold + state == `intake_pending` → auto-transition to `intake_complete`. Operator confirms by eye in TG before pressing approve.

## Visa-docs schema

Auto-extracted by [src/leads/visa-docs.ts](../src/leads/visa-docs.ts) once per `docs_pending` turn. Subset of the long English visa anketa — 27 fields covering identity, passport, contact, parents, China history, work/education/travel as free-form blocks. Schema in `VisaFields` interface. 17 of them are required (must-haves before consulate submission); the admin UI shows a `N/17 (xx%)` progress strip.

Operator's manual edits via `PATCH /admin/api/leads/:id/visa-docs` are **preserved** across subsequent extractor runs — the LLM prompt explicitly asks not to re-emit unchanged fields, and the merge logic only overwrites fields the LLM newly returns.

## Operator interactions

### TG-chat-driven (Phase 1+4)

- **Approve / reject**: click inline button on lead card. Bot edits the card in-place to show the decision and removes the buttons.
- **Relay**: reply to a lead card with text / photo / video / document. Bot dispatches the content to the candidate's DM (passes through `file_id` — no re-upload). Bot acks under your message: `✅ отправлено в lead #N`. Recorded as `role='human'` with `meta.source='operator-relay'` so admin chat view shows it as operator-originated.

### Admin UI (any state)

- `/admin/leads` — pipeline list with filter pills by state. Each card shows intake progress + buttons appropriate to current state.
- Button **`→ Lead`** on `/admin/chats/:id` — manual promote when auto-intake hasn't (or when `LEADS_CHAT_ID` is unset).
- Inline edit of visa fields — click `edit` next to any field; Enter saves, Esc cancels; long fields render as textarea.
- `→ visa submit` — allocates `application_id`, posts visa package, transitions to `docs_complete`. Idempotent on the id (re-press triggers `↻ resend visa` — re-posts same package, same id).

## Templates

All operator-curated wording lives as plain string constants in [src/leads/templates.ts](../src/leads/templates.ts) so iteration doesn't require code review:

- `INTAKE_TEMPLATE` — 7-item checklist sent to a new candidate (operator triggers via `POST /admin/api/leads/:id/send-intake` or pastes manually).
- `APPROVAL_PROLOGUE` — sent right after approve.
- `CONTRACT_TERMS` — verbatim contract terms (1500 ¥ penalty etc.).
- `VISA_ANKETA_TEMPLATE` — long English visa form.
- `VISA_PHOTO_REQUIREMENTS` — passport photo size + filled passport pages.
- `REJECTION_DEFAULT` — fallback rejection text (operator can pass `{reason: "..."}` to override).
- `AWAITING_APPROVAL_REPLY` — what the candidate sees while operator decides.
- `DOCS_COMPLETE_REPLY` — sent on `submit-to-visa`.

## Files

| File | Role |
|------|------|
| [`migrations/009_leads.sql`](../migrations/009_leads.sql) | `leads` table with state machine + ops-card persistence |
| [`src/db/repos/leads.ts`](../src/db/repos/leads.ts) | LeadsRepo: state transitions, `application_id` allocation, ops-card lookup |
| [`src/leads/templates.ts`](../src/leads/templates.ts) | All operator-facing message templates |
| [`src/leads/intake.ts`](../src/leads/intake.ts) | Auto-extract 7-item intake from candidate messages |
| [`src/leads/visa-docs.ts`](../src/leads/visa-docs.ts) | Auto-extract 27 visa-application fields |
| [`src/leads/service.ts`](../src/leads/service.ts) | LeadsService: card formatting, ops-chat posting, candidate relays, decision side effects |
| [`src/admin/api.ts`](../src/admin/api.ts) | `createListLeadsHandler` and friends — 9 lead-related endpoints |
| [`src/telegram/webhook.ts`](../src/telegram/webhook.ts) | Auto-intake update, visa-docs update, operator-relay dispatch on reply-to-card, callback_query approve/reject handler |
| [`admin-ui/src/pages/Leads.tsx`](../admin-ui/src/pages/Leads.tsx) | Pipeline view + per-card visa-docs editor |

## Tests

| Layer | File | Coverage |
|-------|------|----------|
| Repo | [`tests/unit/leads.test.ts`](../tests/unit/leads.test.ts) | state transitions, decision FK, application_id sequencing, byOpsMessage |
| Intake | [`tests/unit/intake.test.ts`](../tests/unit/intake.test.ts) | LLM parse, media SQL counter, threshold flags, isIntakeComplete |
| Visa docs | [`tests/unit/visa-docs.test.ts`](../tests/unit/visa-docs.test.ts) | parser shape, oversized/unknown-key filtering, completeness counter |
| Service | [`tests/unit/leads-relay.test.ts`](../tests/unit/leads-relay.test.ts) | relayFromOperator paths (text/photo/video/document), empty-input, meta persistence |
| Admin | [`tests/unit/admin-api.test.ts`](../tests/unit/admin-api.test.ts) | endpoints — list/promote/approve/reject/submit/visa-docs PATCH/detail |

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
