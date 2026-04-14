// Background-job state persistence with per-job mutex.
//
// Contract (docs/DESIGN.md "tracked-jobs"):
//
//   $STATE_DIR/jobs/<job_id>/
//     state.json     ← canonical job record (writes go via the four helpers)
//     output.log     ← worker-appended Claude output (worker writes; readers
//                      use claude_job_get's pagination — never touched here)
//     .write.lock/   ← per-job mutex used by the four writers below
//     pid            ← optional convenience file for ops; helpers use state.json
//
// Why per-job mutex AND tmp+rename:
//   - tmp+rename gives single-write atomicity (readers never see torn JSON)
//   - mutex gives RMW serialisability (no lost updates between writers)
//   Without the mutex, two RMWs that both read state="running" would each
//   write back a successor; the loser would silently overwrite the winner's
//   terminal state.
//
// Terminal-state hard rule (DESIGN.md "终态硬规则"):
//   Once state ∈ {succeeded, failed, cancelled}, finalize/patch helpers
//   become no-ops: only output_bytes / ended_at_ms may be augmented (and
//   even those only via patchJobIfNonTerminal's no-op branch). requestCancel
//   is the only writer that may touch a terminal-state job (and it too is a
//   no-op there — see the helper).

import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { jobDir } from "./xdg.mjs";
import { readLstart, isAlive } from "./pid-identity.mjs";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const NON_TERMINAL_STATES = new Set(["queued", "running"]);
const ALLOWED_STATES = new Set([...NON_TERMINAL_STATES, ...TERMINAL_STATES]);
const ALLOWED_ERRORS = new Set([
  "non-zero-exit",
  "killed",
  "timeout",
  "spawn-failed",
  "orphaned",
]);
const POLL_BACKOFF_MS = [2, 10, 50, 250, 500];
const STALE_LSTART_RETRY_MS = 50;

/**
 * @typedef {object} JobState
 * @property {string} job_id
 * @property {"queued"|"running"|"succeeded"|"failed"|"cancelled"} state
 * @property {string|null} session_id
 * @property {boolean} session_persisted
 * @property {number} worker_pid
 * @property {string} worker_lstart_raw
 * @property {number|null} claude_pid
 * @property {string|null} claude_lstart_raw
 * @property {boolean} cancel_requested
 * @property {number} created_at_ms
 * @property {number|null} started_at_ms
 * @property {number|null} ended_at_ms
 * @property {number|null} exit_code
 * @property {string|null} exit_signal
 * @property {string|null} error
 * @property {number} output_bytes
 */

// ─── public API ──────────────────────────────────────────────────────────

/**
 * Create a brand-new job record in queued state. Fails with "duplicate-job"
 * if a directory at $STATE_DIR/jobs/<job_id> already exists.
 *
 * Note: this is the ONLY API allowed to write a job's state.json without
 * holding the mutex — there's nothing to race against on first create
 * because we mkdir(EXCL) the parent directory.
 *
 * @param {object} init
 * @param {string} init.job_id
 * @param {string|null} init.session_id
 * @param {boolean} init.session_persisted
 * @param {number} init.worker_pid
 * @param {string} init.worker_lstart_raw
 * @returns {string}  Path to the created state.json.
 */
