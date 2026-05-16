import { config } from "../config.ts";
import {
  FULL_BODY_PHOTO_NUDGE,
  type IntakeFields,
  PASSPORT_PHOTO_ACK,
} from "../leads/templates.ts";
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
  //    one-shot dedup flags; skip when the operator already owns the lead.
  const lead = await d.leads.byUserId(d.user.id);
  if (!lead) return;
  if (lead.state !== "intake_pending" && lead.state !== "intake_complete") return;

  const counts = await d.messages.countPhotosByClass(d.conv.id);
  const totalClassified = counts.passport + counts.full_body + counts.portrait + counts.other;

  const intake = parseIntake(lead.intake_json);
  const ack = intake.media_ack ?? {};
  let changed = false;

  if (counts.passport >= 1 && !ack.passport) {
    await sendToCandidate(d, PASSPORT_PHOTO_ACK);
    ack.passport = true;
    changed = true;
  }
  if (
    totalClassified >= FULL_BODY_NUDGE_MIN_PHOTOS &&
    counts.full_body === 0 &&
    !ack.full_body_nudged
  ) {
    await sendToCandidate(d, FULL_BODY_PHOTO_NUDGE);
    ack.full_body_nudged = true;
    changed = true;
  }

  if (changed) {
    intake.media_ack = ack;
    await d.leads.setIntake(lead.id, JSON.stringify(intake));
  }
}

async function sendToCandidate(d: ProcessInboundDeps, text: string): Promise<void> {
  try {
    await d.telegram.sendMessage({ chatId: d.chatId, text });
  } catch (err) {
    log.error("vision: failed to send acknowledgement to candidate", { scope: "vision", err });
  }
}

function parseIntake(raw: string | null): IntakeFields {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as IntakeFields;
  } catch {
    return {};
  }
}
