// State directory policy for cc-plugin-codex.
//
// Internal state (session locks, background jobs) lives under
//   $XDG_STATE_HOME/cc-plugin-codex/  (default: $HOME/.local/state/cc-plugin-codex/)
// The workspace ACK flag is the only on-disk state allowed inside the user
// workspace root; everything else stays under $STATE_DIR.
//
// POSIX-only. Windows is intentionally unsupported.

import os from "node:os";
import path from "node:path";

const APP_NAME = "cc-plugin-codex";

/**
 * True when we're on a supported POSIX platform.
 * @returns {boolean}
 */
export function isPlatformSupported() {
  return process.platform === "darwin" || process.platform === "linux";
}

/**
 * Absolute path to the internal state root: $STATE_DIR.
 *
 * Resolution order:
 *   1. $CC_PLUGIN_CODEX_STATE_DIR  (explicit override; MUST be absolute)
 *   2. $XDG_STATE_HOME/cc-plugin-codex  (if $XDG_STATE_HOME is absolute)
 *   3. $HOME/.local/state/cc-plugin-codex
 *
 * Non-absolute env values are ignored (per XDG Base Directory Spec) and the
 * next fallback is used, so internal state can never leak into cwd/workspace.
 *
 * Note: the $CC_PLUGIN_CODEX_STATE_DIR override is primarily for test
 * harnesses but is part of the public contract — documented here and in
 * docs/DESIGN.md "path catalog".
 *
 * @returns {string}
 */
export function stateRoot() {
  const override = process.env.CC_PLUGIN_CODEX_STATE_DIR;
  if (override && path.isAbsolute(override)) {
    return path.resolve(override);
  }

  const xdgState = process.env.XDG_STATE_HOME;
  const base =
    xdgState && path.isAbsolute(xdgState)
      ? xdgState
      : path.join(os.homedir(), ".local", "state");

  return path.join(base, APP_NAME);
}

/** @returns {string} */
export function sessionsDir() {
  return path.join(stateRoot(), "sessions");
}

/** @returns {string} */
export function jobsDir() {
  return path.join(stateRoot(), "jobs");
}

// UUID-ish identifiers only: hex/dash plus alnum, no path separators, no '..'.
// Strict enough to guarantee path.join below can never escape its parent.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeId(kind, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`invalid ${kind}: ${JSON.stringify(id)}`);
  }
}

/**
 * Path to a single session lock directory.
 * @param {string} sessionId  Claude session UUID (validated)
 * @returns {string}
 */
export function sessionLockPath(sessionId) {
  assertSafeId("sessionId", sessionId);
  return path.join(sessionsDir(), `${sessionId}.lock`);
}

/**
 * Path to a job's directory (contains state.json, output.log, .write.lock/).
 * @param {string} jobId  Validated UUID-ish.
 * @returns {string}
 */
export function jobDir(jobId) {
  assertSafeId("jobId", jobId);
  return path.join(jobsDir(), jobId);
}

/**
 * Path to the workspace-scoped acknowledgement flag for `allow_writes=true`.
 * Lives under <workspace_root>/.cc-plugin-codex/allow_writes_acknowledged.flag.
 * Caller is responsible for normalising workspace_root via realpath.
 *
 * @param {string} workspaceRoot  Absolute, already-realpath'd workspace root.
 * @returns {string}
 */
export function ackFlagPath(workspaceRoot) {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error(
      `ackFlagPath requires an absolute workspaceRoot, got: ${workspaceRoot}`,
    );
  }
  return path.join(
    workspaceRoot,
    ".cc-plugin-codex",
    "allow_writes_acknowledged.flag",
  );
}

/**
 * True iff `candidate` (resolved) lies inside `$STATE_DIR`.
 * Used by the broker to refuse any --add-dir entry that would expose
 * internal state to a Claude child process.
 *
 * Both paths are compared after path.resolve() — callers should pass
 * realpath()-resolved inputs when symlink crossing matters.
 *
 * @param {string} candidate  Absolute path to test.
 * @returns {boolean}
 */
export function isUnderStateDir(candidate) {
  const root = path.resolve(stateRoot());
  const c = path.resolve(candidate);
  if (c === root) return true;
  const rel = path.relative(root, c);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  // Only treat ".." or "../…" (with separator) as escape; a child named
  // literally "..foo" is a legitimate descendant, not an escape.
  if (rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  return true;
}