export function createJob(init) {
  if (!init || typeof init.job_id !== "string" || init.job_id.length === 0) {
    throw new TrackedJobError("invalid-args", "createJob: job_id required");
  }
  if (!Number.isInteger(init.worker_pid) || init.worker_pid <= 0) {
    throw new TrackedJobError(
      "invalid-args",
      "createJob: worker_pid must be a positive integer",
    );
  }
  if (
    typeof init.worker_lstart_raw !== "string" ||
    init.worker_lstart_raw.length === 0
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "createJob: worker_lstart_raw must be a non-empty string",
    );
  }
  if (
    init.session_id !== null &&
    init.session_id !== undefined &&
    typeof init.session_id !== "string"
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "createJob: session_id must be string or null",
    );
  }
  if (typeof init.session_persisted !== "boolean") {
    throw new TrackedJobError(
      "invalid-args",
      "createJob: session_persisted must be boolean",
    );
  }
  const dir = jobDir(init.job_id);
  // Two-step mkdir with EEXIST→duplicate-job classification at every step.
  // Concurrent first-callers can both hit ENOENT on the leaf and race to
  // create the parent; whichever loses the leaf race must still be told
  // it's a duplicate, not given the raw OS error.
  const tryMkdirLeaf = () => {
    try {
      mkdirSync(dir, { recursive: false });
      return true;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        throw new TrackedJobError(
          "duplicate-job",
          `job ${init.job_id} already exists at ${dir}`,
        );
      }
      if (err && err.code === "ENOENT") {
        return false;
      }
      throw err;
    }
  };
  if (!tryMkdirLeaf()) {
    mkdirSync(path.dirname(dir), { recursive: true });
    tryMkdirLeaf();
  }
  const now = Date.now();
  /** @type {JobState} */
  const state = {
    job_id: init.job_id,
    state: "queued",
    session_id: init.session_id ?? null,
    session_persisted: !!init.session_persisted,
    worker_pid: init.worker_pid,
    worker_lstart_raw: init.worker_lstart_raw,
    claude_pid: null,
    claude_lstart_raw: null,
    cancel_requested: false,
    created_at_ms: now,
    started_at_ms: null,
    ended_at_ms: null,
    exit_code: null,
    exit_signal: null,
    error: null,
    output_bytes: 0,
  };
  atomicWriteJson(statePath(init.job_id), state);
  return statePath(init.job_id);
}

/**
 * Read a job's current state. Returns null if the job dir doesn't exist
 * or state.json is missing/corrupt.
 *
 * @param {string} job_id
 * @returns {JobState | null}
 */
export function readJobState(job_id) {
  return readState(statePath(job_id));
}

/**
 * Move a non-terminal job to a terminal state (succeeded/failed/cancelled),
 * recording exit_code, exit_signal, error, and ended_at_ms. No-op (returns
 * false) if the job is already terminal.
 *
 * @param {string} job_id
 * @param {object} fin
 * @param {"succeeded"|"failed"|"cancelled"} fin.state
 * @param {number|null=} fin.exit_code
 * @param {string|null=} fin.exit_signal
 * @param {string|null=} fin.error
 * @param {number} fin.ended_at_ms
 * @returns {Promise<boolean>}  true if we wrote the terminal state.
 */
export async function finalizeJobIfNonTerminal(job_id, fin) {
  if (!fin || !TERMINAL_STATES.has(fin.state)) {
    throw new TrackedJobError(
      "invalid-args",
      `finalizeJobIfNonTerminal: state must be terminal, got ${fin?.state}`,
    );
  }
  if (fin.error != null && !ALLOWED_ERRORS.has(fin.error)) {
    throw new TrackedJobError(
      "invalid-error",
      `unknown error code: ${fin.error}`,
    );
  }
  if (typeof fin.ended_at_ms !== "number") {
    throw new TrackedJobError("invalid-args", "ended_at_ms required");
  }
  // Causal-matrix invariants (DESIGN.md):
  //   - exit_code and exit_signal are mutually exclusive (a process can
  //     only exit one way at a time).
  //   - succeeded: exit_code === 0, exit_signal === null, error === null.
  //   - failed/cancelled may have either exit_code or exit_signal (or
  //     neither, e.g. queued cancel / lock-wait timeout / orphaned).
  const code = fin.exit_code ?? null;
  const sig = fin.exit_signal ?? null;
  if (code !== null && sig !== null) {
    throw new TrackedJobError(
      "invalid-args",
      "exit_code and exit_signal are mutually exclusive",
    );
  }
  if (code !== null && (!Number.isInteger(code) || code < 0)) {
    throw new TrackedJobError(
      "invalid-args",
      `exit_code must be a non-negative integer, got ${code}`,
    );
  }
  if (sig !== null && typeof sig !== "string") {
    throw new TrackedJobError("invalid-args", "exit_signal must be a string");
  }
  if (fin.state === "succeeded") {
    if (code !== 0 || sig !== null || (fin.error ?? null) !== null) {
      throw new TrackedJobError(
        "invalid-args",
        "succeeded requires exit_code=0, exit_signal=null, error=null",
      );
    }
  }
  return mutated(job_id, (cur) => {
    if (cur === null || TERMINAL_STATES.has(cur.state)) return null;
    return {
      ...cur,
      state: fin.state,
      exit_code: fin.exit_code ?? null,
      exit_signal: fin.exit_signal ?? null,
      error: fin.error ?? null,
      ended_at_ms: fin.ended_at_ms,
    };
  });
}

