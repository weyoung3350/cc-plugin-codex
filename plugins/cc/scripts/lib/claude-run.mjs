// Synchronous-style execution of a single `claude -p ...` invocation.
//
// Responsibilities (docs/DESIGN.md "claude-run.mjs"):
//   - Spawn claude with the prepared argv + prompt (stdin or argv tail).
//   - Enforce a run-phase timeout that fires SIGTERM on Claude, then a
//     fixed 10 s grace before SIGKILL. Lock-wait time is caller-tracked.
//   - Capture stdout/stderr by bytes; truncate stdout at 10 MB (configurable).
//     Truncation is reported but NEVER silent.
//   - Implement the session fallback protocol: if caller asked for --resume
//     and Claude exits telling us the session does not exist, retry ONCE in
//     the same call with --session-id <uuid>. The retry does not re-acquire
//     any external lock; caller is responsible for that.
//   - Normalise return shape for both synchronous tools (ask/review) and
//     later for background workers.
//
// We keep this module transport-agnostic: it does not know about MCP,
// session locks, or tracked jobs. Those compose around it.

import { spawn as realSpawn } from "node:child_process";
import { Buffer } from "node:buffer";

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_TIMEOUT_MS = 300_000; // 300 s sync tool budget
const DEFAULT_GRACE_MS = 10_000; // SIGTERM → SIGKILL grace (not counted in timeout)
const DEFAULT_STDOUT_CAP = 10 * 1024 * 1024; // 10 MB byte cap

export const _internals = {
  spawn: realSpawn,
};

/**
 * @typedef {object} RunResult
 * @property {string} text                   Captured stdout decoded UTF-8 (possibly truncated).
 * @property {boolean} truncated             True when stdout exceeded maxOutputBytes.
 * @property {number} captured_bytes         Bytes actually retained in `text` (≤ maxOutputBytes).
 * @property {number} total_bytes            Bytes Claude emitted on stdout in total.
 * @property {number} duration_ms            Wall-clock duration including kill-grace.
 * @property {number | null} exit_code       null when Claude was killed by signal.
 * @property {string | null} exit_signal     e.g. "SIGTERM"; null on normal exit.
 * @property {string} stderr                 stderr tail (≤ 64 KB).
 * @property {boolean} resume_retried        true when we fell back to --session-id.
 * @property {"timeout" | "nonzero" | null} error  Set when text isn't trustworthy.
 */

/**
 * Session-not-found stderr patterns from Claude CLI. We match on stderr
 * text because Claude exits with plain status 1 and relies on stderr to
 * disambiguate. If Claude changes this string we'll fall through to a
 * regular `nonzero` error — safe-fail, not over-eager retry.
 */
// stderr patterns Claude CLI emits when --resume is given a session it
// hasn't seen before. Verified empirically against Claude 2.1.107:
//   "No conversation found with session ID: <uuid>"
// We keep older patterns too because Claude has changed this string at
// least twice; broad coverage here is the difference between "session
// auto-create works" and "session_id is unusable for new sessions".
const SESSION_NOT_FOUND_PATTERNS = [
  /no conversation found/i,
  /no such session/i,
  /session not found/i,
  /could not find session/i,
  /session .* does not exist/i,
  /no session with id/i,
  /unknown session id/i,
];

/**
 * Replace the --resume <uuid> pair in an argv with --session-id <uuid>.
 * Returns a new array; the input is not mutated.
 * @param {string[]} flags
 * @returns {string[] | null}  null when no --resume present.
 */
function rewriteResumeToSessionId(flags) {
  const idx = flags.indexOf("--resume");
  if (idx < 0 || idx + 1 >= flags.length) return null;
  const out = flags.slice();
  out.splice(idx, 2, "--session-id", flags[idx + 1]);
  return out;
}

/**
 * Run `claude` with the supplied flags and prompt.
 *
 * @param {object} opts
 * @param {string[]} opts.flags                Argv tail AFTER "claude".
 * @param {string} opts.prompt                 Prompt text; passed via stdin.
 * @param {string=} opts.cwd                   Working dir for the child.
 * @param {number=} opts.timeoutMs             Run-phase budget. Default 300 s.
 * @param {number=} opts.graceMs               SIGTERM → SIGKILL wait. Default 10 s.
 * @param {number=} opts.maxOutputBytes        Stdout byte cap. Default 10 MB.
 * @param {string=} opts.claudeBin             Default "claude".
 * @param {boolean=} opts.resumeFallback       Default true. Set false to
 *                                             skip the --resume → --session-id
 *                                             retry.
 * @returns {Promise<RunResult>}
 */
export async function runClaude(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("runClaude: opts required");
  }
  const firstFlags = Array.isArray(opts.flags) ? opts.flags.slice() : [];
  const resumeFallback = opts.resumeFallback !== false;

  let first = await runOnce({ ...opts, flags: firstFlags });

  // Retry path: only if caller allowed fallback, only if first invocation
  // used --resume AND failed with a session-not-found stderr.
  if (
    resumeFallback &&
    first.error === "nonzero" &&
    firstFlags.includes("--resume") &&
    SESSION_NOT_FOUND_PATTERNS.some((re) => re.test(first.stderr))
  ) {
    const retryFlags = rewriteResumeToSessionId(firstFlags);
    if (retryFlags) {
      const second = await runOnce({ ...opts, flags: retryFlags });
      second.resume_retried = true;
      // Preserve the aggregate duration so callers can time-budget correctly.
      second.duration_ms += first.duration_ms;
      return second;
    }
  }

  return first;
}

/**
 * One shot. Internal — callers should prefer runClaude().
 * @returns {Promise<RunResult>}
 */
