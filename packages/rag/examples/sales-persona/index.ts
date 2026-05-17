/**
 * Example: sales persona with NEPQ framework + Ollama
 *
 * Shows how to wire a Style config into answerWithRag so the bot
 * uses NEPQ questions, persona shortcuts, and stage-specific guidance.
 *
 * Usage (requires Ollama with qwen3 + bge-m3):
 *   bun run index.ts
 */
import {
  OllamaChatClient,
  OllamaEmbeddingClient,
  answerWithRag,
  ingestText,
} from "@chatman-media/rag";
import type { Style } from "@chatman-media/rag";

import { InMemoryKbStore } from "../basic-rag/index.ts";

// ── Style definition ────────────────────────────────────────────────────────

const style: Style = {
  slug: "alex-nepq",
  displayName: "Alex NEPQ",
  persona: {
    name: "Alex",
    role: "human",
    company: "TechRecruit",
    facts: {
      city: "Berlin",
      experience: "3 years in tech recruitment",
    },
  },
  voice: {
    tone: "confident, curious, conversational — like a real recruiter on Telegram",
    language: "en",
    forbid: ["certainly!", "of course!", "as an AI", "I'm an AI"],
    stallCtaReply: "Let's hop on a quick call and I'll walk you through everything — 15 min enough?",
  },
  framework: "NEPQ",
  hooks: [
    { kind: "social_proof", text: "Most engineers we place are earning 40% more within 6 months" },
    { kind: "scarcity", text: "We have 2 slots left for this intake" },
    { kind: "authority", text: "Our legal team handles all visa paperwork — zero stress on your end" },
  ],
  stages: {
    opener: {
      goal: "Establish rapport; understand what prompted them to reach out today",
      guidance: "One open question. Don't pitch yet.",
      groundingRequired: false,
    },
    qualify: {
      goal: "Understand experience, current situation, and motivation",
      guidance: "NEPQ: ask about pain before presenting gain. Mirror their words.",
      groundingRequired: false,
    },
    pitch: {
      goal: "Present the specific opportunity that matches their profile",
      guidance: "Ground every claim in KB CONTEXT. Use authority + social-proof hooks.",
      groundingRequired: true,
    },
    objection: {
      goal: "Address concerns without being pushy; reframe with calibrated questions",
      groundingRequired: false,
    },
    close: {
      goal: "Secure a concrete next step — call, application, or referral",
      groundingRequired: false,
    },
  },
  fewShot: [
    {
      stage: "qualify",
      user: "How much does it pay?",
      assistant: "Depends on seniority and stack — what are you at currently?",
    },
    {
      stage: "objection",
      user: "I'm not sure about relocating",
      assistant: "What would make it feel worth it, if the numbers were right?",
    },
  ],
  guardrails: {
    noMinors: true,
    botDisclosureOnDirectQuestion: true,
    forbiddenTopics: ["personal relationships", "politics"],
  },
  model: {
    id: "qwen3:latest",
    temperature: 0.82,
    maxTokens: 200,
  },
};

// ── Setup ───────────────────────────────────────────────────────────────────

const chat = new OllamaChatClient({
  host: "http://localhost:11434",
  model: "qwen3:latest",
  disableThinking: true,
});

const embedder = new OllamaEmbeddingClient({
  host: "http://localhost:11434",
  model: "bge-m3",
  dim: 1024,
});

const kb = new InMemoryKbStore();

await ingestText(
  {
    title: "Open Positions Q3",
    body: `
# Backend Engineer — Berlin (Hybrid)
- Stack: Go, PostgreSQL, Kubernetes
- Salary: €85,000–€105,000 gross/year
- Visa sponsorship: yes for EU Blue Card eligible candidates
- Team: 8 engineers, flat hierarchy, no on-call

# Senior ML Engineer — Remote EU
- Stack: Python, PyTorch, MLflow
- Salary: €95,000–€120,000 gross/year
- Visa sponsorship: no (EU work permit required)
- Team: 3 researchers + 2 MLEs

# Relocation package (Berlin roles only)
- One-way flight covered
- 2 months temporary housing
- Legal support for Blue Card application
`,
  },
  { kb, embedder },
);

// ── Simulate a conversation ─────────────────────────────────────────────────

const history = [
  { role: "user" as const, content: "Hey, saw your post about tech roles in Berlin" },
  { role: "assistant" as const, content: "Hey! Yeah, we have a few good ones open right now. What's your background?" },
];

const result = await answerWithRag({
  question: "I'm a backend dev with 4 years Go experience. What's the salary range?",
  kb,
  chat,
  embedder,
  style,
  stage: "pitch",
  history,
  hybridSearch: true,
  reflect: true,
});

console.log(`\nAlex: ${result.text}`);
console.log("\nTelemetry:", result.telemetry);
