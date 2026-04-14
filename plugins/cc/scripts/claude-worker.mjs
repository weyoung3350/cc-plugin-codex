#!/usr/bin/env node
// Detached background worker for claude_task(background:true).
//
// Responsibilities:
//   1. Load job spec written by the broker.
//   2. Acquire the per-session lock (if session_id present).
//   3. Spawn `claude` as a process group leader (setsid via detached:true).
//   4. Stream Claude stdout to $STATE_DIR/jobs/<id>/output.log; periodically
//      patch state.json with output_bytes (no terminal-state writes from
//      this path).
//   5. On Claude exit: finalize state per the causal matrix.
//   6. Honour cancel_requested at safe checkpoints (before spawn, on each
//      lock-wait poll); during running state, claude_cancel from the broker
//      does the SIGTERM/SIGKILL — worker just observes child exit.
//
// Worker is launched via `node claude-worker.mjs <job_id>` from the broker
// using spawn(..., { detached: true, stdio: 'ignore' }).unref(). The worker
// itself inherits no fd from the broker.

import { spawn as realSpawn } from "node:child_process";

export const _internals = {
  spawn: realSpawn,
};
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { jobDir } from "./lib/xdg.mjs";
import { readLstart } from "./lib/pid-identity.mjs";
import {
  acquire as acquireSessionLock,
  release as releaseSessionLock,
  SessionLockError,
} from "./lib/session-lock.mjs";
import {
  finalizeJobIfNonTerminal,
  patchJobIfNonTerminal,
  readJobState,
} from "./lib/tracked-jobs.mjs";

const OUTPUT_PATCH_INTERVAL_MS = 1_000;
const CLAUDE_BIN = "claude";

/**
 * Worker entrypoint. Reads spec.json next to state.json (the broker
 * writes it on createJob), runs Claude, finalises the state.
 *
 * @param {string} job_id
 */
export async function runWorker(job_id) {
  if (!job_id || typeof job_id !== "string") {
    process.stderr.write("[claude-worker] missing job_id arg\n");
    process.exit(2);
  }
  const dir = jobDir(job_id);
  const specPath = path.join(dir, "spec.json");
  const outputLogPath = path.join(dir, "output.log");

  // The broker spawns us BEFORE writing spec.json/state.json (spawn-first
  // handoff): see claude-broker.mjs:launchBackgroundJob. We poll briefly
  // until both files appear. If they never do, the broker probably died
  // mid-handoff — finalize as spawn-failed (or, if state.json itself is
  // missing, just exit silently since there's nothing to report against).
  const SPEC_WAIT_DEADLINE_MS = 2_000;
  const SPEC_POLL_INTERVAL_MS = 25;
  /** @type {WorkerSpec | null} */
  let spec = null;
  const specStart = Date.now();
  while (Date.now() - specStart < SPEC_WAIT_DEADLINE_MS) {
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, SPEC_POLL_INTERVAL_MS));
    }
  }
  if (spec === null) {
    await tryFinalize(job_id, {
      state: "failed",
      error: "spawn-failed",
      ended_at_ms: Date.now(),
    });
    process.stderr.write(
      `[claude-worker ${job_id}] spec.json never appeared\n`,
    );
    process.exit(1);
  }

  // 1. Cancel-before-lock check.
  if (await checkCancelled(job_id)) return;

  // 2. Session lock if requested. Worker MUST hold this for the whole
  // Claude run so the broker's same-session ask/review/task get queued
  // behind this background job.
  let lock = null;
  if (typeof spec.session_id === "string" && spec.session_id.length > 0) {
    try {
      lock = await acquireWithCancelPolling(job_id, spec.session_id);
    } catch (err) {
      await finalizeForFailure(job_id, err);
      return;
    }
    if (lock === "cancelled") return; // cancel_requested observed during wait
  }

  try {
    // 3. Cancel-after-lock check (in case it flipped during wait).
    if (await checkCancelled(job_id)) return;

    // 4. Spawn Claude as a process-group leader so claude_cancel can later
    // signal the whole group via process.kill(-pid, 'SIGTERM').
    let outFd;
    try {
      outFd = openSync(outputLogPath, "a");
    } catch (err) {
      await finalizeForFailure(job_id, err);
      return;
    }

    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = _internals.spawn(CLAUDE_BIN, spec.argv, {
        cwd: spec.cwd,
        detached: true, // setsid → process group leader
        stdio: ["pipe", outFd, outFd],
        windowsHide: true,
      });
    } catch (err) {
      try { closeSync(outFd); } catch {}
      await tryFinalize(job_id, {
        state: "failed",
        error: "spawn-failed",
        ended_at_ms: Date.now(),
      });
      return;
    }

    // 5. Record running pid + lstart so claude_cancel can target the right
    // process group safely. If we can't read lstart, ABORT — an empty
    // lstart_raw would make claude_cancel's identity check return
    // pid-stale and leave the live Claude unkillable.
    const claudeLstart = readLstart(child.pid);
    if (claudeLstart === null || claudeLstart.length === 0) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
      try { closeSync(outFd); } catch {}
      await tryFinalize(job_id, {
        state: "failed",
        error: "spawn-failed",
        ended_at_ms: Date.now(),
      });
      return;
    }
    await patchJobIfNonTerminal(job_id, {
      state: "running",
      started_at_ms: Date.now(),
      claude_pid: child.pid,
      claude_lstart_raw: claudeLstart,
    });

    // 5b. Re-check cancel_requested AFTER state is "running". This closes
    // the race where claude_cancel saw state=queued (so it only set the
    // flag and didn't signal) while we were spawning.
    const postSpawnState = readJobState(job_id);
    if (postSpawnState && postSpawnState.cancel_requested) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch {}
      }
      // The exit handler below will then finalize state=cancelled.
    }

    // 6. Feed prompt via stdin (broker put it in spec).
    try {
      if (typeof spec.prompt === "string") child.stdin.write(spec.prompt);
      child.stdin.end();
    } catch {}

    // 7. Periodically patch output_bytes from the log file size.
    let outputBytes = 0;
    const ticker = setInterval(() => {
      const cur = currentLogSize(outputLogPath);
      if (cur !== outputBytes) {
        outputBytes = cur;
        // Best-effort; ignore I/O errors.
        patchJobIfNonTerminal(job_id, { output_bytes: cur }).catch(() => {});
      }
    }, OUTPUT_PATCH_INTERVAL_MS);
    if (typeof ticker.unref === "function") ticker.unref();

    // 8. Wait for child exit; finalise per causal matrix.
    await new Promise((resolve) => {
      child.on("exit", async (code, signal) => {
        try {
          clearInterval(ticker);
          try { closeSync(outFd); } catch {}
          const finalBytes = currentLogSize(outputLogPath);
          if (finalBytes !== outputBytes) {
            await patchJobIfNonTerminal(job_id, {
              output_bytes: finalBytes,
            }).catch(() => {});
          }

          const ended_at_ms = Date.now();
          const cancelRequested =
            (readJobState(job_id) ?? { cancel_requested: false })
              .cancel_requested;

          // Causal matrix (DESIGN.md):
          //   normal exit code 0  → succeeded
          //   non-zero exit       → failed / non-zero-exit
          //   killed by signal:
          //     - cancel_requested → cancelled (signal recorded)
          //     - else             → failed / killed (signal recorded)
          let finState, errCode;
          if (signal !== null) {
            finState = cancelRequested ? "cancelled" : "failed";
            errCode = cancelRequested ? null : "killed";
          } else if (typeof code === "number" && code === 0) {
            finState = "succeeded";
            errCode = null;
          } else {
            finState = "failed";
            errCode = "non-zero-exit";
          }
          await tryFinalize(job_id, {
            state: finState,
            exit_code: signal !== null ? null : code,
            exit_signal: signal,
            error: errCode,
            ended_at_ms,
          });
        } finally {
          // Always resolve — a finalise exception must not hang the worker.
          resolve();
        }
      });
      child.on("error", async (err) => {
        try {
          clearInterval(ticker);
          try { closeSync(outFd); } catch {}
          await finalizeForFailure(job_id, err);
        } finally {
          resolve();
        }
      });
    });
  } finally {
    if (lock) releaseSessionLock(lock);
  }
}