/**
 * Apply a partial patch to a non-terminal job. Used for queued→running
 * transitions (state=running, started_at_ms, claude_pid, claude_lstart_raw)
 * and for in-flight progress (output_bytes). Refuses to write if the
 * patch would set state to a terminal value (caller must use
 * finalizeJobIfNonTerminal).
 *
 * @param {string} job_id
 * @param {Partial<JobState>} patch
 * @returns {Promise<boolean>}  true if we wrote.
 */
// Whitelist of fields patchJobIfNonTerminal is allowed to write. Anything
// else (job_id, worker_pid, worker_lstart_raw, exit_code, exit_signal,
// error, etc.) is immutable from this path — finalize is the only writer
// for outcome fields.
const PATCHABLE_FIELDS = new Set([
  "state",
  "started_at_ms",
  "claude_pid",
  "claude_lstart_raw",
  "output_bytes",
]);

export async function patchJobIfNonTerminal(job_id, patch) {
  if (!patch || typeof patch !== "object") {
    throw new TrackedJobError(
      "invalid-args",
      "patchJobIfNonTerminal: patch object required",
    );
  }
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_FIELDS.has(key)) {
      throw new TrackedJobError(
        "invalid-args",
        `patchJobIfNonTerminal: field "${key}" is not patchable`,
      );
    }
  }
  if (patch.state && TERMINAL_STATES.has(patch.state)) {
    throw new TrackedJobError(
      "invalid-args",
      `patchJobIfNonTerminal cannot set terminal state ${patch.state}; use finalize`,
    );
  }
  if (patch.state && !NON_TERMINAL_STATES.has(patch.state)) {
    throw new TrackedJobError(
      "invalid-args",
      `unknown state: ${patch.state}`,
    );
  }
  // Per-field type validation. We catch type errors at the writer rather
  // than letting them propagate into corrupt state.json that readState
  // would later reject.
  if (
    patch.claude_pid !== undefined &&
    patch.claude_pid !== null &&
    (!Number.isInteger(patch.claude_pid) || patch.claude_pid <= 0)
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "patchJobIfNonTerminal: claude_pid must be a positive integer or null",
    );
  }
  if (
    patch.claude_lstart_raw !== undefined &&
    patch.claude_lstart_raw !== null &&
    typeof patch.claude_lstart_raw !== "string"
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "patchJobIfNonTerminal: claude_lstart_raw must be a string or null",
    );
  }
  if (
    patch.started_at_ms !== undefined &&
    patch.started_at_ms !== null &&
    !Number.isFinite(patch.started_at_ms)
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "patchJobIfNonTerminal: started_at_ms must be a finite number or null",
    );
  }
  if (
    patch.output_bytes !== undefined &&
    !Number.isFinite(patch.output_bytes)
  ) {
    throw new TrackedJobError(
      "invalid-args",
      "patchJobIfNonTerminal: output_bytes must be a finite number",
    );
  }
  return mutated(job_id, (cur) => {
    if (cur === null || TERMINAL_STATES.has(cur.state)) return null;
    const next = { ...cur, ...patch };
    // Cross-field invariant: queued → running requires
    // started_at_ms + claude_pid + claude_lstart_raw all set.
    if (
      cur.state === "queued" &&
      next.state === "running" &&
      (!Number.isFinite(next.started_at_ms) ||
        !Number.isInteger(next.claude_pid) ||
        next.claude_pid <= 0 ||
        typeof next.claude_lstart_raw !== "string" ||
        next.claude_lstart_raw.length === 0)
    ) {
      throw new TrackedJobError(
        "invalid-running-transition",
        "queued→running requires started_at_ms, claude_pid, claude_lstart_raw all set",
      );
    }
    return next;
  });
}

