import { config } from "../config.ts";
import { FULL_BODY_PHOTO_NUDGE, PASSPORT_PHOTO_ACK } from "../leads/templates.ts";
import { log } from "../log.ts";
import { classifyPhoto } from "../rag/vision.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

/**
 * Per-turn maintenance hook: classify any not-yet-classified photo the
 * candidate uploaded (passport / full-body / portrait / other) via a
 * vision model on OpenRouter, then acknowledge milestones to her.
 *
 * Runs BEFORE `runIntakeUpdate` so the freshly-stamped
 * `meta_json.media.photo_class` values are visible to the intake
 * counters. Entirely skipped unless `VISION_ENABLED`.
 *
 * Acknowledgements are deduped via one-shot flags in
 * `lead.intake_json.media_ack` — a Telegram album arrives as many
 * separate messages, each firing this hook, so without the flag the
 * candidate would get the same "passport received" line N times.
 */

/** Cap per turn so enabling the feature on an old chat with a big photo
 *  backlog doesn't download + classify everything in one go. */
const MAX_PHOTOS_PER_TURN = 12;

/** Below this many photos a missing full-body shot isn't worth nudging
 *  about — she may simply not be done uploading. */
const FULL_BODY_NUDGE_MIN_PHOTOS = 6;

export async function runPhotoClassification(d: ProcessInboundDeps): Promise<void> {
  if (!config.vision.enabled) return;
  const apiKey = config.openrouter.apiKey;
  if (!apiKey) {
    log.warn("VISION_ENABLED set but OPENROUTER_API_KEY missing — skipping classification", {
      scope: "vision",
    });
    return;
  }
  // Like every post-reply hook, swallow our own errors so a failure here
  // never aborts the rest of `runPostReplyHooks` (intake / visa-docs).
  try {
    await classifyAndAcknowledge(d, apiKey);
  } catch (err) {
    log.error("vision: photo-classification hook failed", { scope: "vision", err });
  }
}

async function classifyAndAcknowledge(d: ProcessInboundDeps, apiKey: string): Promise<void> {
  // 1. Classify pending photos.
  const pending = await d.messages.unclassifiedPhotos(d.conv.id);
  for (const photo of pending.slice(0, MAX_PHOTOS_PER_TURN)) {
    try {
      const res = await d.telegram.downloadFile(photo.file_id);
      if (!res.ok) {
        log.error("vision: telegram file download failed", {
          scope: "vision",
          messageId: photo.id,
          status: res.status,
        });
        continue;
      }
      const bytes = await res.arrayBuffer();
      const photoClass = await classifyPhoto({
        bytes,
        ...(photo.mime_type ? { mimeType: photo.mime_type } : {}),
        model: config.vision.model,
        apiKey,
        baseUrl: config.openrouter.baseUrl,
      });
      await d.messages.setPhotoClass(photo.id, photoClass);
      log.info("vision: photo classified", {
        scope: "vision",
        messageId: photo.id,
        photoClass,
      });
    } catch (err) {
      // Leave the photo unclassified — it gets retried on the next turn.
      log.error("vision: photo classification failed", {
        scope: "vision",
        messageId: photo.id,
        err,
      });
    }
  }

  // 2. Acknowledge milestones to the candidate. Needs a lead to store the
  //    one-shot dedup flags. Bootstrap one the same way `runIntakeUpdate`
  //    does (requires an ops chat) so the FIRST photo already gets an
  //    acknowledgement — otherwise the lead would only be created by the
  //    intake hook that runs after this one, delaying the reply a turn.
  let lead = await d.leads.byUserId(d.user.id);
  if (!lead) {
    if (d.leadsChatId == null) return;
    lead = await d.leads.ensureForUser(d.user.id);
  }
  // Operator-owned states (approved / rejected / submitted / …) are off-limits.
  if (lead.state !== "intake_pending" && lead.state !== "intake_complete") return;

  const counts = await d.messages.countPhotosByClass(d.conv.id);
  const totalClassified = counts.passport + counts.full_body + counts.portrait + counts.other;

  // `claimMediaAck` flips the dedup flag atomically and returns true to
  // exactly one caller, so an 8-photo album (8 parallel webhooks) yields a
  // single acknowledgement. Claim BEFORE sending — at-most-once is the
  // right tradeoff for an ack: a rare lost message beats spamming her.
  if (counts.passport >= 1 && (await d.leads.claimMediaAck(lead.id, "passport"))) {
    await sendToCandidate(d, PASSPORT_PHOTO_ACK);
  }
  if (
    totalClassified >= FULL_BODY_NUDGE_MIN_PHOTOS &&
    counts.full_body === 0 &&
    (await d.leads.claimMediaAck(lead.id, "full_body_nudged"))
  ) {
    await sendToCandidate(d, FULL_BODY_PHOTO_NUDGE);
  }
}

async function sendToCandidate(d: ProcessInboundDeps, text: string): Promise<void> {
  try {
    await d.telegram.sendMessage({ chatId: d.chatId, text });
  } catch (err) {
    log.error("vision: failed to send acknowledgement to candidate", { scope: "vision", err });
  }
}
