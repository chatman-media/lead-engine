import type { ChannelAdapter } from "@chatman-media/channel-core";
import { MessengerAdapter } from "@chatman-media/channel-facebook";
import { MaxAdapter } from "@chatman-media/channel-max";
import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { VkAdapter } from "@chatman-media/channel-vk";
import { WhatsAppCloudAdapter } from "@chatman-media/channel-whatsapp";
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
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "facebook" | "vk" | "max" | "web";
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
  /** Cached opts чтобы reloadAll использовал тот же masterKey + onWarn. */
  private loadOpts: LoadFromDbOpts = {};
  private dbRef: Db | null = null;

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

  /**
   * Generic per-tenant credential resolver для Meta-каналов (whatsapp/facebook):
   * tenant_secrets[credentialsRef] (decrypt) → env `<PREFIX>_<SLUG>` → env `<PREFIX>`.
   */
  private async resolveCredential(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
    envPrefix: string,
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
        onWarn?.("failed to decrypt worker channel credential", {
          tenantId,
          tenantSlug,
          credentialsRef,
          envPrefix,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `${envPrefix}_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env[envPrefix] ?? null;
  }

  async loadFromDb(db: Db, opts: LoadFromDbOpts = {}): Promise<void> {
    this.loadOpts = opts;
    this.dbRef = db;
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        externalId: channels.externalId,
        credentialsRef: channels.credentialsRef,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      let adapter: ChannelAdapter | null = null;
      if (row.kind === "telegram_bot") {
        const token = await this.resolveBotToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        adapter = new TelegramBotAdapter({ id: String(row.channelId), token });
      } else if (row.kind === "whatsapp") {
        const token = await this.resolveCredential(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
          "WA_ACCESS_TOKEN",
        );
        if (!token) continue;
        // external_id у whatsapp канала = phone_number_id (Meta).
        adapter = new WhatsAppCloudAdapter({
          id: String(row.channelId),
          phoneNumberId: row.externalId,
          accessToken: token,
        });
      } else if (row.kind === "facebook") {
        const token = await this.resolveCredential(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
          "FB_PAGE_TOKEN",
        );
        if (!token) continue;
        adapter = new MessengerAdapter({ id: String(row.channelId), pageAccessToken: token });
      } else if (row.kind === "vk") {
        const token = await this.resolveCredential(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
          "VK_ACCESS_TOKEN",
        );
        if (!token) continue;
        adapter = new VkAdapter({ id: String(row.channelId), accessToken: token });
      } else if (row.kind === "max") {
        const token = await this.resolveCredential(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
          "MAX_BOT_TOKEN",
        );
        if (!token) continue;
        adapter = new MaxAdapter({ id: String(row.channelId), accessToken: token });
      } else {
        // telegram_userbot / web держат pinned-соединение в apps/api.
        continue;
      }
      if (!adapter) continue;
      this.byDbId.set(row.channelId, {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        kind: row.kind as WorkerChannelEntry["kind"],
        adapter,
      });
    }
  }

  /**
   * Hot-reload: close existing adapters + re-load from DB. Polling-based
   * (см. WORKER_CHANNEL_RELOAD_MS). Идемпотентен — повторный вызов без
   * изменений в БД даст то же состояние (с пересозданными adapter'ами).
   *
   * Returns delta для логирования.
   */
  async reloadAll(): Promise<{ before: number; after: number }> {
    if (!this.dbRef) return { before: 0, after: 0 };
    const before = this.byDbId.size;
    this.closeAll();
    this.byDbId.clear();
    await this.loadFromDb(this.dbRef, this.loadOpts);
    return { before, after: this.byDbId.size };
  }

  byChannelId(channelId: number): WorkerChannelEntry | undefined {
    return this.byDbId.get(channelId);
  }

  size(): number {
    return this.byDbId.size;
  }

  closeAll(): void {
    for (const entry of this.byDbId.values()) {
      // close() есть у всех загружаемых адаптеров (telegram/whatsapp/facebook),
      // но не объявлен в ChannelAdapter-интерфейсе — зовём опционально.
      (entry.adapter as { close?: () => void }).close?.();
    }
  }
}
