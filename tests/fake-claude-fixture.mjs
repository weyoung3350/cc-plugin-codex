#!/usr/bin/env node
// Test fixture pretending to be the `claude` CLI.
//
// Used by integration tests that want to exercise the real spawn path
// (claude-broker → claude-run → child process) without needing a working
// Claude install. The fixture is invoked the same way the real binary
// would be (positional + named flags), reads its prompt from stdin, and
// emits a Claude-shaped JSON envelope on stdout.
//
// Behaviour is selected via the prompt:
//   "fake:succeed:<text>"          → succeeded with "<text>" as result
//   "fake:fail:<message>"          → exit 1 with stderr=<message>
//   "fake:hang:<ms>"               → sleep <ms> then succeed
//   "fake:session-resume-hit"      → succeeded (echoes session_id)
//   "fake:session-resume-miss"     → exit 1 + stderr "No conversation found ..."
//                                    (when called with --resume; fallback
//                                     to --session-id should succeed)
//   "fake:session-resume-fail"     → exit 1 + stderr "No conversation found ..."
//                                    on every call (so even fallback fails)
//   "fake:review-valid"            → emit a schema-valid review JSON
//   "fake:review-invalid-verdict"  → emit JSON with verdict="maybe"
//   anything else                  → succeeded with the prompt echoed
//
// `--json-schema` is recognised but not enforced by the fixture (Claude
// itself enforces it server-side; we just tag the result so tests can
// assert flow).

import { readSync, openSync, fstatSync } from "node:fs";

const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}
function flagValue(name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
}
function flagValueEq(prefix) {
  for (const a of argv) {
    if (a.startsWith(prefix + "=")) return a.slice(prefix.length + 1);
  }
  return null;
}

// `--version` short-circuit
if (hasFlag("--version")) {
  process.stdout.write("2.1.107 (fake-claude-fixture)\n");
  process.exit(0);
}

// Read the prompt from stdin (broker pipes it). Falls back to "" on EOF.
function readStdinSync() {
  try {
    const stat = fstatSync(0);
    if (stat.size > 0) {
      const buf = Buffer.alloc(stat.size);
      readSync(0, buf, 0, stat.size, 0);
      return buf.toString("utf8");
    }
  } catch {
    // pipe — read until EOF, capped at 1MB
    const chunks = [];
    const tmp = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < 1024 * 1024) {
      let n = 0;
      try {
        n = readSync(0, tmp, 0, tmp.length, null);
      } catch {
        break;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(tmp.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}

const prompt = readStdinSync().trim();
const sessionIdResume = flagValue("--resume");
const sessionIdNew = flagValue("--session-id");
const sessionId = sessionIdResume ?? sessionIdNew ?? "fake-session-uuid";
const isResume = sessionIdResume !== null;

function emitSuccess(resultText, extra = {}) {
  const env = {
    type: "result",
    subtype: "success",
    result: resultText,
    session_id: sessionId,
    total_cost_usd: 0.001,
    duration_ms: 10,
    ...extra,
  };
  process.stdout.write(JSON.stringify(env));
  process.exit(0);
}

function emitFailure(stderrMsg, exitCode = 1) {
  process.stderr.write(stderrMsg);
  process.exit(exitCode);
}

function emitInternalError(message) {
  // Claude-style is_error envelope on exit 0/non-zero (varies by case).
  // We emit on exit 1 to match Credit-balance behaviour observed in real probes.
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: message,
      session_id: sessionId,
      total_cost_usd: 0,
    }),
  );
  process.exit(1);
}

// --- branch dispatch ---

if (prompt.startsWith("fake:succeed:")) {
  emitSuccess(prompt.slice("fake:succeed:".length));
}
if (prompt.startsWith("fake:fail:")) {
  emitFailure(prompt.slice("fake:fail:".length) + "\n", 1);
}
if (prompt.startsWith("fake:hang:")) {
  const ms = parseInt(prompt.slice("fake:hang:".length), 10) || 100;
  setTimeout(() => emitSuccess("done after " + ms + "ms"), ms);
} else if (prompt === "fake:session-resume-hit") {
  emitSuccess("resumed-ok");
} else if (prompt === "fake:session-resume-miss") {
  // Fail when --resume; succeed when --session-id (fallback path).
  if (isResume) {
    emitFailure(`No conversation found with session ID: ${sessionId}\n`, 1);
  } else {
    emitSuccess("created-via-fallback");
  }
} else if (prompt === "fake:session-resume-fail") {
  emitFailure(`No conversation found with session ID: ${sessionId}\n`, 1);
} else if (prompt === "fake:review-valid") {
  emitSuccess(
    JSON.stringify({
      verdict: "needs-attention",
      summary: "Found one issue.",
      findings: [
        {
          severity: "high",
          title: "Null deref",
          body: "user.id may be undefined",
          file: "src/user.ts",
          line_start: 42,
          line_end: 42,
          confidence: 0.9,
          recommendation: "Add null check.",
        },
      ],
      next_steps: ["Fix the null deref."],
    }),
  );
} else if (prompt === "fake:review-invalid-verdict") {
  emitSuccess(JSON.stringify({ verdict: "maybe" }));
} else if (prompt === "fake:credit-exhausted") {
  emitInternalError("Credit balance is too low");
} else if (prompt === "fake:auth-required") {
  emitInternalError("Please log in via `claude /login`");
} else if (prompt === "ok") {
  // Default health probe prompt → just succeed.
  emitSuccess("ok");
} else if (prompt.length === 0) {
  // No stdin — don't hang.
  emitFailure(
    "Input must be provided either through stdin or as a prompt argument when using --print\n",
    1,
  );
} else {
  // Default: echo the prompt as the result.
  emitSuccess(prompt);
}
