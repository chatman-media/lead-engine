# Competitor Landscape — lead-engine

Last updated: 2026-05. Sources cited inline; pricing snapshots are public-list figures and shift quarterly — re-verify before quoting in pitches.

## 1. Context

We are building **lead-engine** — a multi-tenant SaaS where a business:

1. Signs up, plugs in **its own** OpenAI / Anthropic API key (BYOK).
2. Connects channels: **Telegram-first**, then WhatsApp, web widget, eventually IG / VK / Avito.
3. Uploads documents → RAG knowledge base.
4. AI replies to inbound leads; **operator** can intercept and take over.

Target segments: SMB, edtech, recruitment, e-commerce support, real estate, telecom retail, medical clinics — any business with inbound messenger funnel. Geo focus: RU / CIS / MENA / SEA where Telegram dominates and Western tools either ignore it or treat it as an afterthought.

The market is bifurcated:

- **Top end** ($100K–$1M ACV): Sierra, Decagon, Ada, Cognigy, Forethought — agent platforms for F500.
- **Middle** ($30–$500/mo): Intercom Fin, Tidio Lyro, Crisp, Chatbase, CustomGPT — SMB-mid-market SaaS.
- **Bottom** ($0–$50/mo): ManyChat, Botpress free tier, OSS Rasa — flow builders, hobbyists, small marketing teams.

lead-engine targets the middle band with a moat the middle does not have: BYOK + Telegram-native + multi-tenant + operator handoff + open-source-ready.

---

## 2. Competitor Table

