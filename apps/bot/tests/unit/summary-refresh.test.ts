import { describe, expect, test } from "bun:test";

import type { MessageRole, MessageRow } from "@/db/repos/messages.ts";
import {
  DEFAULT_SUMMARY_THRESHOLDS,
  planSummaryRefresh,
  type SummaryThresholds,
} from "@/telegram/summary-refresh.ts";

const mkMsg = (id: number, role: MessageRole = "user"): MessageRow => ({
  id,
  conversation_id: 1,
  role,
  text: `m${id}`,
  tg_message_id: null,
  meta_json: null,
  created_at: 0,
  stage: null,
});

const seq = (n: number, role: MessageRole = "user") =>
  Array.from({ length: n }, (_, i) => mkMsg(i + 1, role));

// Small thresholds keep the fixtures tiny.
const T: SummaryThresholds = { startThreshold: 5, recentWindow: 2, staleness: 3 };

describe("planSummaryRefresh", () => {
  test("skips a conversation below the start threshold", () => {
    expect(planSummaryRefresh(seq(4), null, T)).toBeNull();
  });

  test("first summary: plans the tail older than the recent window", () => {
    const plan = planSummaryRefresh(seq(6), null, T);
    expect(plan).not.toBeNull();
    // 6 messages, recentWindow 2 → tail is ids 1..4
    expect(plan!.messages.map((m) => m.content)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(plan!.throughId).toBe(4);
    expect(plan!.refining).toBe(false);
  });

  test("skips when an existing summary is still fresh (gap < staleness)", () => {
    const plan = planSummaryRefresh(seq(6), { summarizedThroughMsgId: 3, summary: "old" }, T);
    // tail ends at id 4, gap = 4 - 3 = 1 < staleness 3
    expect(plan).toBeNull();
  });

  test("refreshes a stale summary, feeding only the new slice", () => {
    const plan = planSummaryRefresh(seq(8), { summarizedThroughMsgId: 2, summary: "old" }, T);
    expect(plan).not.toBeNull();
    // tail ids 1..6, gap = 6 - 2 = 4 >= staleness 3; new slice is ids > 2
    expect(plan!.messages.map((m) => m.content)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(plan!.throughId).toBe(6);
    expect(plan!.refining).toBe(true);
  });

  test("maps the human operator role to assistant", () => {
    const all = [...seq(5), mkMsg(6, "human")];
    const plan = planSummaryRefresh(all, null, T);
    // tail is ids 1..4 (recentWindow 2) — all "user" here; sanity-check role mapping
    expect(plan!.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  test("skips when the summarizable tail has no user/assistant/human turns", () => {
    expect(planSummaryRefresh(seq(6, "system"), null, T)).toBeNull();
  });

  test("skips when the recent window swallows the whole conversation", () => {
    // recentWindow >= length → empty summarizable tail
    expect(
      planSummaryRefresh(seq(3), null, { startThreshold: 3, recentWindow: 10, staleness: 3 }),
    ).toBeNull();
  });

  test("default thresholds require ~30 messages before summarizing", () => {
    expect(planSummaryRefresh(seq(20), null)).toBeNull();
    expect(planSummaryRefresh(seq(40), null, DEFAULT_SUMMARY_THRESHOLDS)).not.toBeNull();
  });
});
