// Workspace root detection + the workspace-scoped allow_writes flag.
//
// Contract (docs/DESIGN.md "allow_writes 轻量硬约束"):
//   - workspace_root = realpath(`git rev-parse --show-toplevel` || cwd)
//   - flag file lives at <workspace_root>/.cc-plugin-codex/allow_writes_acknowledged.flag
//   - first claude_task(allow_writes:true) MUST also pass writes_acknowledged:true;
//     broker writes the flag (atomic tmp+rename); subsequent calls bypass.
//
// realpath both paths so symlinked workdirs / submodule shadows can't spawn
// duplicate ack flags or evade the ack gate.

import { spawnSync as realSpawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { ackFlagPath, realpathOrResolve } from "./xdg.mjs";

const GIT_TIMEOUT_MS = 2_000;

export const _internals = {
  spawnSync: realSpawnSync,
};

/**
 * Resolve the workspace root for the given working directory. Returns an
 * absolute, realpath-normalised path.
 *
 *   1. `git rev-parse --show-toplevel` from `cwd` → use that
 *   2. otherwise fall back to `cwd`
 *
 * Either way, we run the result through realpathOrResolve so symlinks
 * (e.g. /tmp → /private/tmp on macOS, or a worktree → main repo) collapse
 * to a single canonical key.
 *
 * @param {string} cwd  Absolute path; the "starting" directory.
 * @returns {string}    Absolute, realpath-normalised workspace root.
 */
export function detectWorkspaceRoot(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error(`detectWorkspaceRoot: cwd must be absolute, got ${cwd}`);
  }
  let candidate = cwd;
  try {
    const res = _internals.spawnSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (res && res.status === 0 && typeof res.stdout === "string") {
      const top = res.stdout.replace(/[\r\n]+$/, "").trim();
      if (top.length > 0 && path.isAbsolute(top)) candidate = top;
    }
  } catch {
    // Fall through — git not available / not a repo / spawn failed.
  }
  return realpathOrResolve(candidate);
}

/**
 * Defensively realpath the workspace root inside this module so callers
 * that forget to normalise still resolve to the canonical flag location.
 * @param {string} workspaceRoot
 */
function normaliseWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new Error(
      `workspace_root must be absolute, got ${workspaceRoot}`,
    );
  }
  return realpathOrResolve(workspaceRoot);
}

/**
 * Check whether the workspace has previously acknowledged `allow_writes`.
 *
 * Note: ackFlagPath now lives under $STATE_DIR (not under the workspace),
 * so a malicious / careless commit of `.cc-plugin-codex/...` inside the
 * workspace can no longer pre-grant ack. We still validate the contents
 * defensively: existsSync alone would let a `touch` of the state-dir
 * file be enough; the file must parse as JSON whose workspace_root matches
 * the resolved root.
 *
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function ackFlagExists(workspaceRoot) {
  const root = normaliseWorkspaceRoot(workspaceRoot);
  const flagPath = ackFlagPath(root);
  if (!existsSync(flagPath)) return false;
  try {
    const raw = readFileSync(flagPath, "utf8");
    const parsed = JSON.parse(raw);
    return (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.workspace_root === "string" &&
      parsed.workspace_root === root
    );
  } catch {
    return false;
  }
}

/**
 * Atomically create the ack flag for this workspace. Idempotent — even
 * under concurrent callers — because we use link(2) (EEXIST = "someone
 * else already won, leave their flag alone").
 *
 * Returns the absolute path of the flag.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function writeAckFlag(workspaceRoot) {
  const root = normaliseWorkspaceRoot(workspaceRoot);
  const target = ackFlagPath(root);
  mkdirSync(path.dirname(target), { recursive: true });
  // Fast path: already present → noop.
  if (existsSync(target)) return target;

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify(
    {
      acknowledged_at_ms: Date.now(),
      acknowledged_by_pid: process.pid,
      workspace_root: root,
    },
    null,
    2,
  );
  writeFileSync(tmp, payload, { encoding: "utf8" });
  try {
    // link(2) creates a NEW link to tmp at `target`, failing with EEXIST
    // if target already exists. Unlike rename(2) (which silently
    // overwrites on POSIX), this preserves the first writer's payload.
    linkSync(tmp, target);
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
    // Lost the race; another writer already installed the flag. That's
    // success from the caller's POV — leave the winner's payload alone.
  }
  // Either way, drop our tmp file.
  try {
    unlinkSync(tmp);
  } catch {}
  return target;
}
