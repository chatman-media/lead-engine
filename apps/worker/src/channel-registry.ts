import type { ChannelAdapter } from "@chatman-media/channel-core";
import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

/**
 * Worker-side channel registry. В отличие от apps/api (которая держит
 * адаптеры только чтобы парсить webhook'и), worker ИСПОЛЬЗУЕТ адаптеры
 * для send(). Те же per-tenant credentials, но отдельные инстансы — Bun
 * процессы не shared'ят memory.
 */
export interface WorkerChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "web";
  adapter: ChannelAdapter;
}

export interface LoadFromDbOpts {
  /** Master-key для расшифровки tenant_secrets. Если не задан — только env fallback. */
  masterKeyHex?: string;
  /** Logger hook для warning'ов о decrypt-ошибках. */
  onWarn?: (msg: string, ctx: Record<string, unknown>) => void;
}

export class WorkerChannelRegistry {
  private readonly byDbId = new Map<number, WorkerChannelEntry>();

  /**
   * Priority: tenant_secrets[credentialsRef] (decrypt) → env fallback.
   * См. apps/api/src/channel-registry.ts для rationale.
   */
  private async resolveBotToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt worker channel bot token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `BOT_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.BOT_TOKEN ?? null;
  }

  async loadFromDb(db: Db, opts: LoadFromDbOpts = {}): Promise<void> {
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        credentialsRef: channels.credentialsRef,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      if (row.kind !== "telegram_bot") continue;
      const token = await this.resolveBotToken(
        db,
        row.tenantId,
        row.tenantSlug,
        row.credentialsRef,
        opts.masterKeyHex,
        opts.onWarn,
      );
      if (!token) continue;
      const adapter = new TelegramBotAdapter({ id: String(row.channelId), token });
      this.byDbId.set(row.channelId, {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        kind: row.kind as "telegram_bot",
        adapter,
      });
    }
  }

  byChannelId(channelId: number): WorkerChannelEntry | undefined {
    return this.byDbId.get(channelId);
  }

  size(): number {
    return this.byDbId.size;
  }

  closeAll(): void {
    for (const entry of this.byDbId.values()) {
      if (entry.adapter instanceof TelegramBotAdapter) entry.adapter.close();
    }
  }
}
