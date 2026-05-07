import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";

/**
 * End-to-end pipeline integration test.
 *
 * Walks the full lead workflow through the live router (not the
 * service / repo layer in isolation). Covers what the per-module
 * unit tests don't:
 *   - webhook → RAG → intake auto-update → auto-promote chain
 *   - photo / video reception with meta_json stamping (SQL counter
 *     drives intake completeness, not the LLM extractor)
 *   - callback_query approve dispatch (TG-button path, distinct
 *     from the admin /approve endpoint)
 *   - reply-to-card relay (text + photo from operator → candidate DM)
 *
 * Stubs:
 *   - Embedder: fake-deterministic vectors
 *   - Chat (LLM): pattern-matched on the system prompt — we know
 *     which extractor is calling so we synthesise a JSON shape that
 *     matches its schema. No real LLM in the loop.
 *   - Telegram fetch: records every outbound API call with auto-
 *     incrementing message_ids so callback_query / relay flows can
 *     reference real ids the bot just received from "Telegram".
 */

const SECRET = "test-secret";
const DIM = 1536;
const LEADS_CHAT_ID = -1_007_770;
const VISA_CHAT_ID = -1_009_990;
const CANDIDATE_TG_ID = 4_242_424;

interface OutgoingCall {
  method: string;
  body: Record<string, unknown>;
  returnedMessageId?: number;
}

function vec(seed: number): number[] {
  const arr = new Array<number>(DIM).fill(0);
  arr[seed % DIM] = 1;
  return arr;
}

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map((t) => vec(t.length));
    },
  };
}

/**
 * Pattern-matched LLM stub. Detects which extractor is calling by
 * scanning the system prompt for distinctive text and returns a
 * JSON payload that fits its schema.
 */
function scriptedChat(): ChatClient {
  return {
    async complete(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

      // Intake extractor — pulls 4 text fields.
      if (system.includes("извлекаешь 4 поля анкеты")) {
        const out: Record<string, string> = {};
        if (/165/.test(lastUser)) out.height = "165";
        if (/52/.test(lastUser)) out.weight = "52";
        if (/Москв|москв/i.test(lastUser)) out.city = "Москва";
        if (/1\s+апрел/i.test(lastUser)) out.departure_readiness = "с 1 апреля";
        return JSON.stringify(out);
      }

      // Visa-docs extractor.
      if (system.includes("Ты извлекаешь данные визовой анкеты")) {
        const out: Record<string, string> = {};
        if (/Ivanova/i.test(lastUser)) out.family_name = "Ivanova";
        if (/Anna/i.test(lastUser)) out.given_name = "Anna";
        if (/2000-01-15/.test(lastUser)) out.date_of_birth = "2000-01-15";
        if (/RUSSIAN|Russia/i.test(lastUser)) out.current_nationality = "Russian Federation";
        if (/Moscow.*Russia/i.test(lastUser)) out.country_of_birth = "Russia";
        if (/Moscow/i.test(lastUser)) out.city_of_birth = "Moscow";
        if (/1234567890/.test(lastUser)) out.passport_number = "1234567890";
        if (/anya@/i.test(lastUser)) out.email = "anya@example.com";
        return JSON.stringify(out);
      }

      // Memory extractor — out of scope for this test, return empty.
      if (system.includes("извлекаешь факты О КАНДИДАТЕ")) {
        return "{}";
      }

      // Default: RAG reply. Length-bounded so post-processing rules
      // don't reshape the text in surprising ways.
      return "Понял, спасибо!";
    },
  };
}

function buildTelegramStub(): {
  client: TelegramClient;
  sent: OutgoingCall[];
  /** Counter we hand back as message_id so callback_query and reply-
   *  to-card flows can target a known message. */
  nextMessageId: { value: number };
} {
  const sent: OutgoingCall[] = [];
  const nextMessageId = { value: 1000 };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body = JSON.parse((init?.body as string) ?? "{}");
    nextMessageId.value++;
    const messageId = nextMessageId.value;
    sent.push({ method: apiMethod, body, returnedMessageId: messageId });
    const result =
      apiMethod === "sendMessage" ||
      apiMethod === "sendPhoto" ||
      apiMethod === "sendVideo" ||
      apiMethod === "sendDocument"
        ? {
            message_id: messageId,
            chat: { id: body.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: body.text ?? body.caption,
          }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: new TelegramClient({ token: "t", fetch: fetchImpl }),
    sent,
    nextMessageId,
  };
}

