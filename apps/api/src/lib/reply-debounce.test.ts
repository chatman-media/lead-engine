// Чистый unit (без PG) для catch-веток replyDebounceTick. withTenant(db,...)
// = db.transaction(cb), поэтому фейк transaction управляет успехом/падением
// на tenant- и conv-уровне без реального claimDueReplies.

import { describe, expect, it } from "bun:test";
import type { Db, ReplyStrategy } from "@chatman-media/conversation-engine";
import { replyDebounceTick } from "./reply-debounce.ts";

const noopStrategy = {
  async generate() {
    return [];
  },
} as unknown as ReplyStrategy;

describe("replyDebounceTick — error handling", () => {
  it("падение на tenant-уровне (claimDueReplies) → log.warn (lines 97-99)", async () => {
    const warnings: string[] = [];
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: 1, slug: "t1" }] }),
      }),
      // withTenant → transaction; падаем сразу на claim.
      transaction: async () => {
        throw new Error("claim boom");
      },
    } as unknown as Db;

    await replyDebounceTick(db, {
      nowSec: 1000,
      replyStrategy: noopStrategy,
      log: { warn: (m) => warnings.push(m) },
    });
    expect(warnings.some((w) => w.includes("reply-debounce tenant=1"))).toBe(true);
    expect(warnings.some((w) => w.includes("claim boom"))).toBe(true);
  });

  it("падение на conv-уровне (generateReplyForConversation) → log.warn (lines 91-93)", async () => {
    const warnings: string[] = [];
    let txCall = 0;
    const conv = { id: 55, userId: 7, channelId: 10, mode: "ai", currentStage: null };
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: 1, slug: "t1" }] }),
      }),
      transaction: async (cb: (tx: unknown) => unknown) => {
        txCall++;
        // 1-й вызов = claimDueReplies → возвращаем одну due-беседу (cb не зовём).
        if (txCall === 1) return [conv];
        // 2-й вызов = withTenant внутри generateReplyForConversation → падаем.
        void cb;
        throw new Error("gen boom");
      },
    } as unknown as Db;

    await replyDebounceTick(db, {
      nowSec: 1000,
      replyStrategy: noopStrategy,
      log: { warn: (m) => warnings.push(m) },
    });
    expect(warnings.some((w) => w.includes("reply-debounce conv=55"))).toBe(true);
    expect(warnings.some((w) => w.includes("gen boom"))).toBe(true);
  });

  it("нет due-бесед → пропуск тенанта без падения", async () => {
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: 1, slug: "t1" }] }),
      }),
      transaction: async () => [],
    } as unknown as Db;
    await expect(
      replyDebounceTick(db, { nowSec: 1, replyStrategy: noopStrategy }),
    ).resolves.toBeUndefined();
  });
});
