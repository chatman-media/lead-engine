import {
  agentToolCallFeedback as agentToolCallFeedbackTable,
  agentToolCalls as agentToolCallsTable,
} from "@chatman-media/storage";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export type AgentToolCallSource = "rag_reply" | "llm_reply" | "admin_sim" | "self_play";

export interface AgentToolCallRow {
  id: number;
  tenantId: number;
  conversationId: number;
  contactId: number | null;
  messageId: number | null;
  outboundQueueId: number | null;
  source: AgentToolCallSource;
  toolName: string;
  argsJson: string;
  resultJson: string;
  error: boolean;
  cycle: number;
  toolCallIndex: number;
  latencyMs: number | null;
  createdAt: number;
}

export interface AgentToolCallInput {
  conversationId: number;
  contactId?: number | null;
  messageId?: number | null;
  outboundQueueId?: number | null;
  source: AgentToolCallSource;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: boolean;
  cycle: number;
  toolCallIndex: number;
  latencyMs?: number | null;
  nowEpoch: number;
}

export interface AgentToolCallListOpts {
  conversationId?: number;
  contactId?: number;
  messageId?: number;
  outboundQueueId?: number;
  source?: AgentToolCallSource;
  toolName?: string;
  error?: boolean;
  limit?: number;
}

export type AgentToolCallFeedbackLabel =
  | "good_reply"
  | "wrong_tool"
  | "missing_tool"
  | "bad_args"
  | "other";

export interface AgentToolCallFeedbackRow {
  id: number;
  tenantId: number;
  toolCallId: number;
  adminId: number | null;
  label: AgentToolCallFeedbackLabel;
  note: string | null;
  createdAt: number;
}

export interface AgentToolCallFeedbackInput {
  toolCallId: number;
  adminId?: number | null;
  label: AgentToolCallFeedbackLabel;
  note?: string | null;
  nowEpoch: number;
}

function safeJson(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value) ?? fallback;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: "unserializable_tool_payload",
      message,
    });
  }
}

/**
 * Tenant-scoped persistence for agentic tool-loop traces. These rows are not
 * used to generate the user-facing reply; they are audit/eval substrate for
 * later learning loops and quality dashboards.
 */
export class AgentToolCallsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async byId(id: number): Promise<AgentToolCallRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(agentToolCallsTable)
      .where(
        and(eq(agentToolCallsTable.tenantId, this.ctx.tenantId), eq(agentToolCallsTable.id, id)),
      )
      .limit(1);
    return (row as AgentToolCallRow | undefined) ?? null;
  }

  async recordMany(records: readonly AgentToolCallInput[]): Promise<AgentToolCallRow[]> {
    if (records.length === 0) return [];
    const rows = await this.ctx.db
      .insert(agentToolCallsTable)
      .values(
        records.map((record) => ({
          tenantId: this.ctx.tenantId,
          conversationId: record.conversationId,
          contactId: record.contactId ?? null,
          messageId: record.messageId ?? null,
          outboundQueueId: record.outboundQueueId ?? null,
          source: record.source,
          toolName: record.toolName,
          argsJson: safeJson(record.args, "{}"),
          resultJson: safeJson(record.result, "null"),
          error: record.error ?? false,
          cycle: record.cycle,
          toolCallIndex: record.toolCallIndex,
          latencyMs: record.latencyMs ?? null,
          createdAt: record.nowEpoch,
        })),
      )
      .returning();
    return rows as AgentToolCallRow[];
  }

  async list(opts: AgentToolCallListOpts = {}): Promise<AgentToolCallRow[]> {
    const filters: SQL<unknown>[] = [eq(agentToolCallsTable.tenantId, this.ctx.tenantId)];
    if (opts.conversationId !== undefined) {
      filters.push(eq(agentToolCallsTable.conversationId, opts.conversationId));
    }
    if (opts.contactId !== undefined) {
      filters.push(eq(agentToolCallsTable.contactId, opts.contactId));
    }
    if (opts.messageId !== undefined) {
      filters.push(eq(agentToolCallsTable.messageId, opts.messageId));
    }
    if (opts.outboundQueueId !== undefined) {
      filters.push(eq(agentToolCallsTable.outboundQueueId, opts.outboundQueueId));
    }
    if (opts.source !== undefined) {
      filters.push(eq(agentToolCallsTable.source, opts.source));
    }
    if (opts.toolName !== undefined) {
      filters.push(eq(agentToolCallsTable.toolName, opts.toolName));
    }
    if (opts.error !== undefined) {
      filters.push(eq(agentToolCallsTable.error, opts.error));
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
    const rows = await this.ctx.db
      .select()
      .from(agentToolCallsTable)
      .where(and(...filters))
      .orderBy(desc(agentToolCallsTable.createdAt), desc(agentToolCallsTable.id))
      .limit(limit);
    return rows as AgentToolCallRow[];
  }

  async byConversation(conversationId: number, limit = 100): Promise<AgentToolCallRow[]> {
    return this.list({ conversationId, limit });
  }

  async recordFeedback(
    input: AgentToolCallFeedbackInput,
  ): Promise<AgentToolCallFeedbackRow | null> {
    const toolCall = await this.byId(input.toolCallId);
    if (!toolCall) return null;

    const [row] = await this.ctx.db
      .insert(agentToolCallFeedbackTable)
      .values({
        tenantId: this.ctx.tenantId,
        toolCallId: input.toolCallId,
        adminId: input.adminId ?? null,
        label: input.label,
        note: input.note ?? null,
        createdAt: input.nowEpoch,
      })
      .returning();
    return (row as AgentToolCallFeedbackRow | undefined) ?? null;
  }

  async feedbackForToolCall(toolCallId: number, limit = 50): Promise<AgentToolCallFeedbackRow[]> {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = await this.ctx.db
      .select()
      .from(agentToolCallFeedbackTable)
      .where(
        and(
          eq(agentToolCallFeedbackTable.tenantId, this.ctx.tenantId),
          eq(agentToolCallFeedbackTable.toolCallId, toolCallId),
        ),
      )
      .orderBy(desc(agentToolCallFeedbackTable.createdAt), desc(agentToolCallFeedbackTable.id))
      .limit(cappedLimit);
    return rows as AgentToolCallFeedbackRow[];
  }
}