/**
 * Acquire the session lock while continuing to honour cancel_requested
 * checks every poll. Returns the lock handle on success, the literal
 * string "cancelled" if cancel_requested flipped during the wait.
 *
 * @param {string} job_id
 * @param {string} session_id
 * @returns {Promise<any|"cancelled">}
 */
async function acquireWithCancelPolling(job_id, session_id) {
  // session-lock has its own internal backoff; we wrap it with a thin
  // outer loop that checks cancel_requested every iteration.
  const SLICE_MS = 250;
  while (true) {
    if (await checkCancelled(job_id)) return "cancelled";
    try {
      return await acquireSessionLock(session_id, {
        timeoutMs: SLICE_MS,
        requestId: `worker-${job_id}`,
      });
    } catch (err) {
      if (err instanceof SessionLockError && err.reason === "timeout") {
        // Just slice; loop and re-check cancel.
        continue;
      }
      throw err;
    }
  }
}

/**
 * Read state.json; if cancel_requested and we're still pre-spawn, finalise
 * to "cancelled" (claude_pid stays null per the matrix). Returns true if
 * we've finalised and the worker should exit.
 *
 * @param {string} job_id
 * @returns {Promise<boolean>}
 */
async function checkCancelled(job_id) {
  const cur = readJobState(job_id);
  if (!cur) {
    // Missing/corrupt state.json — escalate so an operator can spot it.
    process.stderr.write(
      `[claude-worker ${job_id}] state.json missing or corrupt; aborting\n`,
    );
    return true;
  }
  if (cur.cancel_requested && cur.state === "queued") {
    await finalizeJobIfNonTerminal(job_id, {
      state: "cancelled",
      ended_at_ms: Date.now(),
    });
    return true;
  }
  return false;
}

async function finalizeForFailure(job_id, err) {
  const code =
    err instanceof SessionLockError && err.reason === "lstart-unreadable"
      ? "spawn-failed"
      : err && err.code
      ? "spawn-failed"
      : "spawn-failed";
  await tryFinalize(job_id, {
    state: "failed",
    error: code,
    ended_at_ms: Date.now(),
  });
}

async function tryFinalize(job_id, fin) {
  try {
    await finalizeJobIfNonTerminal(job_id, fin);
  } catch (err) {
    process.stderr.write(
      `[claude-worker ${job_id}] finalize failed: ${String(err)}\n`,
    );
  }
}

function currentLogSize(p) {
  try {
    // Use stat — full readFileSync would be O(n) per tick and quadratic
    // over the lifetime of a long log.
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * @typedef {object} WorkerSpec
 * @property {string[]} argv         Args after the "claude" binary.
 * @property {string} prompt
 * @property {string} cwd
 * @property {string|null} session_id
 */

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith("claude-worker.mjs")) {
  runWorker(process.argv[2]).then(() => process.exit(0));
}
