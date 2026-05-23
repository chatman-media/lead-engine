/**
 * Photo classification + passport OCR. Wired into all inbound pipelines
 * (Telegram bot, userbot, WhatsApp) after processInbound persists the message.
 *
 * When a tenant has a 'vision' LLM config:
 *   1. For each photo part in the inbound, download bytes via adapter.downloadMedia().
 *   2. Call classifyPhoto() — returns "passport" | "full_body" | "portrait" | "other".
 *   3. If "passport" → call extractPassportIdentity() to OCR the MRZ.
 *   4. Merge results into contact.attributes_json via a new tenant-scoped tx.
 *
 * Non-fatal: any download or vision API error is caught and skipped. The
 * pipeline reply is never blocked by photo processing failures.
 */

import type { ChannelAdapter, Inbound } from "@chatman-media/channel-core";
import { ContactsRepo, type Db, withTenant } from "@chatman-media/conversation-engine";
import { classifyPhoto, extractPassportIdentity } from "@chatman-media/kb";
import type { LoadedRef } from "../llm-bootstrap.ts";

export interface PhotoProcessor {
  process(opts: {
    tenantId: number;
    inbound: Inbound;
    adapter: ChannelAdapter;
    contactId: number;
    db: Db;
  }): Promise<void>;
}

export function makePhotoProcessor(ref: LoadedRef): PhotoProcessor {
  return {
    async process({ tenantId, inbound, adapter, contactId, db }) {
      const cfg = ref.current.byTenant.get(tenantId)?.get("vision");
      if (!cfg || !cfg.apiKey) return;
      if (cfg.provider !== "openai" && cfg.provider !== "openrouter") return;

      const photoParts = inbound.parts.filter((p) => p.kind === "photo");
      if (photoParts.length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      const attrs: Record<string, unknown> = {};

      for (const part of photoParts) {
        if (part.kind !== "photo") continue;
        try {
          const res = await adapter.downloadMedia(part.mediaRef);
          const bytes = await res.arrayBuffer();

          const photoClass = await classifyPhoto({
            bytes,
            model: cfg.model,
            apiKey: cfg.apiKey,
            provider: cfg.provider,
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
            ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
          });

          attrs.last_photo_class = photoClass;

          if (photoClass === "passport") {
            const identity = await extractPassportIdentity({
              bytes,
              model: cfg.model,
              apiKey: cfg.apiKey,
              provider: cfg.provider,
              ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
              ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
            });
            if (identity.family_name) attrs.passport_family_name = identity.family_name;
            if (identity.given_name) attrs.passport_given_name = identity.given_name;
            if (identity.passport_number) attrs.passport_number = identity.passport_number;
            if (identity.passport_expiry) attrs.passport_expiry = identity.passport_expiry;
          }
        } catch {
          // Non-fatal: skip this photo, continue with rest
        }
      }

      if (Object.keys(attrs).length > 0) {
        await withTenant(db, tenantId, async (tx) => {
          await new ContactsRepo({ db: tx, tenantId }).mergeAttributes(contactId, attrs, now);
        });
      }
    },
  };
}
