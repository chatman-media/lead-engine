import { describe, expect, test } from "bun:test";

import type { LeadRow, LeadState } from "@/db/repos/leads.ts";
import { _testHelpers, leadOutcome } from "@/leads/outcome-attribution.ts";

const mkLead = (state: LeadState): LeadRow =>
  ({
    id: 1,
    user_id: 1,
    state,
    intake_json: null,
    visa_docs_json: null,
    application_id: null,
    ops_chat_id: null,
    ops_message_id: null,
    rejected_reason: null,
    decided_by_admin_id: null,
    decided_at: null,
    created_at: 0,
    updated_at: 0,
  }) satisfies LeadRow;

describe("leadOutcome", () => {
  test("docs_complete → won / lead_submitted", () => {
    expect(leadOutcome(mkLead("docs_complete"))).toEqual({
      outcome: "won",
      source: "lead_submitted",
    });
  });

  test("submitted → won / lead_submitted", () => {
    expect(leadOutcome(mkLead("submitted"))).toEqual({
      outcome: "won",
      source: "lead_submitted",
    });
  });

  test("rejected → draw / lead_rejected", () => {
    expect(leadOutcome(mkLead("rejected"))).toEqual({
      outcome: "draw",
      source: "lead_rejected",
    });
  });

  test("closed → lost / lead_ghosted", () => {
    expect(leadOutcome(mkLead("closed"))).toEqual({
      outcome: "lost",
      source: "lead_ghosted",
    });
  });

  test("non-terminal states attribute nothing", () => {
    for (const s of ["intake_pending", "intake_complete", "approved", "docs_pending"] as const) {
      expect(leadOutcome(mkLead(s))).toBeNull();
    }
  });
});

describe("_testHelpers.parseSkillsUsed", () => {
  const { parseSkillsUsed } = _testHelpers;

  test("extracts a valid string array from telemetry.skills_used", () => {
    const meta = JSON.stringify({ telemetry: { skills_used: ["social_proof", "reciprocity"] } });
    expect(parseSkillsUsed(meta)).toEqual(["social_proof", "reciprocity"]);
  });

  test("returns [] for null meta", () => {
    expect(parseSkillsUsed(null)).toEqual([]);
  });

  test("returns [] for malformed JSON", () => {
    expect(parseSkillsUsed("{not json")).toEqual([]);
  });

  test("returns [] when skills_used is missing or not an array", () => {
    expect(parseSkillsUsed(JSON.stringify({ telemetry: {} }))).toEqual([]);
    expect(parseSkillsUsed(JSON.stringify({ telemetry: { skills_used: "nope" } }))).toEqual([]);
  });

  test("drops non-string elements from the array", () => {
    const meta = JSON.stringify({ telemetry: { skills_used: ["ok", 1, null, "fine"] } });
    expect(parseSkillsUsed(meta)).toEqual(["ok", "fine"]);
  });
});
