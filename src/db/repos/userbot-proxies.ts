import type { ParsedMTProxy } from "../../telegram/mtproxy.ts";
import type { Sql } from "../postgres.ts";

export type UserbotProxyStatus = "never_tried" | "ok" | "timeout" | "failed";

export interface UserbotProxyRow {
  id: number;
  position: number;
  raw: string;
  parsed_host: string;
  parsed_port: number;
  parsed_secret: string;
  last_status: UserbotProxyStatus;
  last_tried_at: number | null;
  last_error: string | null;
  last_connect_ms: number | null;
  created_at: number;
}

/**
 * MTProto proxy list, managed via /admin/ops. When non-empty, takes
 * precedence over USERBOT_MTPROXY_LIST in the env so the operator can
 * swap entries without a redeploy. The userbot subprocess updates the
 * `last_*` columns after every connect attempt so the admin UI can
 * show which entries are alive vs dead.
 */
export class UserbotProxiesRepo {
  constructor(private sql: Sql) {}

  /** Ordered by `position` so the userbot iterates the operator's chosen
   *  ranking. Ties broken by id to keep the order deterministic. */
  list(): Promise<UserbotProxyRow[]> {
    return this.sql<UserbotProxyRow[]>`
      SELECT * FROM userbot_proxies ORDER BY position ASC, id ASC
    `;
  }

  /**
   * Bulk-replace the entire list in one transaction. We delete-then-insert
   * rather than diff because:
   *   - the operator's mental model is "paste the new list, that's what's
   *     active now" — incremental diffing would be surprising
   *   - status columns reset on replace, which is desirable (an entry that
   *     was `timeout` yesterday might be alive today on the new IP)
   *
   * `position` is the array index of `parsed` (0-based). `raw` holds the
   * original input string so the admin UI can re-display exactly what
   * the operator pasted, including comments and stripped whitespace.
   */
  async replaceAll(entries: Array<{ raw: string; parsed: ParsedMTProxy }>): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM userbot_proxies`;
      if (entries.length === 0) return;
      // Multi-row INSERT in a single round-trip — `sql(values, ...keys)`
      // expands to a tuple list. Position derives from array index so the
      // operator's paste order is preserved exactly.
      const rows = entries.map((e, i) => ({
        position: i,
        raw: e.raw,
        parsed_host: e.parsed.ip,
        parsed_port: e.parsed.port,
        parsed_secret: e.parsed.secret,
      }));
      await tx`
        INSERT INTO userbot_proxies ${tx(rows, "position", "raw", "parsed_host", "parsed_port", "parsed_secret")}
      `;
    });
  }

  /**
   * Update the per-proxy connect outcome. Called by the userbot subprocess
   * after each handshake attempt. `connectMs` is the elapsed time for the
   * attempt (useful to show "fast vs slow but working" in the UI). `error`
   * is the gramjs error message for failed/timeout statuses.
   */
  async markStatus(
    id: number,
    status: UserbotProxyStatus,
    opts: { error?: string | null; connectMs?: number | null } = {},
  ): Promise<void> {
    await this.sql`
      UPDATE userbot_proxies
      SET last_status = ${status},
          last_tried_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
          last_error = ${opts.error ?? null},
          last_connect_ms = ${opts.connectMs ?? null}
      WHERE id = ${id}
    `;
  }

  /** Reset every row's status back to `never_tried`. Useful after a Telegram
   *  outage when all entries got marked `timeout` and the operator wants
   *  a clean canvas before the next connect cycle. */
  async clearStatuses(): Promise<void> {
    await this.sql`
      UPDATE userbot_proxies
      SET last_status = 'never_tried',
          last_tried_at = NULL,
          last_error = NULL,
          last_connect_ms = NULL
    `;
  }

  /** Cheap existence check — used by the userbot subprocess to decide
   *  whether to read from DB or fall back to the env-list. */
  async hasAny(): Promise<boolean> {
    const [row] = await this.sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM userbot_proxies LIMIT 1`;
    return (row?.n ?? 0) > 0;
  }
}
