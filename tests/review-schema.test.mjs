import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_SCHEMA,
  formatReviewPrompt,
  validateReviewOutput,
  ReviewValidationError,
} from "../plugins/cc/scripts/lib/review-schema.mjs";

test("REVIEW_SCHEMA is loaded and has required top-level shape", () => {
  assert.equal(REVIEW_SCHEMA.type, "object");
  assert.ok(Array.isArray(REVIEW_SCHEMA.required));
  for (const r of ["verdict", "summary", "findings", "next_steps"]) {
    assert.ok(REVIEW_SCHEMA.required.includes(r), `missing required: ${r}`);
  }
});

test("formatReviewPrompt: single target", () => {
  const prompt = formatReviewPrompt({ target: "src/foo.ts" });
  assert.match(prompt, /code review/);
  assert.match(prompt, /- src\/foo\.ts/);
  assert.match(prompt, /Respond ONLY with JSON/);
});

test("formatReviewPrompt: array target", () => {
  const prompt = formatReviewPrompt({
    target: ["src/a.ts", "src/b.ts"],
  });
  assert.match(prompt, /- src\/a\.ts/);
  assert.match(prompt, /- src\/b\.ts/);
});

test("formatReviewPrompt: instructions appended", () => {
  const prompt = formatReviewPrompt({
    target: "src/x.ts",
    instructions: "Focus on race conditions.",
  });
  assert.match(prompt, /race conditions/);
});

test("formatReviewPrompt: empty target rejected", () => {
  assert.throws(() => formatReviewPrompt({ target: "" }), /target/);
  assert.throws(() => formatReviewPrompt({ target: [] }), /target/);
  assert.throws(() => formatReviewPrompt({ target: [""] }), /target/);
});

test("validateReviewOutput: happy path approves empty findings", () => {
  validateReviewOutput({
    verdict: "approve",
    summary: "Looks good overall.",
    findings: [],
    next_steps: ["Consider adding tests for edge cases."],
  });
});

test("validateReviewOutput: happy path with findings", () => {
  validateReviewOutput({
    verdict: "needs-attention",
    summary: "Two blockers.",
    findings: [
      {
        severity: "critical",
        title: "SQL injection",
        body: "Unparameterized query in userService.login",
        file: "src/userService.ts",
        line_start: 42,
        line_end: 45,
        confidence: 0.95,
        recommendation: "Use parameterized query.",
      },
    ],
    next_steps: ["Fix the SQLi issue first."],
  });
});

test("validateReviewOutput: rejects non-object root", () => {
  assert.throws(
    () => validateReviewOutput("string"),
    (err) => err instanceof ReviewValidationError && err.field === "root",
  );
  assert.throws(
    () => validateReviewOutput([]),
    (err) => err instanceof ReviewValidationError && err.field === "root",
  );
  assert.throws(
    () => validateReviewOutput(null),
    (err) => err instanceof ReviewValidationError && err.field === "root",
  );
});

test("validateReviewOutput: rejects bad verdict", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "maybe",
        summary: "x",
        findings: [],
        next_steps: [],
      }),
    (err) => err instanceof ReviewValidationError && err.field === "verdict",
  );
});

test("validateReviewOutput: rejects empty summary", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "",
        findings: [],
        next_steps: [],
      }),
    (err) => err instanceof ReviewValidationError && err.field === "summary",
  );
});

test("validateReviewOutput: rejects finding with bad severity", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "blocker",
            title: "t",
            body: "b",
            file: "f",
            line_start: 1,
            line_end: 1,
            confidence: 0.5,
            recommendation: "r",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].severity",
  );
});

test("validateReviewOutput: rejects confidence out of [0,1]", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "low",
            title: "t",
            body: "b",
            file: "f",
            line_start: 1,
            line_end: 1,
            confidence: 1.5,
            recommendation: "r",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].confidence",
  );
});

test("validateReviewOutput: rejects line_start < 1", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "low",
            title: "t",
            body: "b",
            file: "f",
            line_start: 0,
            line_end: 1,
            confidence: 0.5,
            recommendation: "r",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].line_start",
  );
});

test("validateReviewOutput: NaN confidence rejected", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "low",
            title: "t",
            body: "b",
            file: "f",
            line_start: 1,
            line_end: 1,
            confidence: NaN,
            recommendation: "r",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].confidence",
  );
});

test("validateReviewOutput: line_end < 1 rejected", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "low",
            title: "t",
            body: "b",
            file: "f",
            line_start: 1,
            line_end: 0,
            confidence: 0.5,
            recommendation: "r",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].line_end",
  );
});

test("validateReviewOutput: rejects unknown root key (additionalProperties:false)", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [],
        next_steps: [],
        rogue: "smuggled",
      }),
    (err) =>
      err instanceof ReviewValidationError && err.field === "root.rogue",
  );
});

test("validateReviewOutput: rejects unknown finding key", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [
          {
            severity: "low",
            title: "t",
            body: "b",
            file: "f",
            line_start: 1,
            line_end: 1,
            confidence: 0.5,
            recommendation: "r",
            suggested_fix_diff: "rogue field",
          },
        ],
        next_steps: [],
      }),
    (err) =>
      err instanceof ReviewValidationError &&
      err.field === "findings[0].suggested_fix_diff",
  );
});

test("validateReviewOutput: rejects empty next_steps entry", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [],
        next_steps: ["", "valid"],
      }),
    (err) =>
      err instanceof ReviewValidationError && err.field === "next_steps[0]",
  );
});

test("ReviewValidationError carries both field and detail", () => {
  try {
    validateReviewOutput({
      verdict: "hmm",
      summary: "x",
      findings: [],
      next_steps: [],
    });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof ReviewValidationError);
    assert.equal(err.field, "verdict");
    assert.match(err.detail, /approve.*needs-attention/);
    assert.match(err.message, /invalid.*verdict/);
  }
});

test("validateReviewOutput: rejects non-string next_steps entry", () => {
  assert.throws(
    () =>
      validateReviewOutput({
        verdict: "approve",
        summary: "x",
        findings: [],
        next_steps: [42],
      }),
    (err) =>
      err instanceof ReviewValidationError && err.field === "next_steps[0]",
  );
});