function setup() {
  const db = openDb({ path: ":memory:", embeddingDim: DIM });
  const tg = buildTelegramStub();
  const router = createRouter({
    db,
    telegram: tg.client,
    webhookSecret: SECRET,
    rag: {
      embedder: fakeEmbedder(),
      chat: scriptedChat(),
      persona: {
        name: "Алина",
        role: "human",
        company: "INFINITY AGENCY",
      },
      // Auto-intake / auto-extract require LEADS_CHAT_ID configured.
      // userMemory off so memory extractor doesn't fire its own LLM
      // call on every turn — keeps the script-matcher's job small.
    },
    leadsChatId: LEADS_CHAT_ID,
    visaChatId: VISA_CHAT_ID,
    awaitWebhookProcessing: true,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => router.handle(req),
  });
  return { db, server, tg };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
  // The webhook drops messages from unknown TG users when
  // TELEGRAM_OPEN_ACCESS isn't set. Pre-create the candidate as
  // whitelisted so all the test does is exercise the lead pipeline,
  // not the access-control gate.
  new UsersRepo(ctx.db).create({
    tgUserId: CANDIDATE_TG_ID,
    tgUsername: "anya",
  });
});
afterEach(() => teardown(ctx));

function webhookUrl(): string {
  return `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
}

function postUpdate(update: TgUpdate): Promise<Response> {
  return fetch(webhookUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

let nextUpdateId = 1;
let nextTgMessageId = 1;
function newUpdate(extra: Partial<TgUpdate["message"]> = {}): TgUpdate {
  nextTgMessageId++;
  nextUpdateId++;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextTgMessageId,
      from: {
        id: CANDIDATE_TG_ID,
        is_bot: false,
        first_name: "Anna",
        username: "anya",
      },
      chat: { id: CANDIDATE_TG_ID, type: "private" },
      date: Math.floor(Date.now() / 1000),
      ...extra,
    },
  };
}

function textUpdate(text: string): TgUpdate {
  return newUpdate({ text });
}

function photoUpdate(): TgUpdate {
  return newUpdate({
    photo: [
      {
        file_id: `photo-${nextTgMessageId}-small`,
        file_unique_id: `pu-${nextTgMessageId}-s`,
        width: 90,
        height: 120,
      },
      {
        file_id: `photo-${nextTgMessageId}-large`,
        file_unique_id: `pu-${nextTgMessageId}-l`,
        width: 800,
        height: 1200,
      },
    ],
  });
}

function videoUpdate(): TgUpdate {
  return newUpdate({
    video: {
      file_id: `video-${nextTgMessageId}`,
      file_unique_id: `vu-${nextTgMessageId}`,
      width: 720,
      height: 1280,
      duration: 30,
    },
  });
}

describe("lead pipeline e2e", () => {
  test("photo upload persists meta.media so SQL counter sees it", async () => {
    nextUpdateId = 1;
    nextTgMessageId = 100;

    const res = await postUpdate(photoUpdate());
    expect(res.status).toBe(200);

    const messagesRepo = new MessagesRepo(ctx.db);
    const usersRepo = new UsersRepo(ctx.db);
    const u = usersRepo.byTgId(CANDIDATE_TG_ID);
    expect(u).not.toBeNull();
    const list = messagesRepo.listByConversation(
      // The conversation was just created by ensureForUser; any of its rows
      // will do for the meta inspection.
      ctx.db
        .query<{ id: number }, [number]>("SELECT id FROM conversations WHERE user_id = ? LIMIT 1")
        .get(u!.id)!.id,
    );
    expect(list.length).toBeGreaterThan(0);
    const photoRow = list.find((m) => m.text === "[photo]");
    expect(photoRow).toBeDefined();
    const meta = JSON.parse(photoRow!.meta_json ?? "{}");
    expect(meta.media?.type).toBe("photo");
    expect(meta.media?.file_id).toContain("photo-");
  });

  test("auto-promote: full intake (text + 7 photos + 3 videos) lands a card in LEADS_CHAT_ID", async () => {
    nextUpdateId = 1;
    nextTgMessageId = 200;

    // 1. Candidate small-talks the four text fields.
    await postUpdate(textUpdate("Привет, я Аня"));
    await postUpdate(textUpdate("165 рост, 52 вес"));
    await postUpdate(textUpdate("сейчас в Москве, готова с 1 апреля"));

    // 2. 7 photos (so passport-photo flag flips at >=7).
    for (let i = 0; i < 7; i++) await postUpdate(photoUpdate());
    // 3. 3 videos (so dance-video flag flips at >=3).
    for (let i = 0; i < 3; i++) await postUpdate(videoUpdate());

    const leads = new LeadsRepo(ctx.db);
    const usersRepo = new UsersRepo(ctx.db);
    const u = usersRepo.byTgId(CANDIDATE_TG_ID)!;
    const lead = leads.byUserId(u.id);
    expect(lead).not.toBeNull();
    expect(lead!.state).toBe("intake_complete");

    // The card landed in LEADS_CHAT_ID with approve/reject inline buttons.
    const cardCalls = ctx.tg.sent.filter(
      (c) =>
        c.method === "sendMessage" &&
        c.body.chat_id === LEADS_CHAT_ID &&
        Array.isArray((c.body.reply_markup as { inline_keyboard?: unknown[][] })?.inline_keyboard),
    );
    expect(cardCalls.length).toBe(1);
    const keyboard = (
      cardCalls[0]!.body.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data: string }>>;
      }
    ).inline_keyboard;
    expect(keyboard[0]?.map((b) => b.callback_data)).toEqual([
      `lead:approve:${lead!.id}`,
      `lead:reject:${lead!.id}`,
    ]);

    // The lead row now points at the ops card (so reply-to-card relays
    // and edit-in-place after a decision can find it again).
    expect(lead!.ops_chat_id).toBe(LEADS_CHAT_ID);
    expect(lead!.ops_message_id).toBe(cardCalls[0]!.returnedMessageId);

    // Candidate also got the "ждите, отправили запрос" placeholder.
    const awaitMsgs = ctx.tg.sent.filter(
      (c) =>
        c.method === "sendMessage" &&
        c.body.chat_id === CANDIDATE_TG_ID &&
        typeof c.body.text === "string" &&
        (c.body.text as string).includes("отправила запрос в клуб"),
    );
    expect(awaitMsgs.length).toBe(1);
  });

  test("callback_query approve: state moves through approved → docs_pending and 4 templates land in candidate DM", async () => {
    nextUpdateId = 1;
    nextTgMessageId = 300;

    // Drive intake to completion as in the previous test.
    await postUpdate(textUpdate("я Аня, 165, 52, в Москве с 1 апреля"));
    for (let i = 0; i < 7; i++) await postUpdate(photoUpdate());
    for (let i = 0; i < 3; i++) await postUpdate(videoUpdate());

    const leads = new LeadsRepo(ctx.db);
    const usersRepo = new UsersRepo(ctx.db);
    const u = usersRepo.byTgId(CANDIDATE_TG_ID)!;
    const lead = leads.byUserId(u.id)!;
    expect(lead.state).toBe("intake_complete");

    // Reset the recorded calls so we can isolate post-approve outbounds.
    const sentBefore = ctx.tg.sent.length;

    // Operator clicks "✅ Одобрить" on the card. Telegram delivers a
    // callback_query update — same webhook endpoint.
    const callbackUpdate: TgUpdate = {
      update_id: 9_999,
      callback_query: {
        id: "cbq-1",
        from: { id: 12345, is_bot: false, first_name: "Op", username: "op" },
        data: `lead:approve:${lead.id}`,
        message: {
          message_id: lead.ops_message_id!,
          chat: { id: LEADS_CHAT_ID, type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
        },
      },
    };
    const res = await postUpdate(callbackUpdate);
    expect(res.status).toBe(200);

    const reread = leads.byId(lead.id)!;
    // approve → docs_pending in one go (Phase 1 wires both transitions
    // so the next candidate turn lands in docs_pending immediately).
    expect(reread.state).toBe("docs_pending");

    // Bot DM'd the candidate the four operator-curated templates.
    const dmCalls = ctx.tg.sent
      .slice(sentBefore)
      .filter(
        (c) =>
          c.method === "sendMessage" &&
          c.body.chat_id === CANDIDATE_TG_ID &&
          typeof c.body.text === "string",
      );
    expect(dmCalls.length).toBeGreaterThanOrEqual(4);
    const allText = dmCalls.map((c) => c.body.text as string).join("\n");
    expect(allText).toContain("Вас одобрили");
    expect(allText).toContain("документы платные");
    expect(allText).toContain("Family name");
    expect(allText).toContain("3,5×4,5");

    // Card was edited in place (no buttons after the decision).
    const edits = ctx.tg.sent
      .slice(sentBefore)
      .filter((c) => c.method === "editMessageText" && c.body.chat_id === LEADS_CHAT_ID);
    expect(edits.length).toBe(1);
    const kb = (
      edits[0]!.body.reply_markup as {
        inline_keyboard: unknown[][];
      }
    ).inline_keyboard;
    expect(kb).toEqual([]);

    // Telegram callback was answered (no spinner left on the operator's button).
    const answers = ctx.tg.sent.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.length).toBe(1);
    expect((answers[0]!.body as { text: string }).text).toContain("Одобрено");
  });

  test("operator relay via reply-to-card: text + photo land in candidate DM", async () => {
    nextUpdateId = 1;
    nextTgMessageId = 400;

    // Set up a card to reply to.
    await postUpdate(textUpdate("я Аня, 165, 52, Москва, 1 апреля"));
    for (let i = 0; i < 7; i++) await postUpdate(photoUpdate());
    for (let i = 0; i < 3; i++) await postUpdate(videoUpdate());

    const leads = new LeadsRepo(ctx.db);
    const usersRepo = new UsersRepo(ctx.db);
    const u = usersRepo.byTgId(CANDIDATE_TG_ID)!;
    const lead = leads.byUserId(u.id)!;
    expect(lead.ops_message_id).not.toBeNull();

    const sentBefore = ctx.tg.sent.length;

    // Operator replies to the card in LEADS_CHAT_ID with a photo +
    // caption. Webhook should detect it as reply-to-card and dispatch
    // through LeadsService.relayFromOperator.
    const operatorReply: TgUpdate = {
      update_id: 8_888,
      message: {
        message_id: 99_999,
        from: { id: 12345, is_bot: false, first_name: "Op", username: "op" },
        chat: { id: LEADS_CHAT_ID, type: "supergroup" },
        date: Math.floor(Date.now() / 1000),
        caption: "вот образец визы как заполнять",
        photo: [
          {
            file_id: "AgADrelay-small",
            file_unique_id: "rl-s",
            width: 90,
            height: 120,
          },
          {
            file_id: "AgADrelay-large",
            file_unique_id: "rl-l",
            width: 800,
            height: 1200,
          },
        ],
        reply_to_message: {
          message_id: lead.ops_message_id!,
          chat: { id: LEADS_CHAT_ID, type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
        },
      },
    };
    const res = await postUpdate(operatorReply);
    expect(res.status).toBe(200);

    // Photo went to the candidate via sendPhoto with the caption attached.
    const photoSends = ctx.tg.sent
      .slice(sentBefore)
      .filter((c) => c.method === "sendPhoto" && c.body.chat_id === CANDIDATE_TG_ID);
    expect(photoSends.length).toBe(1);
    expect(photoSends[0]!.body.photo).toBe("AgADrelay-large"); // largest size
    expect(photoSends[0]!.body.caption).toBe("вот образец визы как заполнять");

    // Bot acknowledged in the ops chat under the operator's message.
    const acks = ctx.tg.sent
      .slice(sentBefore)
      .filter(
        (c) =>
          c.method === "sendMessage" &&
          c.body.chat_id === LEADS_CHAT_ID &&
          typeof c.body.text === "string" &&
          (c.body.text as string).includes(`отправлено в lead #${lead.id}`),
      );
    expect(acks.length).toBe(1);

    // The relay was recorded as role='human' so the admin chat view
    // distinguishes it from the bot's auto replies.
    const messagesRepo = new MessagesRepo(ctx.db);
    const conv = ctx.db
      .query<{ id: number }, [number]>("SELECT id FROM conversations WHERE user_id = ? LIMIT 1")
      .get(u.id)!;
    const list = messagesRepo.listByConversation(conv.id);
    const human = list.filter((m) => m.role === "human");
    expect(human.length).toBe(1);
    expect(human[0]!.text).toBe("вот образец визы как заполнять");
    const meta = JSON.parse(human[0]!.meta_json ?? "{}");
    expect(meta.source).toBe("operator-relay");
    expect(meta.media?.type).toBe("photo");
    expect(meta.media?.file_id).toBe("AgADrelay-large");
  });

  test("auto-promote does NOT fire on partial intake (5 photos, 1 video)", async () => {
    nextUpdateId = 1;
    nextTgMessageId = 500;

    await postUpdate(textUpdate("Привет, я Аня"));
    await postUpdate(textUpdate("165, 52, Москва, 1 апреля"));
    for (let i = 0; i < 5; i++) await postUpdate(photoUpdate());
    await postUpdate(videoUpdate());

    const leads = new LeadsRepo(ctx.db);
    const usersRepo = new UsersRepo(ctx.db);
    const u = usersRepo.byTgId(CANDIDATE_TG_ID)!;
    const lead = leads.byUserId(u.id);
    // Lead ROW exists (we always ensureForUser on every intake update),
    // but state stays at intake_pending until thresholds clear.
    expect(lead).not.toBeNull();
    expect(lead!.state).toBe("intake_pending");

    // No card was posted to the ops chat.
    const cardCalls = ctx.tg.sent.filter(
      (c) => c.method === "sendMessage" && c.body.chat_id === LEADS_CHAT_ID,
    );
    expect(cardCalls.length).toBe(0);
  });
});