/**
 * Mark a job for cancellation. Sets cancel_requested=true; does NOT
 * itself transition the job. The worker checks this flag at safe points
 * and, if true, finalises the job to "cancelled" via finalizeJobIfNonTerminal.
 *
 * Terminal-state behaviour: returns false (no-op) — there's nothing to
 * cancel any more, and the broker will surface that as
 * { cancelled:false, reason:"already-done" }.
 *
 * @param {string} job_id
 * @returns {Promise<boolean>}
 */
export async function requestCancel(job_id) {
  return mutated(job_id, (cur) => {
    if (cur === null) return null;
    if (TERMINAL_STATES.has(cur.state)) return null;
    if (cur.cancel_requested) return null; // idempotent — no churn
    return { ...cur, cancel_requested: true };
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Run a read-modify-write under the per-job mutex. Returns true if the
 * mutator produced a new state and we wrote it; false otherwise (no-op).
 *
 * @param {string} job_id
 * @param {(cur: JobState | null) => JobState | null} mutator
 * @returns {Promise<boolean>}
 */
async function mutated(job_id, mutator) {
  const dir = jobDir(job_id);
  const lockDir = path.join(dir, ".write.lock");
  await acquireMutex(job_id, lockDir);
  try {
    const cur = readState(statePath(job_id));
    const next = mutator(cur);
    if (next === null) return false;
    atomicWriteJson(statePath(job_id), next);
    return true;
  } finally {
    releaseMutex(lockDir);
  }
}

async function acquireMutex(job_id, lockDir) {
  // The job dir itself must already exist (createJob is responsible for
  // that). If it doesn't, the writer is using a stale handle.
  if (!existsSync(path.dirname(lockDir))) {
    throw new TrackedJobError(
      "missing-job",
      `job ${job_id} has no on-disk dir`,
    );
  }
  // Snapshot our own identity ONCE up-front. Same reasoning as
  // session-lock: an empty/unread lstart would make every classifyOwner
  // false-positive into "different" once ps recovers, letting peers tear
  // down our live mutex.
  const ownLstart = readLstart(process.pid);
  if (ownLstart === null || ownLstart.length === 0) {
    throw new TrackedJobError(
      "lstart-unreadable",
      `cannot read own process start time (pid ${process.pid})`,
    );
  }

  let attempt = 0;
  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      // CRITICAL: install owner info IMMEDIATELY so peers in the
      // half-installed-second-chance path below can identify us.
      installMutexOwner(lockDir, process.pid, ownLstart);
      return;
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw new TrackedJobError(
          "io-error",
          `mkdir ${lockDir}: ${err.message}`,
        );
      }
    }
    // Lock held — see if the holder is still alive.
    const ownerInfo = readMutexOwner(lockDir);
    if (ownerInfo) {
      const cur = readLstart(ownerInfo.owner_pid);
      // Reclaim only on definitively-gone or definitively-different.
      // ps "unknown" (cur === null but pid alive) → do not reclaim.
      const ownerGone = !isAlive(ownerInfo.owner_pid);
      const ownerReused =
        !ownerGone && cur !== null && cur !== ownerInfo.owner_lstart_raw;
      if (ownerGone || ownerReused) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        continue;
      }
    } else {
      // Lock dir exists but no info: half-installed, give it a brief moment
      // before assuming orphaned. (Same defence as session-lock.)
      await sleep(STALE_LSTART_RETRY_MS);
      const second = readMutexOwner(lockDir);
      if (!second) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        continue;
      }
    }
    const wait = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
    await sleep(wait);
    attempt += 1;
  }
}

