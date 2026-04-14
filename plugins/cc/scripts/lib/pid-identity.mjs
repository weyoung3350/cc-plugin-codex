// PID identity: guard against PID reuse across process boundaries.
//
// Contract (from docs/DESIGN.md):
//   - We identify a process by the pair { pid, lstart_raw }, where
//     lstart_raw is the verbatim string returned by
//       `ps -o lstart= -p <pid>` under LC_ALL=C.
//   - We NEVER parse lstart_raw into a timestamp. Locale/timezone parsing is
//     brittle; byte-for-byte string equality is enough to detect PID reuse
//     because `lstart` changes on every new process.
//
// All code paths that signal an external PID (SIGTERM/SIGKILL), stale-lock
// reclaim, or orphan-job sweeping MUST gate on sameIdentity() before acting.
// POSIX-only. Darwin + Linux.

import { spawnSync as realSpawnSync } from "node:child_process";

const PS_TIMEOUT_MS = 2000;

// Overridable for tests. Do NOT reach into these from production code.
export const _internals = {
  spawnSync: realSpawnSync,
  kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * Read the process start time string for `pid`, or null if the process does
 * not exist / cannot be inspected.
 *
 * Uses `ps -o lstart= -p <pid>` under LC_ALL=C. Returns the stdout with only
 * the trailing newline / whitespace stripped (trimEnd). Leading whitespace
 * is preserved so sameIdentity() compares ps output byte-for-byte on both
 * calls — anything else would risk false "same" matches if ps starts emitting
 * different leading padding.
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function readLstart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  let res;
  try {
    res = _internals.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return null;
  }

  if (!res || res.error) return null;
  // ps exits non-zero when pid not found. Never force-kill anything based
  // on ambiguous output — treat any non-success as "unknown / gone".
  if (res.status !== 0) return null;
  if (typeof res.stdout !== "string") return null;

  const line = res.stdout.replace(/[\r\n]+$/, "").trimEnd();
  return line.length === 0 ? null : line;
}

/**
 * True iff the process at `pid` currently has the given `lstart_raw`.
 * False if pid no longer exists or if lstart has changed (PID reuse).
 *
 * This function is the single gate used by signal/kill/reclaim paths.
 *
 * @param {number} pid
 * @param {string} lstart_raw  Verbatim string previously captured via readLstart().
 * @returns {boolean}
 */
export function sameIdentity(pid, lstart_raw) {
  if (typeof lstart_raw !== "string" || lstart_raw.length === 0) return false;
  const current = readLstart(pid);
  if (current === null) return false;
  return current === lstart_raw;
}

/**
 * True iff the PID is alive according to kill(pid, 0).
 * Note: this is NOT sufficient for signal safety; always pair with
 * sameIdentity() to defend against PID reuse.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    _internals.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process.  EPERM = exists but owned by another user.
    // We treat EPERM as "alive but not ours" — still exists, so true.
    if (err && err.code === "ESRCH") return false;
    if (err && err.code === "EPERM") return true;
    return false;
  }
}
