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
import { mkdirSync, realpathSync, accessSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";

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
 * Path to the per-workspace acknowledgement flag for `allow_writes=true`.
 *
 * Lives under `$STATE_DIR/ack/<sha256(workspace_root)[:16]>.json`, NOT
 * inside the workspace itself. This is intentional: storing it inside the
 * workspace would let anyone pre-create or commit
 * `.cc-plugin-codex/allow_writes_acknowledged.flag` to bypass the gate
 * permanently. By keeping ack state in $STATE_DIR (which we never expose
 * to Claude — see isUnderStateDir), only the broker can create or remove
 * it, and the contract "first allow_writes:true requires explicit ack"
 * actually holds.
 *
 * The hash key — rather than the literal path — keeps file names short
 * and avoids leaking workspace paths via state-dir listings; the JSON
 * payload still records the original workspace_root for diagnostics.
 *
 * @param {string} workspaceRoot  Absolute, already-realpath'd workspace root.
 * @returns {string}
 */
export function checkStateDirWritable() {
  const target = stateRoot();
  try {
    mkdirSync(target, { recursive: true });
    accessSync(target, fsConstants.W_OK | fsConstants.X_OK);
    return { ok: true, path: target };
  } catch (err) {
    const code = err && err.code ? err.code : "unknown";
    return {
      ok: false,
      path: target,
      error: code,
      hint: buildStateDirHint(target, code),
    };
  }
}

function buildStateDirHint(target, code) {
  const altPath = path.join(os.homedir(), "Library", "Application Support");
  return [
    `broker cannot write to $STATE_DIR (${target}); errno=${code}.`,
    `Fix options:`,
    `  1. Reclaim ownership: sudo chown -R $(id -un):$(id -gn) "${path.dirname(target)}"`,
    `  2. Point elsewhere:   codex mcp remove claude-code && \\`,
    `       codex mcp add claude-code --env XDG_STATE_HOME="${altPath}" -- \\`,
    `       node <abs-path-to-claude-broker.mjs>`,
    `  3. Direct override:   set CC_PLUGIN_CODEX_STATE_DIR to any absolute writable path.`,
  ].join("\n");
}

export function ackFlagPath(workspaceRoot) {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error(
      `ackFlagPath requires an absolute workspaceRoot, got: ${workspaceRoot}`,
    );
  }
  const key = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(stateRoot(), "ack", `${key}.json`);
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
  // Realpath both sides so symlinks can't disguise an escape.
  // On macOS /tmp is itself a symlink to /private/tmp, so this is required
  // even for "normal" paths — not only for user-created symlinks.
  const root = realpathOrResolve(stateRoot());
  const c = realpathOrResolve(candidate);
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

/**
 * Realpath an absolute path; if it doesn't exist, walk up to the nearest
 * existing ancestor and append the remaining tail. Falls back to
 * path.resolve if no ancestor exists.
 *
 * Exported so permission.mjs (and anything else that needs to compare paths
 * to $STATE_DIR) can use the same resolution policy.
 *
 * @param {string} absPath
 * @returns {string}
 */
export function realpathOrResolve(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    let parent = path.dirname(absPath);
    const tail = [path.basename(absPath)];
    while (parent !== path.dirname(parent)) {
      try {
        const real = realpathSync(parent);
        return path.join(real, ...tail.reverse());
      } catch {
        tail.push(path.basename(parent));
        parent = path.dirname(parent);
      }
    }
    return path.resolve(absPath);
  }
}
