// The step-by-step visa interview sends static question templates straight
// through `reply()` in processInbound — bypassing the LLM-output sanitizer.
// This guards that `reply()` style-guards every outgoing message, so the
// em-dashes baked into the question templates never reach the candidate.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { firstInterviewField } from "@/leads/visa-interview.ts";
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

let server: Server;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
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
    rag: { embedder: fakeEmbedder(), chat: fakeChat("RAG REPLY") },
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

describe("visa interview reply() style guard", () => {
  test("the next interview question reaches the candidate without an em-dash", async () => {
    const u = await new UsersRepo(sql).create({ tgUserId: 8101 });
    const leads = new LeadsRepo(sql);
    const lead = await leads.ensureForUser(u.id);
    await leads.setState(lead.id, "submitted", { force: true });
    await leads.setVisaInterviewField(lead.id, firstInterviewField());

    const res = await fetch(`http://127.0.0.1:${server.port}/telegram/${SECRET}`, {
      method: "POST",
      body: JSON.stringify(textUpdate(8101, "Ivanov")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    const replies = sent.filter((c) => c.method === "sendMessage");
    expect(replies).toHaveLength(1);
    const questionText = replies[0]!.body.text as string;
    // The raw `given_name` question template contains an em-dash; the
    // reply() guard must have normalised it to a plain hyphen.
    expect(questionText).toContain("Given name");
    expect(questionText).not.toContain("—");
  });
});
