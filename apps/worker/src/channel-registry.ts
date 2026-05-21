import type { ChannelAdapter } from "@chatman-media/channel-core";
import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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

export class WorkerChannelRegistry {
  private readonly byDbId = new Map<number, WorkerChannelEntry>();

  private resolveBotToken(tenantSlug: string): string | null {
    const envKey = `BOT_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.BOT_TOKEN ?? null;
  }

  async loadFromDb(
    db: PostgresJsDatabase<{ channels: typeof channels; tenants: typeof tenants }>,
  ): Promise<void> {
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      if (row.kind !== "telegram_bot") continue;
      const token = this.resolveBotToken(row.tenantSlug);
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
