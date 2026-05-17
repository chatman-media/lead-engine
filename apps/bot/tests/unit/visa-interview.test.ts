import { describe, expect, test } from "bun:test";

import { VISA_FIELD_LABELS } from "@/leads/visa-docs.ts";
import {
  firstInterviewField,
  interviewQuestion,
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