function runOnce({
  flags,
  prompt,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  maxOutputBytes = DEFAULT_STDOUT_CAP,
  claudeBin = DEFAULT_CLAUDE_BIN,
}) {
  return new Promise((resolve) => {
    const start = Date.now();

    /** @type {import("node:child_process").ChildProcess} */
    const child = _internals.spawn(claudeBin, flags, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    let capturedBytes = 0;
    let totalBytes = 0;
    let truncated = false;

    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stderrBytes = 0;
    const stderrCap = 64 * 1024;

    // Stream path is byte-level only; UTF-8 boundary fixup happens once at
    // close() so it naturally handles multi-byte chars split across chunks.
    child.stdout.on("data", (chunk) => {
      /** @type {Buffer} */
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (truncated) return;
      const room = maxOutputBytes - capturedBytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (buf.byteLength <= room) {
        stdoutChunks.push(buf);
        capturedBytes += buf.byteLength;
      } else {
        stdoutChunks.push(buf.subarray(0, room));
        capturedBytes += room;
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      /** @type {Buffer} */
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      if (stderrBytes >= stderrCap) return;
      const room = stderrCap - stderrBytes;
      if (buf.byteLength <= room) {
        stderrChunks.push(buf);
        stderrBytes += buf.byteLength;
      } else {
        stderrChunks.push(buf.subarray(0, room));
        stderrBytes += room;
      }
    });

    let timedOut = false;
    let killedDuringGrace = false;

    const runTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      graceTimer = setTimeout(() => {
        killedDuringGrace = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, graceMs);
    }, timeoutMs);

    let graceTimer = /** @type {NodeJS.Timeout | null} */ (null);

    const onError = (err) => {
      // Spawn failed (e.g. claude binary missing). Emit a nonzero result
      // with an informative stderr stub.
      if (runTimer) clearTimeout(runTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        text: "",
        truncated: false,
        captured_bytes: 0,
        total_bytes: 0,
        duration_ms: Date.now() - start,
        exit_code: null,
        exit_signal: null,
        stderr: `spawn error: ${err && err.code ? err.code : String(err)}`,
        resume_retried: false,
        error: "nonzero",
      });
    };
    child.on("error", onError);

    child.on("close", (code, signal) => {
      if (runTimer) clearTimeout(runTimer);
      if (graceTimer) clearTimeout(graceTimer);

      // Concatenate, then — if truncation kicked in — walk back the tail to
      // the last valid UTF-8 character boundary so `text` decodes cleanly
      // and `captured_bytes === Buffer.byteLength(text, 'utf8')`. We only
      // do this on truncation because a normal exit never splits a
      // character across the cap.
      let fullBuf = Buffer.concat(stdoutChunks);
      if (truncated && fullBuf.length > 0) {
        let cut = fullBuf.length;
        // Walk back over any trailing continuation bytes (10xxxxxx). After
        // this, byte at cut-1 is either ASCII or a lead byte.
        while (cut > 0 && (fullBuf[cut - 1] & 0xc0) === 0x80) cut -= 1;
        // If the remaining tail is a multi-byte lead with fewer than the
        // required number of following continuations inside [0, cut), the
        // character is incomplete — drop it. Because step 1 just stripped
        // every continuation at the tail, any multi-byte lead at cut-1 is
        // by definition followed by zero continuations inside [0, cut), so
        // it's always incomplete and must be dropped.
        if (cut > 0) {
          const lead = fullBuf[cut - 1];
          if ((lead & 0x80) !== 0) {
            cut -= 1;
          }
        }
        if (cut !== fullBuf.length) {
          fullBuf = fullBuf.subarray(0, cut);
          capturedBytes = cut;
        }
      }

      const text = fullBuf.toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      // Result classification:
      //   - timed out → error="timeout"
      //   - signaled (not by us) → error="nonzero"
      //   - exit code 0 → error=null
      //   - exit code non-zero → error="nonzero"
      let error = /** @type {"timeout" | "nonzero" | null} */ (null);
      if (timedOut) {
        error = "timeout";
      } else if (typeof code === "number" && code !== 0) {
        error = "nonzero";
      } else if (signal !== null && !killedDuringGrace) {
        error = "nonzero";
      }

      resolve({
        text,
        truncated,
        captured_bytes: capturedBytes,
        total_bytes: totalBytes,
        duration_ms: Date.now() - start,
        exit_code: typeof code === "number" ? code : null,
        exit_signal: typeof signal === "string" ? signal : null,
        stderr,
        resume_retried: false,
        error,
      });
    });

    // Feed the prompt on stdin; many flags already include "-p" but Claude
    // still reads the prompt body from stdin when "-" or when no argv prompt
    // is supplied. Writing then end() is robust across both styles.
    try {
      if (typeof prompt === "string") {
        child.stdin.write(prompt);
      }
      child.stdin.end();
    } catch {
      // If stdin closed early (child died), the close handler will settle.
    }
  });
}

/**
 * Parse Claude's `--output-format=json` envelope. Returns the `result`
 * field (Claude's final message text) when present, plus any cost/session
 * metadata. Callers pass `runResult.text`.
 *
 * @param {string} rawJsonText
 * @returns {{ result: string | null, session_id: string | null, total_cost_usd: number | null, parsed: any | null }}
 */
export function parseClaudeJson(rawJsonText) {
  try {
    const parsed = JSON.parse(rawJsonText);
    const result = typeof parsed?.result === "string" ? parsed.result : null;
    const session_id =
      typeof parsed?.session_id === "string" ? parsed.session_id : null;
    const total_cost_usd =
      typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    return { result, session_id, total_cost_usd, parsed };
  } catch {
    return { result: null, session_id: null, total_cost_usd: null, parsed: null };
  }
}
