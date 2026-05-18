// Webhook-level coverage of the step-by-step visa interview in
// `maybeHandleVisaInterview` (process-inbound.ts):
//  - `reply()` style-guards every outgoing message (em-dashes in the
//    static question templates never reach the candidate);
//  - the LLM answer interpreter applies a structured patch, fixes
//    earlier mis-filled fields, and handles correction-only / off-topic
//    messages.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import {
  firstInterviewField,
  VISA_INTERVIEW_DONE,
  VISA_INTERVIEW_STEPS,
} from "@/leads/visa-interview.ts";
import type { ChatClient } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "test-secret";
const DIM = 8;

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map(() => new Array<number>(DIM).fill(0));
    },
  };
}

function fakeChat(reply: string): ChatClient {
  return {
    async complete() {
      return reply;
    },
  };
}

// What the visa-interview answer interpreter returns. Empty string ⇒ the
// interpreter sees garbage and the handler falls back to verbatim store.
let interpretReply = "";

let server: Server;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  interpretReply = "";
  sent = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body = JSON.parse((init?.body as string) ?? "{}");
    sent.push({ method: apiMethod, body });
    return new Response(
      JSON.stringify({
        ok: true,
        result:
          apiMethod === "sendMessage"
            ? { message_id: Math.floor(Math.random() * 1e6), chat: {}, date: 0, text: body.text }
            : true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    rag: {
      embedder: fakeEmbedder(),
      chat: fakeChat("RAG REPLY"),
      visaInterpretChat: {
        async complete() {
          return interpretReply;
        },
      },
    },
    awaitWebhookProcessing: true,
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
});

afterEach(() => server.stop(true));

function textUpdate(fromId: number, text: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

/** Drives a lead to `submitted` + waiting on `field`, returns repo + ids. */
async function startInterview(tgUserId: number, field: string) {
  const u = await new UsersRepo(sql).create({ tgUserId });
  const leads = new LeadsRepo(sql);
  const lead = await leads.ensureForUser(u.id);
  await leads.setState(lead.id, "submitted", { force: true });
  await leads.setVisaInterviewField(lead.id, field);
  return { leads, userId: u.id, leadId: lead.id };
}

async function send(tgUserId: number, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/telegram/${SECRET}`, {
    method: "POST",
    body: JSON.stringify(textUpdate(tgUserId, text)),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
}

function replies(): string[] {
  return sent.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
}

describe("visa interview reply() style guard", () => {
  test("the next interview question reaches the candidate without an em-dash", async () => {
    await startInterview(8101, firstInterviewField());

    await send(8101, "Ivanov");

    const out = replies();
    expect(out).toHaveLength(1);
    // The raw `given_name` question template contains an em-dash; the
    // reply() guard must have normalised it to a plain hyphen.
    expect(out[0]!).toContain("Given name");
    expect(out[0]!).not.toContain("—");
  });
});

describe("visa interview answer interpretation", () => {
  test("a cross-field correction fixes the earlier field and advances", async () => {
    const { leads, userId } = await startInterview(8102, "given_name");
    await leads.setVisaDocs(
      (await leads.byUserId(userId))!.id,
      JSON.stringify({
        family_name: "Alexandra",
      }),
    );
    interpretReply = JSON.stringify({
      patch: { given_name: "Alexandra", family_name: "Kireeva" },
      answered_current: true,
      off_topic: false,
    });

    await send(8102, "перепутала Alexandra имя, Kireeva фамилия");

    const lead = (await leads.byUserId(userId))!;
    expect(JSON.parse(lead.visa_docs_json!)).toEqual({
      family_name: "Kireeva",
      given_name: "Alexandra",
    });
    // Current field was answered → interview advanced to date_of_birth.
    expect(lead.visa_interview_field).toBe("date_of_birth");
    expect(replies().at(-1)!).toContain("Date of birth");
  });

  test("a correction-only message re-asks the same field without advancing", async () => {
    const { leads, userId } = await startInterview(8103, "given_name");
    interpretReply = JSON.stringify({
      patch: { family_name: "Kireeva" },
      answered_current: false,
      off_topic: false,
    });

    await send(8103, "ой, в фамилии ошибка, надо Kireeva");

    const lead = (await leads.byUserId(userId))!;
    expect(JSON.parse(lead.visa_docs_json!)).toEqual({ family_name: "Kireeva" });
    // Current field NOT answered → pointer stays, question re-asked.
    expect(lead.visa_interview_field).toBe("given_name");
    expect(replies().at(-1)!).toContain("Given name");
  });

  test("a bare «да» keeps a pre-filled field and advances without an LLM call", async () => {
    const { leads, leadId, userId } = await startInterview(8105, "date_of_birth");
    await leads.setVisaDocs(leadId, JSON.stringify({ date_of_birth: "1998-04-12" }));

    await send(8105, "да");

    const lead = (await leads.byUserId(userId))!;
    // Pre-filled value kept verbatim, interview advanced.
    expect(JSON.parse(lead.visa_docs_json!).date_of_birth).toBe("1998-04-12");
    expect(lead.visa_interview_field).toBe("country_of_birth");
  });

  test("answering the last field finishes the interview", async () => {
    const lastField = VISA_INTERVIEW_STEPS[VISA_INTERVIEW_STEPS.length - 1]!.field;
    const { leads, userId } = await startInterview(8106, lastField);
    interpretReply = JSON.stringify({
      patch: { [lastField]: "no spouse, no children" },
      answered_current: true,
      off_topic: false,
    });

    await send(8106, "no spouse, no children");

    const lead = (await leads.byUserId(userId))!;
    // Last field answered → pointer cleared, completion message sent.
    expect(lead.visa_interview_field).toBeNull();
    expect(replies().at(-1)!).toContain(VISA_INTERVIEW_DONE.split("!")[0]!);
  });

  test("an off-topic question is answered, then the field is re-asked", async () => {
    const { leads, userId } = await startInterview(8104, "given_name");
    interpretReply = JSON.stringify({ patch: {}, answered_current: false, off_topic: true });

    await send(8104, "а сколько ждать визу?");

    const lead = (await leads.byUserId(userId))!;
    // Off-topic → pointer not advanced; RAG answered + question re-asked.
    expect(lead.visa_interview_field).toBe("given_name");
    const out = replies();
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.at(-1)!).toContain("Given name");
  });
});
