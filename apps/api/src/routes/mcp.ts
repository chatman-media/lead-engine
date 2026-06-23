import type { EmbeddingClient } from "@chatman-media/llm-router";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { AuthTokenError, verifyAuthToken } from "../lib/auth.ts";
import { createMcpServer } from "../mcp/server.ts";
import type { Db } from "@chatman-media/conversation-engine";

/**
 * MCP (Model Context Protocol) Streamable HTTP endpoint.
 *
 * Endpoint: POST /mcp   (stateless, JSON-RPC 2.0 over HTTP)
 *
 * Auth: Authorization: Bearer <tenant-jwt>
 *   — тот же JWT что используется admin-UI для /api/admin/* эндпоинтов.
 *
 * Tools:
 *   kb_search           — поиск по базе знаний (BM25 + optional vector)
 *   lead_list           — список лидов
 *   lead_get            — карточка лида
 *   lead_move_stage     — смена стадии
 *   conversation_history — история разговора
 *
 * Claude Desktop / Cursor / любой MCP-клиент подключается через:
 *   { "type": "http", "url": "https://api.example.com/mcp" }
 */
export interface McpRoutesOpts {
  db: Db;
  authSecret: string;
  resolveEmbedder?: (tenantId: number) => EmbeddingClient;
}

export function makeMcpRoutes(opts: McpRoutesOpts): Hono {
  const app = new Hono();

  app.all("/mcp", async (c) => {
    // Auth: Bearer JWT → tenantId
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return c.json({ error: "missing authorization header" }, 401);
    }

    let tenantId: number;
    try {
      const claims = verifyAuthToken(token, opts.authSecret);
      tenantId = claims.tenantId;
    } catch (err) {
      if (err instanceof AuthTokenError) {
        return c.json({ error: err.reason }, 401);
      }
      return c.json({ error: "invalid token" }, 401);
    }

    // Создаём McpServer per-request (stateless)
    const mcpServer = createMcpServer({
      db: opts.db,
      tenantId,
      resolveEmbedder: opts.resolveEmbedder ? () => opts.resolveEmbedder!(tenantId) : undefined,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    await mcpServer.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    await mcpServer.close();
    return response;
  });

  return app;
}
