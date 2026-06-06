import type { VerticalTemplate } from "@chatman-media/verticals";
import { describe, expect, it } from "bun:test";
import type { LeadRow, LeadsRepo } from "./dal/leads.ts";
import { ensureLead, transitionLeadState } from "./lead-lifecycle.ts";
import type { NotificationService, NotificationEvent } from "./notifications.ts";

const TEMPLATE: VerticalTemplate = {
  slug: "test_v1",
  displayName: "Test",
  version: 1,
  funnelStages: [
    { slug: "intake", kind: "intake", displayName: "Intake", next: ["qualified", "rejected"] },
    { slug: "qualified", kind: "lead", displayName: "Qualified", next: ["won", "rejected"] },
    { slug: "won", kind: "terminal", displayName: "Won" },
    { slug: "rejected", kind: "terminal", displayName: "Rejected" },
  ],
};

class FakeLeadsRepo {
  private nextId = 1;
  private readonly rows: LeadRow[] = [];
  constructor(public readonly tenantId: number) {}

  async findByContactId(contactId: number): Promise<LeadRow | null> {
    return this.rows.find((r) => r.userId === contactId) ?? null;
  }
  async create(opts: {
    contactId: number;
    state: string;
    requestType?: string | null;
    nowEpoch: number;
  }): Promise<LeadRow> {
    const row: LeadRow = {
      id: this.nextId++,
      tenantId: this.tenantId,
      userId: opts.contactId,
      state: opts.state,
      requestType: opts.requestType ?? null,
      assignedAdminId: null,
      intakeJson: null,
      visaDocsJson: null,
      applicationId: null,
      opsChatId: null,
      opsMessageId: null,
      rejectedReason: null,
      decidedByAdminId: null,
      decidedAt: null,
      lastCheckinAt: null,
      visaInterviewField: null,
      createdAt: opts.nowEpoch,
      updatedAt: opts.nowEpoch,
    };
    this.rows.push(row);
    return row;
  }
  async updateState(leadId: number, newState: string, nowEpoch: number): Promise<void> {
    const row = this.rows.find((r) => r.id === leadId);
    if (row) {
      row.state = newState;
      row.updatedAt = nowEpoch;
    }
  }
  all(): LeadRow[] {
    return [...this.rows];
  }
}

class FakeNotificationService {
  events: NotificationEvent[] = [];
  async notify(event: NotificationEvent) { this.events.push(event); }
}

describe("ensureLead", () => {
  it("создаёт Lead в initial stage если контакт без лида", async () => {
    const repo = new FakeLeadsRepo(1);
    const { lead, created } = await ensureLead({
      contactId: 42,
      template: TEMPLATE,
      leads: repo as unknown as LeadsRepo,
      nowEpoch: 1700000000,
    });
    expect(created).toBe(true);
    expect(lead.state).toBe("intake");
    expect(lead.userId).toBe(42);
  });

  it("переиспользует существующий Lead", async () => {
    const repo = new FakeLeadsRepo(1);
    await ensureLead({ contactId: 42, template: TEMPLATE, leads: repo as unknown as LeadsRepo, nowEpoch: 1 });
    const { lead, created } = await ensureLead({
      contactId: 42,
      template: TEMPLATE,
      leads: repo as unknown as LeadsRepo,
      nowEpoch: 2,
    });
    expect(created).toBe(false);
    expect(lead.id).toBe(1);
  });
});

describe("transitionLeadState", () => {
  it("валидный переход обновляет state и зовёт onLeadStageChange хук", async () => {
    const repo = new FakeLeadsRepo(1);
    const created = await repo.create({ contactId: 1, state: "intake", nowEpoch: 1 });
    const hookCalls: Array<{ from: string; to: string }> = [];
    const templateWithHook: VerticalTemplate = {
      ...TEMPLATE,
      hooks: {
        onLeadStageChange: async (_ctx, from, to) => {
          hookCalls.push({ from, to });
        },
      },
    };
    const updated = await transitionLeadState({
      lead: created,
      toState: "qualified",
      template: templateWithHook,
      leads: repo as unknown as LeadsRepo,
      nowEpoch: 100,
    });
    expect(updated.state).toBe("qualified");
    expect(hookCalls).toEqual([{ from: "intake", to: "qualified" }]);
  });

  it("same-state переход — no-op (без UPDATE и без хука)", async () => {
    const repo = new FakeLeadsRepo(1);
    const created = await repo.create({ contactId: 1, state: "intake", nowEpoch: 1 });
    let hookCalled = false;
    const template: VerticalTemplate = {
      ...TEMPLATE,
      hooks: {
        onLeadStageChange: async () => {
          hookCalled = true;
        },
      },
    };
    const updated = await transitionLeadState({
      lead: created,
      toState: "intake",
      template,
      leads: repo as unknown as LeadsRepo,
      nowEpoch: 100,
    });
    expect(updated.state).toBe("intake");
    expect(hookCalled).toBe(false);
    // updatedAt не обновился потому что no-op.
    expect(repo.all()[0]?.updatedAt).toBe(1);
  });

  it("вызывает notifications.notify при переходе", async () => {
    const repo = new FakeLeadsRepo(1);
    const lead = await repo.create({ contactId: 5, state: "intake", nowEpoch: 1 });
    const notif = new FakeNotificationService();
    await transitionLeadState({
      lead: { ...lead, assignedAdminId: 7 },
      toState: "qualified",
      template: TEMPLATE,
      leads: repo as unknown as LeadsRepo,
      notifications: notif as unknown as NotificationService,
      nowEpoch: 2,
    });
    expect(notif.events).toHaveLength(1);
    const ev = notif.events[0]!;
    expect(ev.eventType).toBe("stage_changed");
    expect(ev.leadId).toBe(lead.id);
    expect(ev.assignedAdminId).toBe(7);
    expect(ev.data.fromStage).toBe("intake");
    expect(ev.data.toStage).toBe("qualified");
  });

  it("не зовёт notifications.notify при no-op переходе", async () => {
    const repo = new FakeLeadsRepo(1);
    const lead = await repo.create({ contactId: 5, state: "intake", nowEpoch: 1 });
    const notif = new FakeNotificationService();
    await transitionLeadState({
      lead,
      toState: "intake",
      template: TEMPLATE,
      leads: repo as unknown as LeadsRepo,
      notifications: notif as unknown as NotificationService,
      nowEpoch: 2,
    });
    expect(notif.events).toHaveLength(0);
  });

  it("невалидный переход бросает FunnelTransitionError, БД не трогается", async () => {
    const repo = new FakeLeadsRepo(1);
    const created = await repo.create({ contactId: 1, state: "intake", nowEpoch: 1 });
    await expect(
      transitionLeadState({
        lead: created,
        toState: "won", // intake.next = ['qualified','rejected'] — won запрещён
        template: TEMPLATE,
        leads: repo as unknown as LeadsRepo,
        nowEpoch: 100,
      }),
    ).rejects.toThrow(/funnel transition rejected/);
    expect(repo.all()[0]?.state).toBe("intake");
  });
});