| # | Vendor | Tier | What they do | Headline price (2025–2026) | Sweet-spot customer | Our differentiator |
|---|--------|------|---------------|----------------------------|---------------------|--------------------|
| 1 | **Chatbase** | Mid (SMB) | Upload PDFs / URLs → chatbot widget; 11M chars; AI Actions, Stripe/Calendly/Zendesk hooks. | Hobby $40, Standard $150, Pro $500/mo; extra credits $12/1K | Solopreneur, SaaS landing-page widget | BYOK (they bundle inference), real Telegram support, operator handoff |
| 2 | **Sierra** | Enterprise | Voice + chat outcome-based agent for F500 retail / fintech / telecom. $10B Series C 2025, $15.8B Series E May 2026. | Custom — Y1 TCO **$200K–$350K+**; outcome-based | F500 retail, fintech (SoFi, Ramp, Brex) | We do not compete; we are the on-ramp before they sign a Sierra contract |
| 3 | **Decagon** | Enterprise | "Concierge" agent for consumer brands. $250M Series D Jan 2026, $4.5B valuation. Per-conversation / per-resolution pricing. | Custom — multi-six-figure | Notion, Duolingo, Affirm, Chime, airlines, telecom | Same as Sierra — they are the aspirational tier-above |
| 4 | **Ada CX** | Enterprise | Omnichannel AI agent on Zendesk/Salesforce. Resolution-based pricing $1–$3.50/ticket. | From **$30K/yr**, typical $50K–$300K+ | 300K+ tickets/yr CX teams | Pricing transparency, BYOK, Telegram-native |
| 5 | **Intercom Fin** | Mid-Enterprise | Bolt-on AI agent on top of Intercom helpdesk. Per-resolution billing. | **$0.99 / resolution** + Intercom seat fee; 50-resolution min if external helpdesk | Existing Intercom customers | Channel-agnostic, no helpdesk lock-in, BYOK, Telegram |
| 6 | **Forethought** | Mid-Enterprise | Agentic multi-channel resolution + Agent QA + Browser Agents (Oct 2025). | Custom — median ACV **~$56–60K/yr** (Vendr) | Mid-market support teams on Zendesk | Cheaper entry, Telegram, self-host path |
| 7 | **Ada (Tidio) Lyro** | Mid (SMB) | Tidio's AI agent for e-commerce; web chat, email, Messenger, IG, WhatsApp. **No native Telegram**. | Lyro from **$39/mo** for 100 convos; Tidio Starter $24/mo | Shopify stores, e-com SMB | **Telegram-first**, BYOK, multi-tenant agency mode |
| 8 | **Crisp + MagicReply** | Mid (SMB) | Omnichannel inbox with AI reply suggester. Channels: WhatsApp, IG, Messenger, **Telegram**, SMS, Line, Viber, Discord. | Mini $45, Essentials $95, Plus $295, Unlimited $495/mo (flat per workspace) | EU SMB, multi-channel teams | Deeper RAG, BYOK, agent autonomy (Crisp is more co-pilot than autonomous) |
| 9 | **ManyChat** | Bottom | Flow-builder for IG / Messenger / **Telegram** / WhatsApp / SMS marketing. AI is a $29/mo add-on, "single-step response in flows". | Free; Pro $15+ scaling fast with contacts; AI add-on $29 | Influencer / e-com marketers | Real RAG over docs, real operator handoff, not a marketing flow tool |
| 10 | **Voiceflow** | Mid (Dev) | Visual builder for chat + voice agents. Multi-LLM. Credit-based since Apr 2025. | Pro **$60/mo** + $50/editor; Business $150/mo; credits extra | Conversation designers, devs | We are turn-key vertical (CX/leads); they are a general-purpose builder |
| 11 | **Botpress** | Bottom / Dev | Open-source + cloud agent builder. $25M Series B 2025. | OSS free self-host; Cloud Free $0; Plus $89; Team $495; Enterprise from ~$2K/mo + LLM | Devs, agencies | Vertical product, not framework; faster to value for non-devs |
| 12 | **CustomGPT.ai** | Mid (SMB) | Anti-hallucination-focused RAG bot; 1,400 doc formats, 92 languages. | Standard $99, Premium $499/mo | Knowledge-heavy SMB, multilingual docs | Channel coverage (they are web-widget-first), operator inbox, Telegram |
| 13 | **Rasa Pro** | Enterprise / OSS | Open-source NLU framework + Rasa Pro / Studio. | OSS free; Rasa Pro from **~$35K/yr** | Enterprises with in-house ML team, regulated industries | We are out-of-the-box SaaS; they need a team to operate |
| 14 | **Cognigy** (now NiCE Cognigy, acquired Sep 2025 for ~$955M) | Enterprise | Conversational AI for contact centers, voice + chat. | From **$2.5K/mo** entry; typical ACV **$115K**, TCO $700K+ | F1000 contact centers, telco, banking | Self-serve onboarding, BYOK, no NICE/CXone lock-in |
| 15 | **Sendbird AI Agent** | Mid-Enterprise | Chat infra + AI agent on top; MAU-based. | Starter **$349/mo** @ 5K MAU; Pro $499; Enterprise custom | In-app messaging-heavy products | Vertical CX product, not infra SDK; Telegram out of the box |
| 16 | **Helpshift** | Mid | In-app support + AI for mobile-first apps. | Starter **$150/mo** for 250 issues; $0.45/extra issue | Mobile gaming, mobile apps | Multi-channel beyond in-app; Telegram-native |
| 17 | **Help Scout AI Agent** | Mid | Email-first helpdesk with new AI agent + AI resolutions. | Help Scout per-contact + AI **$0.75/resolution** | Email-heavy SMB | Messenger-first, real-time channels, not email-centric |
| 18 | **eesel AI** | Mid | "Wrapper" AI agent that plugs into existing helpdesks (Zendesk, Freshdesk, Intercom). | From ~$49/mo to enterprise quote | Teams already on a helpdesk wanting AI bolted on | We replace, not augment; we own the channel + operator UX |
| 19 | **OSS alternatives**: LibreChat, AnythingLLM, Chatwoot + LLM plugins, Typebot, Flowise | OSS | Self-host RAG / chat / flow builder. | Free | Devs, privacy-conscious SMB | Turn-key SaaS + managed Telegram + tenant isolation; OSS users are upgrade candidates when ops cost > $99/mo |

Sierra funding: $350M Series C at $10B (Sep 2025), $950M Series E at $15.8B (May 2026). Decagon: $131M Series C @ $1.5B (Jun 2025), $250M Series D @ $4.5B (Jan 2026). Cognigy: acquired by NICE for ~$955M (Sep 2025). Botpress: $25M Series B (2025).

---

## 3. Positioning Map

