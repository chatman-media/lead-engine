import {
  DrizzleKbStore,
  LeadsRepo,
  MessagesRepo,
  type Db,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import { contacts, leads } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Создаёт McpServer с 5 инструментами для работы с tenant-данными.
 * Используется per-request в stateless режиме.
 *
 * Инструменты:
 *   kb_search           — BM25 + vector поиск по базе знаний
 *   lead_list           — список лидов с фильтром по стадии
 *   lead_get            — карточка лида по ID
 *   lead_move_stage     — смена стадии лида
 *   conversation_history — история сообщений разговора
 */
export function createMcpServer(opts: {
  db: Db;
  tenantId: number;
  resolveEmbedder?: () => EmbeddingClient;
}): McpServer {
  const { db, tenantId } = opts;

  const server = new McpServer({
    name: "lead-engine",
    version: "1.0.0",
  });

  // ── kb_search ──────────────────────────────────────────────────────────────

  server.tool(
    "kb_search",
    "Search the knowledge base. Uses vector+BM25 hybrid search if embedder is configured, otherwise BM25 text search only.",
    {
      query: z.string().min(1).max(500).describe("Search query in Russian or English"),
      limit: z.number().int().min(1).max(20).default(5).describe("Max number of results"),
      topic: z.string().optional().describe("Optional topic filter"),
    },
    async ({ query, limit, topic }) => {
      const hits = await withTenant(db, tenantId, async (tx) => {
        const kb = new DrizzleKbStore({ db: tx, tenantId });

        if (opts.resolveEmbedder) {
          try {
            const embedder = opts.resolveEmbedder();
            const embeddings = await embedder.embed([query]);
            const embedding = embeddings[0] ?? [];
            return kb.hybridSearch({ embedding, query, k: limit, topic: topic ?? null });
          } catch {
            // fall through to text-only search
          }
        }

        return kb.textSearch(query, limit, topic ?? null);
      });

      if (!hits || hits.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const text = hits.map((h, i) => `[${i + 1}] **${h.title}**\n${h.text}`).join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── lead_list ──────────────────────────────────────────────────────────────

  server.tool(
    "lead_list",
    "List leads for this tenant. Optionally filter by stage/state.",
    {
      state: z
        .string()
        .optional()
        .describe("Filter by lead state slug (e.g. intake_pending, approved)"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max results"),
    },
    async ({ state, limit }) => {
      const rows = await withTenant(db, tenantId, async (tx) => {
        const conditions = [eq(leads.tenantId, tenantId)];
        if (state) conditions.push(eq(leads.state, state));

        return tx
          .select({
            id: leads.id,
            state: leads.state,
            contactName: contacts.displayName,
            createdAt: leads.createdAt,
            updatedAt: leads.updatedAt,
          })
          .from(leads)
          .leftJoin(contacts, eq(leads.userId, contacts.id))
          .where(and(...conditions))
          .orderBy(desc(leads.updatedAt))
          .limit(limit);
      });

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No leads found." }] };
      }

      const text = rows
        .map(
          (r) =>
            `ID:${r.id} [${r.state}] ${r.contactName ?? "—"} (updated: ${new Date((r.updatedAt ?? 0) * 1000).toISOString()})`,
        )
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── lead_get ──────────────────────────────────────────────────────────────

  server.tool(
    "lead_get",
    "Get detailed information about a specific lead by ID.",
    {
      id: z.number().int().positive().describe("Lead ID"),
    },
    async ({ id }) => {
      const lead = await withTenant(db, tenantId, async (tx) => {
        const repo = new LeadsRepo({ db: tx, tenantId });
        return repo.byId(id);
      });

      if (!lead) {
        return { content: [{ type: "text" as const, text: `Lead ${id} not found.` }] };
      }

      const text = JSON.stringify(lead, null, 2);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── lead_move_stage ────────────────────────────────────────────────────────

  server.tool(
    "lead_move_stage",
    "Move a lead to a different stage/state.",
    {
      id: z.number().int().positive().describe("Lead ID"),
      state: z
        .string()
        .min(1)
        .describe("Target state slug (e.g. approved, docs_pending, rejected)"),
    },
    async ({ id, state }) => {
      const nowEpoch = Math.floor(Date.now() / 1000);
      await withTenant(db, tenantId, async (tx) => {
        const repo = new LeadsRepo({ db: tx, tenantId });
        await repo.updateState(id, state, nowEpoch);
      });
      return {
        content: [{ type: "text" as const, text: `Lead ${id} moved to state "${state}".` }],
      };
    },
  );

  // ── conversation_history ───────────────────────────────────────────────────

  server.tool(
    "conversation_history",
    "Get recent messages from a conversation.",
    {
      conversationId: z.number().int().positive().describe("Conversation ID"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max messages to return"),
    },
    async ({ conversationId, limit }) => {
      const messages = await withTenant(db, tenantId, async (tx) => {
        const repo = new MessagesRepo({ db: tx, tenantId });
        return repo.recent(conversationId, limit);
      });

      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: "No messages in this conversation." }] };
      }

      const text = messages.map((m) => `[${m.role}] ${m.text ?? ""}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}
