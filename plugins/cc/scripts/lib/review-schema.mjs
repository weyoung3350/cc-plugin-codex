// Review schema loading + prompt composition + light validation.
//
// The schema itself (plugins/cc/schemas/review-output.schema.json) is
// fixed for MVP; callers of claude_review cannot override it. This module
// gives the broker three things:
//   1. REVIEW_SCHEMA — the parsed JSON schema, loaded once at import.
//   2. formatReviewPrompt({ target, instructions? }) — the prompt we send
//      Claude so its output aligns with the schema.
//   3. validateReviewOutput(obj) — a lightweight structural check on what
//      Claude returned, matching the schema's required fields and enums.
//
// We don't pull in an AJV-style validator; the whole point of the fixed
// schema is that the required field set is stable and can be checked
// structurally here. This also keeps the plugin zero-dep.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "schemas",
  "review-output.schema.json",
);

/** @type {any} */
export const REVIEW_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

const VALID_VERDICTS = Object.freeze(["approve", "needs-attention"]);
const VALID_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);

// Mirrors the JSON schema's `additionalProperties: false` constraint at
// each level. Keep these in lockstep with schemas/review-output.schema.json.
const ALLOWED_ROOT_KEYS = Object.freeze(
  new Set(["verdict", "summary", "findings", "next_steps"]),
);
const ALLOWED_FINDING_KEYS = Object.freeze(
  new Set([
    "severity",
    "title",
    "body",
    "file",
    "line_start",
    "line_end",
    "confidence",
    "recommendation",
  ]),
);

/**
 * Build the prompt the broker sends to Claude for a review.
 *
 * The prompt tells Claude: here's what to review, here's the review
 * philosophy, and "reply ONLY with JSON that matches the attached schema".
 * Claude's --json-schema flag already enforces that at the model level; the
 * prompt is a complementary hint so natural-language preambles don't leak.
 *
 * @param {{ target: string | string[], instructions?: string }} opts
 * @returns {string}
 */
export function formatReviewPrompt({ target, instructions }) {
  if (target === undefined || target === null) {
    throw new Error("formatReviewPrompt: target is required");
  }
  const targets = Array.isArray(target) ? target : [target];
  if (targets.length === 0 || targets.some((t) => typeof t !== "string" || t.length === 0)) {
    throw new Error(
      "formatReviewPrompt: target must be a non-empty string or a non-empty array of strings",
    );
  }

  const lines = [
    "You are performing a focused code review.",
    "",
    "Targets to review (file paths or globs):",
    ...targets.map((t) => `  - ${t}`),
  ];
  if (typeof instructions === "string" && instructions.length > 0) {
    lines.push(
      "",
      "Additional reviewer instructions (apply these on top of the defaults):",
      instructions,
    );
  }
  lines.push(
    "",
    "Guidance:",
    "  - Open each target with Read, then use Grep/Glob to build surrounding context before drawing conclusions.",
    "  - Prefer high-signal findings over breadth: surface the issues that would matter in a PR review, not stylistic nits.",
    "  - Every finding MUST cite a concrete file path and line range.",
    "  - confidence ∈ [0, 1]; 1 = verified by reading code, 0 = pure speculation.",
    "  - If the overall change is safe, set verdict='approve' and still fill next_steps with follow-ups worth doing.",
    "",
    "Respond ONLY with JSON matching the attached JSON Schema. No markdown, no prose.",
  );
  return lines.join("\n");
}

/**
 * Structural validation of a parsed review response.
 * Throws a ReviewValidationError on the first problem.
 *
 * @param {unknown} obj
 * @returns {asserts obj is ReviewOutput}
 */
export function validateReviewOutput(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ReviewValidationError("root", "must be a plain object");
  }
  const o = /** @type {any} */ (obj);
  // Strict: refuse unknown top-level keys (mirrors schema.additionalProperties).
  for (const key of Object.keys(o)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      throw new ReviewValidationError(
        `root.${key}`,
        `unknown property; allowed: ${[...ALLOWED_ROOT_KEYS].join(", ")}`,
      );
    }
  }
  if (!VALID_VERDICTS.includes(o.verdict)) {
    throw new ReviewValidationError(
      "verdict",
      `must be one of: ${VALID_VERDICTS.join(", ")}`,
    );
  }
  if (typeof o.summary !== "string" || o.summary.length === 0) {
    throw new ReviewValidationError("summary", "must be a non-empty string");
  }
  if (!Array.isArray(o.findings)) {
    throw new ReviewValidationError("findings", "must be an array");
  }
  for (let i = 0; i < o.findings.length; i += 1) {
    validateFinding(o.findings[i], i);
  }
  if (!Array.isArray(o.next_steps)) {
    throw new ReviewValidationError("next_steps", "must be an array");
  }
  for (let i = 0; i < o.next_steps.length; i += 1) {
    if (typeof o.next_steps[i] !== "string" || o.next_steps[i].length === 0) {
      throw new ReviewValidationError(
        `next_steps[${i}]`,
        "must be a non-empty string",
      );
    }
  }
}

function validateFinding(f, idx) {
  const label = `findings[${idx}]`;
  if (f === null || typeof f !== "object" || Array.isArray(f)) {
    throw new ReviewValidationError(label, "must be a plain object");
  }
  for (const key of Object.keys(f)) {
    if (!ALLOWED_FINDING_KEYS.has(key)) {
      throw new ReviewValidationError(
        `${label}.${key}`,
        `unknown property; allowed: ${[...ALLOWED_FINDING_KEYS].join(", ")}`,
      );
    }
  }
  if (!VALID_SEVERITIES.includes(f.severity)) {
    throw new ReviewValidationError(
      `${label}.severity`,
      `must be one of: ${VALID_SEVERITIES.join(", ")}`,
    );
  }
  for (const field of ["title", "body", "file"]) {
    if (typeof f[field] !== "string" || f[field].length === 0) {
      throw new ReviewValidationError(
        `${label}.${field}`,
        "must be a non-empty string",
      );
    }
  }
  for (const field of ["line_start", "line_end"]) {
    if (!Number.isInteger(f[field]) || f[field] < 1) {
      throw new ReviewValidationError(
        `${label}.${field}`,
        "must be an integer >= 1",
      );
    }
  }
  if (
    !Number.isFinite(f.confidence) ||
    f.confidence < 0 ||
    f.confidence > 1
  ) {
    throw new ReviewValidationError(
      `${label}.confidence`,
      "must be a number in [0, 1]",
    );
  }
  if (typeof f.recommendation !== "string") {
    throw new ReviewValidationError(
      `${label}.recommendation`,
      "must be a string",
    );
  }
}

/**
 * @typedef {object} ReviewFinding
 * @property {"critical"|"high"|"medium"|"low"} severity
 * @property {string} title
 * @property {string} body
 * @property {string} file
 * @property {number} line_start
 * @property {number} line_end
 * @property {number} confidence
 * @property {string} recommendation
 *
 * @typedef {object} ReviewOutput
 * @property {"approve"|"needs-attention"} verdict
 * @property {string} summary
 * @property {ReviewFinding[]} findings
 * @property {string[]} next_steps
 */

export class ReviewValidationError extends Error {
  /** @param {string} field @param {string} detail */
  constructor(field, detail) {
    super(`review output invalid: ${field} — ${detail}`);
    this.name = "ReviewValidationError";
    this.field = field;
    this.detail = detail;
  }
}
