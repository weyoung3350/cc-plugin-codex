// Permission level → Claude CLI flag mapping.
//
// Two levels in MVP (see docs/DESIGN.md "permission boundary"):
//   - "plan"   : read-only. Default for claude_ask / claude_review /
//                claude_task (unless allow_writes=true).
//                --permission-mode=plan --tools "Read,Grep,Glob"
//   - "writes" : accepts edits without prompting.
//                --permission-mode=acceptEdits
//                --tools "Read,Edit,Write,Grep,Glob"
//
// MVP explicitly excludes "shell" (Bash) — granting it erases the default
// constraint set. We revisit after Phase 5.
//
// Regardless of level we always apply:
//   --bare --strict-mcp-config --output-format=json --add-dir <cwd>
//
// Session flag emission (independent of permission level):
//   - session_id present + useResume=true   → "--resume <session_id>"
//   - session_id present + useResume=false  → "--session-id <session_id>"
//   - session_id absent                     → "--no-session-persistence"
//
// The resume-fallback protocol (try --resume first, fall back to
// --session-id on "session not found") is a RUNTIME concern and lives in
// claude-run.mjs so it can observe the first invocation's exit code before
// deciding to retry inside the same session lock.

import path from "node:path";

import { isUnderStateDir, realpathOrResolve } from "./xdg.mjs";

/** @typedef {"plan" | "writes"} PermissionLevel */

const BASE_FLAGS = Object.freeze([
  "-p",
  "--bare",
  "--strict-mcp-config",
  "--output-format=json",
]);

const LEVEL_FLAGS = Object.freeze({
  plan: Object.freeze(["--permission-mode=plan", "--tools", "Read,Grep,Glob"]),
  writes: Object.freeze([
    "--permission-mode=acceptEdits",
    "--tools",
    "Read,Edit,Write,Grep,Glob",
  ]),
});

/**
 * Validate every entry of add_dirs. Rules:
 *   - must be a non-empty string
 *   - must be an absolute path (we don't resolve relative paths for the
 *     caller — surprising if they change between two lookups)
 *   - must NOT lie inside $STATE_DIR (broker internal state stays hidden)
 *
 * Throws a typed Error so the broker can turn it into a tool error.
 *
 * @param {string[] | undefined} add_dirs
 * @returns {string[]}
 */
export function validateAddDirs(add_dirs) {
  if (add_dirs === undefined || add_dirs === null) return [];
  if (!Array.isArray(add_dirs)) {
    throw new PermissionError("invalid-add-dirs", "add_dirs must be an array");
  }
  const out = [];
  for (const raw of add_dirs) {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new PermissionError(
        "invalid-add-dirs",
        "each add_dirs entry must be a non-empty string",
      );
    }
    if (!path.isAbsolute(raw)) {
      throw new PermissionError(
        "invalid-add-dirs",
        `add_dirs entry must be absolute: ${raw}`,
      );
    }
    const resolved = realpathOrResolve(raw);
    if (isUnderStateDir(resolved)) {
      throw new PermissionError(
        "forbidden-add-dir",
        `add_dirs entry lies inside $STATE_DIR (after symlink resolution): ${raw}`,
      );
    }
    out.push(resolved);
  }
  return out;
}

/**
 * Build the full argv for a single `claude -p ...` invocation.
 *
 * Session handling:
 *   - session_id present + useResume=true  → "--resume <session_id>"
 *   - session_id present + useResume=false → "--session-id <session_id>"
 *   - session_id absent → "--no-session-persistence"
 *
 * @param {object} opts
 * @param {PermissionLevel} opts.permission
 * @param {string} opts.cwd                      Resolved absolute cwd.
 * @param {string[]=} opts.add_dirs              Extra absolute dirs (validated).
 * @param {string|undefined} opts.session_id
 * @param {boolean=} opts.useResume              Only meaningful when session_id set.
 * @param {object=} opts.schema                  If present → inject --json-schema.
 * @returns {string[]}  argv tail AFTER the "claude" binary (callers prepend bin).
 */
export function buildClaudeFlags(opts) {
  if (!opts || typeof opts !== "object") {
    throw new PermissionError("invalid-args", "buildClaudeFlags: opts required");
  }
  const { permission, cwd, add_dirs, session_id, useResume = true, schema } = opts;
  if (!LEVEL_FLAGS[permission]) {
    throw new PermissionError(
      "invalid-permission",
      `permission must be plan|writes, got ${permission}`,
    );
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new PermissionError(
      "invalid-cwd",
      `buildClaudeFlags: cwd must be absolute, got ${cwd}`,
    );
  }
  const resolvedCwd = realpathOrResolve(cwd);
  if (isUnderStateDir(resolvedCwd)) {
    throw new PermissionError(
      "forbidden-add-dir",
      `cwd lies inside $STATE_DIR (after symlink resolution): ${cwd}`,
    );
  }

  const extras = validateAddDirs(add_dirs);

  const flags = [...BASE_FLAGS, ...LEVEL_FLAGS[permission]];

  // --add-dir <cwd> then --add-dir for each extra; always include cwd so
  // Claude can read files there under plan mode. Use the realpath-resolved
  // form so Claude opens the true target (not a symlink that we refused).
  flags.push("--add-dir", resolvedCwd);
  for (const d of extras) flags.push("--add-dir", d);

  // Session branch.
  if (typeof session_id === "string" && session_id.length > 0) {
    if (useResume) flags.push("--resume", session_id);
    else flags.push("--session-id", session_id);
  } else {
    flags.push("--no-session-persistence");
  }

  // Optional: structured output. Only inject when `schema` is a non-empty
  // object — wider truthy-coercion would let {}/[]/""/false/0 silently
  // become `--json-schema '{}'` or `--json-schema 'false'`, which Claude
  // treats as "any object" or a malformed flag.
  if (
    schema !== undefined &&
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Object.keys(schema).length > 0
  ) {
    flags.push("--json-schema", JSON.stringify(schema));
  } else if (schema !== undefined && schema !== null) {
    throw new PermissionError(
      "invalid-schema",
      "schema must be a non-empty plain object",
    );
  }

  return flags;
}

/**
 * Errors raised by permission/flag construction. Callers wrap into MCP
 * tool errors.
 */
export class PermissionError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = "PermissionError";
    this.reason = reason;
  }
}