```
                     HIGH AUTONOMY (agent acts)
                              ▲
                Sierra ●  ● Decagon
                              │
                        Ada ● │ ● Forethought
                              │ ● Cognigy
              Intercom Fin ● │
                              │   ● lead-engine (target)
                  CustomGPT ● │ ● Chatbase
                  Lyro/Tidio ●│ ● Crisp MagicReply
                              │ ● Sendbird AI
                              │
                  Botpress ●  │ ● Voiceflow
                              │ ● Rasa
                              │
                   ManyChat ●─┴────────────────►
                              flow / co-pilot / suggestion
   GENERIC HORIZONTAL ◄───────┼───────► VERTICAL / CX-SPECIFIC
                              ▼
                       LOW AUTONOMY
```

**Where lead-engine wins**

- Telegram-native (Sierra, Decagon, Ada, Lyro, Helpshift do not treat Telegram as first-class).
- BYOK — customer's OpenAI / Anthropic bill, no markup. None of Chatbase / Tidio / Intercom / Sierra do this; they bundle inference into seat/resolution pricing.
- Multi-tenant agency mode out of the box (single admin, many sub-tenants, isolated knowledge bases) — useful for marketing agencies, recruitment networks, franchise telco retail.
- Operator handoff first-class, not a separate $300/mo helpdesk SKU.
- Self-host / on-prem story for regulated verticals (medical clinics, banks, gov) — only Rasa and Botpress OSS match, and they need an ML team.

**Where lead-engine loses (today)**

- No voice channel (Sierra, Decagon, Cognigy, Forethought all ship voice; voice is 19% of contact-center volume in 2026).
- No Salesforce / Zendesk / HubSpot deep integrations — enterprises will not migrate off those.
- No Agent QA / scoring layer like Forethought's.
- No SOC 2 / HIPAA / ISO certifications yet — table stakes for $100K+ ACV.
- Smaller LLM evaluation harness than Sierra / Decagon (they tune per-customer).

---

## 4. Pricing Benchmarks (for our business plan)

| Tier | Vendor anchors | Typical ACV / monthly | What lead-engine should charge |
|------|----------------|-----------------------|--------------------------------|
| **Free / hobby** | Chatbase Free, Botpress Free, ManyChat Free | $0, capped at ~100–1K msgs | Free: 1 tenant, 100 LLM-replied msgs/mo, BYOK only — funnel hook |
| **SMB Starter** | Chatbase Hobby $40, Tidio $24+, Lyro $39, Threado $49, Helpshift $150 | $30–$150/mo | **$49/mo**: 1 tenant, Telegram + 1 channel, 2K msgs, 1 operator, BYOK |
| **SMB Growth** | Chatbase Standard $150, Crisp Essentials $95, Lyro $79–149, Tidio mid | $80–$200/mo | **$149/mo**: 3 channels, 10K msgs, 3 operators, RAG up to 50MB, agency mode preview |
| **Pro / agency** | Chatbase Pro $500, Crisp Plus/Unlimited $295–495, Botpress Team $495, Sendbird Starter $349 | $300–$700/mo | **$499/mo**: unlimited tenants for one org, 50K msgs, white-label, SLA |
| **Enterprise / self-host** | Rasa Pro $35K+/yr, Cognigy $2.5K+/mo, Forethought $56K/yr, Ada $30K+/yr | $30K–$300K/yr | **From $24K/yr** for on-prem deployment + support; usage tiers on top |

Add-on logic to mirror the market:

