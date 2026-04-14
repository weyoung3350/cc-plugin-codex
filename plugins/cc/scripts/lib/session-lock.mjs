// Per-session userspace lock — pure Node, no native deps.
//
// Contract (docs/DESIGN.md "concurrency model"):
//   - Lock body: directory $STATE_DIR/sessions/<session_id>.lock/.
//     Created via fs.mkdir(path, { recursive: false }); EEXIST = held.
//   - Lock content: info.json (atomic tmp+rename) holding
//       { owner_pid, owner_lstart_raw, acquired_at_ms, request_id, heartbeat_at_ms }
//   - Heartbeat: every 5 s the holder updates heartbeat_at_ms (tmp+rename).
//   - Stale reclaim — STRICT TWO-FACTOR. We only force-release when:
//       1. kill(owner_pid, 0) returns ESRCH (process gone), OR
//       2. process exists but `ps -o lstart=` doesn't match (pid reuse).
//     Heartbeat staleness is diagnostic only — sleep / SIGSTOP / GC must
//     never trigger reclaim, otherwise live work would race.
//   - Wait policy: caller-supplied timeout. Polling backs off 10ms → 50ms →
//     250ms → 1s, capped at 2 s.
//   - Release: holder removes the directory; abnormal exit relies on the
//     stale-reclaim path above.
//
// Concurrency model on a single host:
//   - Same session_id: serialised across processes.
//   - Different session_ids: independent (no global lock).

import { mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

import { sessionLockPath } from "./xdg.mjs";
import { readLstart, isAlive } from "./pid-identity.mjs";

// Tri-state identity check used by reclaim. We must distinguish:
//   "same"      → owner pid alive, lstart matches → DO NOT reclaim
//   "different" → owner pid alive but lstart differs → pid reuse, RECLAIM
//   "gone"      → owner pid no longer exists → RECLAIM
//   "unknown"   → cannot read lstart (ps failed/timed out) and pid still
//                 alive → DO NOT reclaim (fail safe; better to wait)
//
// Conflating "different" and "unknown" — as a binary sameIdentity() check
// would — would let a single ps hiccup tear down a live lock.
function classifyOwner(pid, expectedLstart) {
  if (!isAlive(pid)) return "gone";
  const current = readLstart(pid);
  if (current === null) return "unknown";
  return current === expectedLstart ? "same" : "different";
}

const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_BACKOFF_MS = [10, 50, 250, 1000, 2000];

/**
 * @typedef {object} LockHandle
 * @property {string} session_id
 * @property {string} lockDir
 * @property {NodeJS.Timeout | null} heartbeat
 * @property {boolean} released
 * @property {number} expected_owner_pid
 * @property {string} expected_owner_lstart_raw
 */

/**
 * @typedef {object} LockInfo
 * @property {number} owner_pid
 * @property {string} owner_lstart_raw
 * @property {number} acquired_at_ms
 * @property {string} request_id
 * @property {number} heartbeat_at_ms
 */

/**
 * Acquire the session lock, blocking until success or timeout.
 *
 * @param {string} session_id  UUID-ish (validated downstream by xdg).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  Default Infinity. 0 = single attempt only.
 * @param {string} [opts.requestId]  Identifier carried in info.json for ops/diagnostics.
 * @returns {Promise<LockHandle>}    Throws SessionLockError on timeout / fatal IO.
 */
export async function acquire(session_id, opts = {}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : Infinity;
  const requestId =
    typeof opts.requestId === "string" ? opts.requestId : "anonymous";

  const lockDir = sessionLockPath(session_id);
  const start = Date.now();

  // Snapshot our own lstart ONCE up-front. If we can't read it, we can't
  // safely take the lock at all (a missing lstart would race against the
  // identity check on every reclaim attempt).
  const ownerLstartRaw = readLstart(process.pid);
  if (ownerLstartRaw === null || ownerLstartRaw.length === 0) {
    throw new SessionLockError(
      "lstart-unreadable",
      `cannot read process start time for self (pid ${process.pid}); aborting acquire`,
    );
  }

  let attempt = 0;
  while (true) {
    // Re-create the sessions/ parent each iteration: an external janitor
    // could remove it between iterations, and an mkdir-EEXIST is cheap.
    try {
      mkdirSync(path.dirname(lockDir), { recursive: true });
    } catch (err) {
      throw new SessionLockError(
        "io-error",
        `failed to create sessions parent dir: ${err.message}`,
      );
    }

    if (tryCreate(lockDir)) {
      // CRITICAL: write info.json IMMEDIATELY after mkdir so concurrent
      // acquirers never see "dir exists but info missing" and treat us
      // as orphan. Both readLstart and any other side-effects must run
      // BEFORE mkdir.
      const handle = installInfo(session_id, lockDir, requestId, ownerLstartRaw);
      handle.heartbeat = setInterval(() => {
        if (handle.released) return;
        try {
          patchInfo(handle.lockDir, { heartbeat_at_ms: Date.now() });
        } catch {
          // Best-effort; heartbeat is diagnostic only.
        }
      }, HEARTBEAT_INTERVAL_MS);
      // Don't keep the event loop alive just for heartbeat.
      if (typeof handle.heartbeat.unref === "function") {
        handle.heartbeat.unref();
      }
      return handle;
    }

    // Lock taken. Inspect it; if owner is dead/replaced/corrupt, reclaim.
    if (await tryReclaim(lockDir)) {
      // Loop immediately: another process may sneak in between rmdir and
      // our next mkdir, but we still get a fast retry without a sleep.
      continue;
    }

    if (timeoutMs === 0) {
      throw new SessionLockError(
        "would-block",
        `lock for session ${session_id} is held`,
      );
    }
    if (Date.now() - start >= timeoutMs) {
      throw new SessionLockError(
        "timeout",
        `timed out after ${timeoutMs}ms waiting for session ${session_id} lock`,
      );
    }

    const wait = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
    await sleep(Math.min(wait, Math.max(1, timeoutMs - (Date.now() - start))));
    attempt += 1;
  }
}

/**
 * Release a previously-acquired lock. Idempotent.
 *
 * Verifies that the on-disk info.json still matches the handle's owner
 * snapshot before deleting; otherwise the dir was already reclaimed and
 * possibly reacquired by someone else, and we must NOT delete it.
 *
 * @param {LockHandle} handle
 */
export function release(handle) {
  if (!handle || handle.released) return;
  handle.released = true;
  if (handle.heartbeat) {
    clearInterval(handle.heartbeat);
    handle.heartbeat = null;
  }
  const info = readInfo(handle.lockDir);
  if (
    info &&
    (info.owner_pid !== handle.expected_owner_pid ||
      info.owner_lstart_raw !== handle.expected_owner_lstart_raw)
  ) {
    // Lock no longer ours — leave it alone.
    return;
  }
  try {
    rmSync(handle.lockDir, { recursive: true, force: true });
  } catch {
    // Lock dir already gone (e.g. external janitor) — fine.
  }
}

/**
 * Read the info.json of a held lock — useful for tests / diagnostics.
 * Returns null if the lock dir or info.json is gone / corrupt.
 * @param {string} session_id
 * @returns {LockInfo | null}
 */
export function inspect(session_id) {
  const lockDir = sessionLockPath(session_id);
  return readInfo(lockDir);
}

// --- internals ---

function tryCreate(lockDir) {
  try {
    mkdirSync(lockDir, { recursive: false });
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw new SessionLockError(
      "io-error",
      `mkdir ${lockDir} failed: ${err.message}`,
    );
  }
}

/**
 * Inspect the existing lock and try to remove it if its owner is dead,
 * its pid has been recycled, or its info.json is corrupt. Returns true
 * on successful reclaim.
 *
 * Heartbeat staleness is intentionally NOT a reclaim trigger — only true
 * absence, confirmed pid reuse, or corruption qualifies. A transient ps
 * failure (classify → "unknown") leaves the lock untouched. See DESIGN.md.
 */
async function tryReclaim(lockDir) {
  const info = readInfo(lockDir);
  if (!info) {
    // Lock dir exists but info.json missing/incomplete/corrupt. This can
    // legitimately happen during the brief window between another
    // acquire's mkdir() and its info.json write. Re-read after a short
    // delay to avoid evicting a live, mid-install holder.
    await sleep(100);
    const second = readInfo(lockDir);
    if (!second) {
      return forceRemove(lockDir);
    }
    return reclaimByClassification(second.owner_pid, second.owner_lstart_raw, lockDir);
  }
  return reclaimByClassification(info.owner_pid, info.owner_lstart_raw, lockDir);
}

function reclaimByClassification(pid, lstart, lockDir) {
  switch (classifyOwner(pid, lstart)) {
    case "gone":
    case "different":
      return forceRemove(lockDir);
    case "same":
    case "unknown":
    default:
      return false;
  }
}

function forceRemove(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function installInfo(session_id, lockDir, requestId, owner_lstart_raw) {
  // owner_lstart_raw is read once by acquire() before mkdir, so we don't
  // re-read here — keeps mkdir → write window minimal.
  const owner_pid = process.pid;
  const now = Date.now();
  const info = {
    owner_pid,
    owner_lstart_raw,
    acquired_at_ms: now,
    request_id: requestId,
    heartbeat_at_ms: now,
  };
  try {
    atomicWriteJson(path.join(lockDir, "info.json"), info);
  } catch (err) {
    // Don't leave a half-formed lock behind for other holders to inherit.
    forceRemove(lockDir);
    throw new SessionLockError(
      "io-error",
      `failed to write info.json: ${err.message}`,
    );
  }
  return {
    session_id,
    lockDir,
    heartbeat: null,
    released: false,
    // Snapshot for ownership verification on release.
    expected_owner_pid: owner_pid,
    expected_owner_lstart_raw: owner_lstart_raw,
  };
}

function readInfo(lockDir) {
  try {
    const raw = readFileSync(path.join(lockDir, "info.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Strict shape check: any missing/wrong field → treat as corrupt so
    // tryReclaim() can take over.
    if (!Number.isInteger(parsed.owner_pid) || parsed.owner_pid <= 0) return null;
    if (typeof parsed.owner_lstart_raw !== "string" || parsed.owner_lstart_raw.length === 0)
      return null;
    if (!Number.isFinite(parsed.acquired_at_ms)) return null;
    if (typeof parsed.request_id !== "string") return null;
    if (!Number.isFinite(parsed.heartbeat_at_ms)) return null;
    return /** @type {LockInfo} */ (parsed);
  } catch {
    return null;
  }
}

function patchInfo(lockDir, patch) {
  const info = readInfo(lockDir);
  if (!info) return;
  const updated = { ...info, ...patch };
  atomicWriteJson(path.join(lockDir, "info.json"), updated);
}

function atomicWriteJson(target, obj) {
  // tmp + rename → atomic on POSIX. Tmp lives next to target so rename
  // stays in the same filesystem.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8" });
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class SessionLockError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = "SessionLockError";
    this.reason = reason;
  }
}
