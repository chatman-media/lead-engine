import { describe, expect, test } from "bun:test";

import { VISA_FIELD_LABELS } from "@/leads/visa-docs.ts";
import {
  firstInterviewField,
  interviewQuestion,
  interviewQuestionWithPrefill,
  isInterviewConfirmation,
  nextInterviewField,
  VISA_INTERVIEW_STEPS,
} from "@/leads/visa-interview.ts";

describe("visa-interview step list", () => {
  test("covers every VisaFields key exactly once", () => {
    const stepFields = VISA_INTERVIEW_STEPS.map((s) => s.field);
    const labelKeys = Object.keys(VISA_FIELD_LABELS);
    expect(new Set(stepFields).size).toBe(stepFields.length); // no duplicates
    expect([...stepFields].sort()).toEqual(labelKeys.sort());
  });

  test("every step has a non-empty question", () => {
    for (const step of VISA_INTERVIEW_STEPS) {
      expect(step.question.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("firstInterviewField / nextInterviewField", () => {
  test("first field is family_name", () => {
    expect(firstInterviewField()).toBe("family_name");
  });

  test("next advances to the following field", () => {
    expect(nextInterviewField("family_name")).toBe("given_name");
  });

  test("next of the last field is null", () => {
    const last = VISA_INTERVIEW_STEPS[VISA_INTERVIEW_STEPS.length - 1]!.field;
    expect(nextInterviewField(last)).toBeNull();
  });

  test("next of an unknown field is null", () => {
    expect(nextInterviewField("not_a_field")).toBeNull();
  });

  test("walking from first to null visits every step once", () => {
    let field: string | null = firstInterviewField();
    const visited: string[] = [];
    while (field) {
      visited.push(field);
      field = nextInterviewField(field);
    }
    expect(visited).toEqual(VISA_INTERVIEW_STEPS.map((s) => s.field));
  });
});

describe("interviewQuestion", () => {
  test("returns the question text for a known field", () => {
    expect(interviewQuestion("family_name")).toContain("Family name");
  });

  test("returns undefined for an unknown field", () => {
    expect(interviewQuestion("not_a_field")).toBeUndefined();
  });
});

describe("interviewQuestionWithPrefill", () => {
  test("returns the bare question when the field is not pre-filled", () => {
    expect(interviewQuestionWithPrefill("date_of_birth", {})).toBe(
      interviewQuestion("date_of_birth"),
    );
    expect(interviewQuestionWithPrefill("date_of_birth", undefined)).toBe(
      interviewQuestion("date_of_birth"),
    );
    expect(interviewQuestionWithPrefill("date_of_birth", { date_of_birth: "   " })).toBe(
      interviewQuestion("date_of_birth"),
    );
  });

  test("appends a confirm-or-correct hint with the pre-filled value", () => {
    const out = interviewQuestionWithPrefill("date_of_birth", { date_of_birth: "1998-04-12" });
    expect(out).toContain("Date of birth");
    expect(out).toContain("«1998-04-12»");
    expect(out).toContain("«да»");
  });

  test("returns undefined for an unknown field", () => {
    expect(interviewQuestionWithPrefill("not_a_field", { not_a_field: "x" })).toBeUndefined();
  });
});

describe("isInterviewConfirmation", () => {
  test("recognises confirmation words regardless of case / spacing", () => {
    expect(isInterviewConfirmation("да")).toBe(true);
    expect(isInterviewConfirmation("  Да ")).toBe(true);
    expect(isInterviewConfirmation("ВЕРНО")).toBe(true);
    expect(isInterviewConfirmation("yes")).toBe(true);
    expect(isInterviewConfirmation("всё верно")).toBe(true);
  });

  test("treats an actual value as a correction, not a confirmation", () => {
    expect(isInterviewConfirmation("1998-04-12")).toBe(false);
    expect(isInterviewConfirmation("Ivanova")).toBe(false);
    expect(isInterviewConfirmation("")).toBe(false);
  });
});