- LLM tokens — pass-through (BYOK) or +15% markup if we provide the key as convenience SKU.
- Per-resolution upcharge (à la Fin's $0.99, Help Scout's $0.75) only on the Enterprise self-host tier where outcome-based makes sense.
- WhatsApp conversation fees pass-through (Meta's $0.02–$0.08 like ManyChat).

Key signal: middle-of-the-market customers are tired of opaque per-resolution pricing (a Reddit pattern across Ada / Fin / Decagon reviews — "success makes your bill go up"). A flat-seat / flat-msg cap with BYOK is a clear positioning wedge.

---

## 5. Channel Coverage Matrix

| Channel        | lead-engine | Chatbase | Sierra | Decagon | Intercom Fin | Tidio Lyro | Crisp | ManyChat | Voiceflow | Botpress | CustomGPT | Forethought | Ada | Cognigy |
|----------------|:-----------:|:--------:|:------:|:-------:|:------------:|:----------:|:-----:|:--------:|:---------:|:--------:|:---------:|:-----------:|:---:|:-------:|
| **Telegram**   | ✅ first    | partial  | ❌     | ❌      | ❌           | **❌ (Zapier only)** | ✅ | ✅       | via API   | ✅       | ❌        | partial     | ❌  | partial |
| Web widget     | ✅          | ✅       | ✅     | ✅      | ✅           | ✅         | ✅    | ❌       | ✅        | ✅       | ✅        | ✅          | ✅  | ✅      |
| WhatsApp       | ✅ (planned)| via API  | ✅     | ✅      | ✅           | ✅         | ✅    | ✅       | via API   | ✅       | ❌        | ✅          | ✅  | ✅      |
| Instagram DM   | ⏳          | ❌       | ❌     | ❌      | ✅           | ✅         | ✅    | ✅       | ❌        | ✅       | ❌        | ❌          | ✅  | ❌      |
| Facebook Mess. | ⏳          | ❌       | ✅     | ✅      | ✅           | ✅         | ✅    | ✅       | ❌        | ✅       | ❌        | ✅          | ✅  | ✅      |
| Voice          | ❌          | ❌       | ✅     | ✅      | ❌           | ❌         | ❌    | ❌       | ✅        | partial  | ❌        | ✅          | ✅  | ✅      |
| Email          | ⏳          | ❌       | ✅     | ✅      | ✅           | ✅         | ✅    | ❌       | ❌        | partial  | ❌        | ✅          | ✅  | ✅      |
| Slack / Discord| ⏳          | ✅       | ❌     | partial | ❌           | ❌         | ❌    | ❌       | ✅        | ✅       | ✅        | ✅          | partial | ✅ |
| VK / Avito / OK| ⏳ moat     | ❌       | ❌     | ❌      | ❌           | ❌         | ❌    | ❌       | ❌        | ❌       | ❌        | ❌          | ❌  | ❌      |

**The Telegram blind spot is real.** Tidio requires Zapier for Telegram. Intercom Fin has no Telegram. Sierra / Decagon / Ada / Forethought ignore it. Crisp and ManyChat have it but treat it as one of many — not the primary channel. For markets where Telegram = SMS (RU, CIS, IR, UA, KZ, UZ, RS, BY, parts of MENA, Indonesia, Vietnam), this is a defensible niche.

VK / Avito / OK is bonus moat — zero non-Russian vendor will ever ship it.

---

## 6. What Competitors Cannot / Will Not Do — Our Moat

1. **BYOK as a feature, not a hack.** Sierra, Decagon, Intercom Fin, Chatbase, CustomGPT, Tidio all *bundle* LLM inference into seat/resolution fees with 30–80% margin on top. A $20K/mo CX team in Tbilisi or Riyadh that already has an Anthropic enterprise contract cannot use that contract on Intercom Fin. lead-engine lets them — and that is a direct ACV reducer for the customer (often 40–60% off vs Fin's $0.99/resolution).

2. **Data sovereignty / on-prem.** Sierra and Decagon are SaaS-only on AWS US/EU. Rasa Pro and Botpress OSS allow self-host but require an ML team. lead-engine's Docker-compose-able single-binary deployment for regulated verticals (private clinics, banks, defence contractors, gov procurement in non-US jurisdictions) is a real wedge.

3. **Telegram-first DX.** All competitors that "support" Telegram make you go through Zapier, BotFather copy-paste, or a 3-step OAuth that breaks at scale. We can have a tenant connected in <60 seconds.

4. **Multi-tenant out of the box.** Most platforms charge per workspace / per bot, making agency reselling expensive. Botpress and ManyChat have agency tiers but they are marketing-flow oriented. lead-engine can ship a "marketing agency" plan with 10–50 sub-tenants under one billing entity — recruitment networks, edtech franchise schools, telecom retail chains will pay for this.

5. **Operator handoff as a first-class object,** not a $300/mo helpdesk bolt-on. Crisp does this well; Sierra and Decagon assume the agent fully resolves. The reality for SMB is 60–80% AI + 20–40% human, and the handoff UX is where customers churn from Fin / Lyro.

6. **Open-source-ready core.** A public-source community edition (MIT / AGPL-ish) for the core RAG + Telegram bot, with a closed managed plane (billing, analytics, hosted operator UI), buys us:
   - SEO / dev mindshare vs Botpress, Rasa.
   - Trust in privacy-conscious markets (DACH, MENA gov procurement).
   - A free "downgrade" path that captures customers who would otherwise churn to OSS.

7. **Lead funnel + sales personas baked in.** Sierra / Decagon focus on *support*. Chatbase / CustomGPT focus on *FAQ*. ManyChat focuses on *broadcast marketing*. lead-engine sits on the *inbound lead → qualification → handoff* axis with persona scripts (recruitment intake, real-estate qualifier, edtech consultant) — vertical templates ship Day 1. No horizontal competitor does this without a 4-week paid implementation.

---

## 7. Industry Trends 2025–2026 — Where to Skate

1. **Outcome-based pricing is winning** but creating budget anxiety. Fin's $0.99/resolution, Help Scout's $0.75, Ada's $1–$3.50/ticket all signal the direction. Our move: offer it as a tier-3 option, lead with predictable flat-fee + BYOK to differentiate.

2. **Vertical agents > horizontal platforms.** Industry-specific AI is growing at 36.5% CAGR vs 18.9% for horizontal tools (Google Cloud AI Agent Trends 2026). Vertical templates (recruitment intake, dental clinic booking, real-estate viewing scheduling, telco SIM-swap support) will be more valuable than yet-another-builder. lead-engine should ship 5–8 vertical packs in 2026.

3. **Voice is going from niche to baseline.** 19% of contact-center inbound is voice-AI in 2026 vs 6% in 2024. Sierra, Decagon, Cognigy, Voiceflow, Ada are all voice-first or voice-equal. **Roadmap implication:** integrate ElevenLabs / Deepgram / OpenAI Realtime in H2 2026; offer Telegram voice messages → transcribe → reply as low-hanging fruit before full PSTN.

4. **Multimodal — image + video.** Multimodal is now table stakes for any 2026 RFP. Inbound photos (product damage, document upload, dance audition video for recruiting — our own intake skill ships this) need to be a first-class object, not a "we forward attachments to the operator".

5. **Autonomous workflows / agentic actions.** Chatbase has "AI Actions" (Stripe, Calendly), Forethought has Browser Agents, Sierra has tool-use. Reading and writing into customer's CRM (AmoCRM, Bitrix24 in RU; HubSpot, Salesforce elsewhere) is the next axis. lead-engine should ship a small "Actions" SDK in 2026 — Telegram-native businesses live on AmoCRM / Bitrix24, and those integrations are uncontested by Western vendors.

6. **Compliance and data residency.** EU AI Act, Russian 152-FZ, KSA NDMO, UAE DPL — all 2025–2026 enforcement. Self-host + region-pinned managed instances are a 2026 must-have for selling to mid-market in these regions.

7. **Agent QA / scoring as a SKU.** Forethought, Ada, Sierra all monetize "QA over 100% of conversations" separately. We should ship LLM-as-judge scoring (we are halfway there with self-play) as a paid analytics layer in Growth+.

8. **OSS commoditisation of the framework.** LibreChat, AnythingLLM, Chatwoot + LLM plugins, Flowise, Typebot mean the "RAG + chat UI" undifferentiated layer is rapidly going to zero. Defensibility moves up the stack: vertical templates, channel-native UX, operator workflows, billing, compliance — all places where lead-engine should plant flags.

---

## 8. Action Items (engineering & GTM)

1. **Ship Telegram-first onboarding flow** that hits "AI replying to a real lead" in <5 minutes — this is the single most defensible demo vs Tidio / Intercom / Sierra in our geos.
2. **BYOK billing UI** — explicit "you connect your Anthropic key, we charge $49 platform fee, that is it" pitch. Put a side-by-side calculator on the marketing site vs Fin's $0.99 × N resolutions and Chatbase's bundled credits.
3. **5 vertical templates by EOY 2026**: recruitment intake (we have it), dental clinic booking, real-estate qualifier, telco SIM-swap, edtech course consultant. Each is a 1-week effort and a 10x marketing asset.
4. **Operator inbox parity with Crisp** — this is the table-stakes UX our competitors gate behind $200+ helpdesk SKUs.
5. **Public-source the core** under AGPL by Q4 2026 — SEO play, dev trust, OSS users are upgrade pipeline.
6. **AmoCRM + Bitrix24 integrations** — uncontested by every Western vendor on this page; binds us to RU/CIS SMB.
7. **Compliance roadmap**: SOC 2 Type I by mid-2027, 152-FZ-compatible RU hosting partner, ISO 27001 path. Without this, the $24K+/yr self-host tier will not close.

---

## Sources

- [Chatbase Pricing](https://www.chatbase.co/pricing); [Chatbase review 2025 — eesel AI](https://www.eesel.ai/blog/chatbase)
- [Sierra Series C $10B — TheAIInsider](https://theaiinsider.tech/2025/09/05/sierra-announces-350m-in-funding-at-10b-valuation-to-expand-ai-customer-service-agents/); [Sierra pricing & alternatives — Lorikeet](https://www.lorikeetcx.ai/articles/sierra-ai-pricing-alternatives); [Sierra revenue & funding — Sacra](https://sacra.com/c/sierra/)
- [Decagon Series D $4.5B — BusinessWire](https://www.businesswire.com/news/home/20260128580542/en/Decagons-Valuation-Triples-to-$4.5-Billion-as-it-Ushers-in-the-Age-of-AI-Concierge); [Decagon equity research — Sacra](https://sacra.com/c/decagon/)
- [Intercom Fin pricing](https://fin.ai/pricing); [Fin per-resolution guide — eesel AI](https://www.eesel.ai/blog/intercom-fin-ai-pricing-per-resolution-2025)
- [Tidio Lyro pricing](https://www.tidio.com/pricing/); [Lyro pricing breakdown — eesel AI](https://www.eesel.ai/blog/lyro-ai-pricing)
- [Crisp pricing](https://crisp.chat/en/pricing/); [Crisp pricing guide — eesel AI](https://www.eesel.ai/blog/crisp-pricing)
- [ManyChat pricing](https://manychat.com/pricing); [ManyChat real costs — Flowgent](https://flowgent.ai/blog/manychat-pricing)
- [Voiceflow pricing](https://www.voiceflow.com/pricing); [Voiceflow pricing guide — eesel AI](https://www.eesel.ai/blog/voiceflow-pricing)
- [Botpress pricing](https://botpress.com/pricing); [Botpress pricing — eesel AI](https://www.eesel.ai/blog/botpress-pricing)
- [CustomGPT.ai pricing](https://customgpt.ai/pricing/)
- [Ada CX pricing — eesel AI](https://www.eesel.ai/blog/ada-cx-pricing)
- [Rasa pricing](https://rasa.com/pricing)
- [Cognigy pricing — Vendr](https://www.vendr.com/buyer-guides/cognigy-ai); [NICE acquires Cognigy — Crunchbase](https://www.crunchbase.com/organization/cognigy)
- [Forethought pricing — eesel AI](https://www.eesel.ai/blog/forethought-pricing)
- [Sendbird AI pricing — VideoSDK](https://www.videosdk.live/developer-hub/social/sendbird-pricing-comprehensive-guide)
- [Helpshift pricing — eesel AI](https://www.eesel.ai/blog/helpshift-pricing); [Help Scout AI pricing — eesel AI](https://www.eesel.ai/blog/helpscout-ai-resolutions-pricing)
- [Customer service trends 2026 — Robylon](https://www.robylon.ai/blog/11-customer-service-trends-2026); [AI agent trends 2026 — Google Cloud](https://cloud.google.com/resources/content/ai-agent-trends-2026); [Vertical AI Agents 2026 — ACTGSYS](https://actgsys.com/en/blog/vertical-ai-agents-industry-specific-2026)
- [Telegram CRM Eastern Europe context — Sinch](https://sinch.com/blog/telegram-bot-for-business/); [Telegram marketing stats 2026 — AffDude](https://affdude.com/telegram-marketing-statistics/)
- [BYOK trend — Surfmind](https://surfmind.ai/blog/byok-bring-your-own-key-future-of-ai-tools); [BYOKList directory](https://byoklist.com/)