function installMutexOwner(lockDir, owner_pid, owner_lstart_raw) {
  atomicWriteJson(path.join(lockDir, "info.json"), {
    owner_pid,
    owner_lstart_raw,
    acquired_at_ms: Date.now(),
  });
}

function readMutexOwner(lockDir) {
  try {
    const raw = readFileSync(path.join(lockDir, "info.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Number.isInteger(parsed.owner_pid) &&
      typeof parsed.owner_lstart_raw === "string" &&
      parsed.owner_lstart_raw.length > 0
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function releaseMutex(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {}
}

// Lightweight private state path helpers ---------------------------------

function statePath(job_id) {
  return path.join(jobDir(job_id), "state.json");
}

function readState(p) {
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Strict shape check: any missing or wrong-typed field → null so
    // callers / RMWs treat the file as orphaned rather than continuing
    // to mutate corrupt state.
    if (typeof parsed.job_id !== "string" || parsed.job_id.length === 0) return null;
    if (!ALLOWED_STATES.has(parsed.state)) return null;
    if (
      parsed.session_id !== null &&
      typeof parsed.session_id !== "string"
    ) return null;
    if (typeof parsed.session_persisted !== "boolean") return null;
    if (!Number.isInteger(parsed.worker_pid) || parsed.worker_pid <= 0) return null;
    if (
      typeof parsed.worker_lstart_raw !== "string" ||
      parsed.worker_lstart_raw.length === 0
    )
      return null;
    if (
      parsed.claude_pid !== null &&
      (!Number.isInteger(parsed.claude_pid) || parsed.claude_pid <= 0)
    )
      return null;
    if (
      parsed.claude_lstart_raw !== null &&
      typeof parsed.claude_lstart_raw !== "string"
    )
      return null;
    if (typeof parsed.cancel_requested !== "boolean") return null;
    if (!Number.isFinite(parsed.created_at_ms)) return null;
    if (parsed.started_at_ms !== null && !Number.isFinite(parsed.started_at_ms))
      return null;
    if (parsed.ended_at_ms !== null && !Number.isFinite(parsed.ended_at_ms))
      return null;
    if (parsed.exit_code !== null && !Number.isInteger(parsed.exit_code))
      return null;
    if (parsed.exit_signal !== null && typeof parsed.exit_signal !== "string")
      return null;
    if (parsed.error !== null && typeof parsed.error !== "string") return null;
    if (!Number.isFinite(parsed.output_bytes)) return null;
    // Cross-field invariants per state. A "running" record without
    // claude_pid / lstart / started_at is by definition corrupt because
    // the worker only enters running after writing those.
    if (parsed.state === "running") {
      if (
        !Number.isInteger(parsed.claude_pid) ||
        parsed.claude_pid <= 0 ||
        typeof parsed.claude_lstart_raw !== "string" ||
        parsed.claude_lstart_raw.length === 0 ||
        !Number.isFinite(parsed.started_at_ms)
      ) {
        return null;
      }
    }
    if (
      parsed.state === "succeeded" ||
      parsed.state === "failed" ||
      parsed.state === "cancelled"
    ) {
      if (!Number.isFinite(parsed.ended_at_ms)) return null;
    }
    return /** @type {JobState} */ (parsed);
  } catch {
    return null;
  }
}

function atomicWriteJson(target, obj) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8" });
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

export class TrackedJobError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = "TrackedJobError";
    this.reason = reason;
  }
}
