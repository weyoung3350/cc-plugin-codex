import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  runClaude,
  parseClaudeJson,
  _internals,
} from "../plugins/cc/scripts/lib/claude-run.mjs";

const ORIG_SPAWN = _internals.spawn;
function restore() {
  _internals.spawn = ORIG_SPAWN;
}

/**
 * Build a fake child process object for the spawn mock. The caller drives
 * stdout / stderr / exit / error via the returned `drive` helpers.
 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  /** @type {any} */
  const child = {
    stdin,
    stdout,
    stderr,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: (signal) => {
      child._killed = signal;
      // Synthetic: fire 'close' on SIGKILL if we haven't already.
      if (signal === "SIGKILL") {
        setImmediate(() => emitter.emit("close", null, signal));
      }
    },
    _killed: null,
  };
  return {
    child,
    emitStdout: (s) => stdout.write(s),
    emitStderr: (s) => stderr.write(s),
    close: (code, signal = null) => {
      stdout.end();
      stderr.end();
      emitter.emit("close", code, signal);
    },
  };
}

test("runClaude: happy path captures stdout and classifies success", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    const p = runClaude({
      flags: ["-p", "--output-format=json"],
      prompt: "hello",
    });
    // Let spawn return and handlers attach.
    await new Promise((r) => setImmediate(r));
    f.emitStdout("hello world");
    f.close(0);
    const res = await p;
    assert.equal(res.text, "hello world");
    assert.equal(res.truncated, false);
    assert.equal(res.captured_bytes, 11);
    assert.equal(res.total_bytes, 11);
    assert.equal(res.exit_code, 0);
    assert.equal(res.exit_signal, null);
    assert.equal(res.error, null);
    assert.equal(res.resume_retried, false);
  } finally {
    restore();
  }
});

test("runClaude: exceeding maxOutputBytes truncates and reports total", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    const p = runClaude({
      flags: ["-p"],
      prompt: "",
      maxOutputBytes: 10,
    });
    await new Promise((r) => setImmediate(r));
    f.emitStdout("1234567890ABCDE"); // 15 bytes
    f.close(0);
    const res = await p;
    assert.equal(res.text, "1234567890");
    assert.equal(res.truncated, true);
    assert.equal(res.captured_bytes, 10);
    assert.equal(res.total_bytes, 15);
  } finally {
    restore();
  }
});

test("runClaude: non-zero exit → error=nonzero", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    const p = runClaude({ flags: ["-p"], prompt: "" });
    await new Promise((r) => setImmediate(r));
    f.emitStderr("boom");
    f.close(1);
    const res = await p;
    assert.equal(res.error, "nonzero");
    assert.equal(res.exit_code, 1);
    assert.match(res.stderr, /boom/);
    assert.equal(res.resume_retried, false);
  } finally {
    restore();
  }
});

test("runClaude: timeout triggers SIGTERM and error=timeout", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    const p = runClaude({
      flags: ["-p"],
      prompt: "",
      timeoutMs: 20,
      graceMs: 10,
    });
    await new Promise((r) => setImmediate(r));
    // Don't close the child; let the run timer fire.
    const res = await p;
    assert.equal(res.error, "timeout");
    assert.equal(f.child._killed === "SIGTERM" || f.child._killed === "SIGKILL", true);
  } finally {
    restore();
  }
});

test("runClaude: spawn error → nonzero with error stderr stub", async () => {
  try {
    _internals.spawn = () => {
      // Return a child that immediately emits 'error'.
      const emitter = new EventEmitter();
      const child = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on: emitter.on.bind(emitter),
        kill: () => {},
      };
      setImmediate(() =>
        emitter.emit("error", Object.assign(new Error("no bin"), { code: "ENOENT" })),
      );
      return child;
    };
    const res = await runClaude({ flags: ["-p"], prompt: "" });
    assert.equal(res.error, "nonzero");
    assert.match(res.stderr, /ENOENT/);
  } finally {
    restore();
  }
});

test("runClaude: --resume with 'no such session' stderr falls back to --session-id", async () => {
  try {
    let callCount = 0;
    const flags1Seen = [];
    const flags2Seen = [];
    _internals.spawn = (bin, argv) => {
      callCount += 1;
      const f = fakeChild();
      if (callCount === 1) {
        flags1Seen.push(...argv);
        setImmediate(() => {
          f.emitStderr("Error: no such session with id abc-123");
          f.close(1);
        });
      } else {
        flags2Seen.push(...argv);
        setImmediate(() => {
          f.emitStdout("resumed-ok");
          f.close(0);
        });
      }
      return f.child;
    };
    const res = await runClaude({
      flags: ["-p", "--output-format=json", "--resume", "abc-123"],
      prompt: "hi",
    });
    assert.equal(callCount, 2);
    assert.equal(res.resume_retried, true);
    assert.equal(res.error, null);
    assert.equal(res.text, "resumed-ok");
    // Confirm second invocation rewrote --resume → --session-id.
    const idx = flags2Seen.indexOf("--session-id");
    assert.ok(idx >= 0);
    assert.equal(flags2Seen[idx + 1], "abc-123");
    assert.ok(!flags2Seen.includes("--resume"));
  } finally {
    restore();
  }
});

test("runClaude: --resume with unrelated stderr does NOT fall back", async () => {
  try {
    let callCount = 0;
    _internals.spawn = () => {
      callCount += 1;
      const f = fakeChild();
      setImmediate(() => {
        f.emitStderr("Error: some other failure");
        f.close(1);
      });
      return f.child;
    };
    const res = await runClaude({
      flags: ["-p", "--resume", "abc-123"],
      prompt: "hi",
    });
    assert.equal(callCount, 1);
    assert.equal(res.resume_retried, false);
    assert.equal(res.error, "nonzero");
  } finally {
    restore();
  }
});

test("runClaude: resumeFallback=false disables retry", async () => {
  try {
    let callCount = 0;
    _internals.spawn = () => {
      callCount += 1;
      const f = fakeChild();
      setImmediate(() => {
        f.emitStderr("no such session");
        f.close(1);
      });
      return f.child;
    };
    const res = await runClaude({
      flags: ["-p", "--resume", "x"],
      prompt: "",
      resumeFallback: false,
    });
    assert.equal(callCount, 1);
    assert.equal(res.resume_retried, false);
  } finally {
    restore();
  }
});

test("runClaude: real Claude CLI 'No conversation found' triggers fallback", async () => {
  // This is the actual stderr Claude 2.1.107 emits — verified end-to-end.
  // Regression guard: if upstream changes this string, runClaude breaks
  // session continuity silently unless we extend the pattern set.
  try {
    let callCount = 0;
    _internals.spawn = () => {
      callCount += 1;
      const f = fakeChild();
      if (callCount === 1) {
        setImmediate(() => {
          f.emitStderr(
            "No conversation found with session ID: 385b64d2-5d2f-4468-b58e-be80104ff699\n",
          );
          f.close(1);
        });
      } else {
        setImmediate(() => {
          f.emitStdout("created");
          f.close(0);
        });
      }
      return f.child;
    };
    const res = await runClaude({
      flags: ["-p", "--resume", "385b64d2-5d2f-4468-b58e-be80104ff699"],
      prompt: "",
    });
    assert.equal(callCount, 2, "expected fallback retry");
    assert.equal(res.resume_retried, true);
    assert.equal(res.text, "created");
  } finally {
    restore();
  }
});

test("runClaude: resume fallback shares the timeoutMs budget across attempts", async () => {
  // Total budget 200ms. First attempt takes ~150ms before failing with
  // "no conversation found"; second attempt should run with ~50ms
  // remaining budget, NOT a fresh full 200ms.
  try {
    let callCount = 0;
    let secondTimeoutSeen = null;
    _internals.spawn = (bin, argv) => {
      callCount += 1;
      const f = fakeChild();
      if (callCount === 1) {
        setTimeout(() => {
          f.emitStderr("No conversation found with session ID: x");
          f.close(1);
        }, 150);
      } else {
        // Capture: at the time the second spawn happens, the budget left
        // should be ~50ms. We can't assert it directly, but we observe
        // the wall-clock — the second call must time out fast.
        secondTimeoutSeen = Date.now();
        // Hang forever; rely on shared budget to kill us within ~50ms.
        return f.child;
      }
      return f.child;
    };
    const start = Date.now();
    const res = await runClaude({
      flags: ["-p", "--resume", "x"],
      prompt: "",
      timeoutMs: 200,
      graceMs: 5,
    });
    const elapsed = Date.now() - start;
    assert.equal(res.resume_retried, true);
    // The total wall-clock should be close to 200ms (first 150 + second
    // ~50), with some slack for JS scheduling. Definitely NOT 200+200.
    assert.ok(elapsed < 350, `expected ~200ms, took ${elapsed}ms`);
    assert.equal(res.error, "timeout");
  } finally {
    restore();
  }
});

test("runClaude: 'no session with id' stderr also triggers fallback", async () => {
  try {
    let callCount = 0;
    _internals.spawn = () => {
      callCount += 1;
      const f = fakeChild();
      if (callCount === 1) {
        setImmediate(() => {
          f.emitStderr("Error: no session with id foo-bar");
          f.close(1);
        });
      } else {
        setImmediate(() => {
          f.emitStdout("retry-ok");
          f.close(0);
        });
      }
      return f.child;
    };
    const res = await runClaude({
      flags: ["-p", "--resume", "foo-bar"],
      prompt: "",
    });
    assert.equal(callCount, 2);
    assert.equal(res.resume_retried, true);
    assert.equal(res.text, "retry-ok");
  } finally {
    restore();
  }
});

test("runClaude: UTF-8 boundary split across chunks still cleanly truncated", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    // "中" = E4 B8 AD. Cap at 3 bytes. Deliver as two chunks [E4 B8] then [AD 41].
    // After truncation at 3 bytes, naive code would keep [E4 B8 AD] (=complete "中")
    // OR [E4 B8] (=broken). The boundary walk must restore either
    // a) full "中" (3 bytes) if the chunk happens to cross perfectly, OR
    // b) drop the incomplete lead if not.
    // This test also documents that cross-chunk split stays stable.
    const p = runClaude({
      flags: ["-p"],
      prompt: "",
      maxOutputBytes: 3,
    });
    await new Promise((r) => setImmediate(r));
    f.child.stdout.write(Buffer.from([0xe4, 0xb8])); // 2 bytes, half of "中"
    f.child.stdout.write(Buffer.from([0xad, 0x41])); // AD completes "中", 0x41 = "A" overflows
    f.close(0);
    const res = await p;
    assert.equal(res.truncated, true);
    // captured_bytes must equal byte length of decoded text — no broken chars.
    assert.equal(Buffer.byteLength(res.text, "utf8"), res.captured_bytes);
    // text must not contain replacement char.
    assert.ok(!res.text.includes("\uFFFD"), "no U+FFFD in text");
  } finally {
    restore();
  }
});

test("runClaude: UTF-8 boundary truncation keeps captured_bytes consistent", async () => {
  try {
    const f = fakeChild();
    _internals.spawn = () => f.child;
    // 中 = E4 B8 AD (3 bytes). Emit three of them = 9 bytes. Cap at 4 bytes.
    // Naive cut would retain E4 B8 (2 bytes into middle of 2nd char).
    // Correct: walk back to before the incomplete sequence — keep 3 bytes = "中".
    const src = Buffer.from("中中中", "utf8"); // 9 bytes
    const p = runClaude({
      flags: ["-p"],
      prompt: "",
      maxOutputBytes: 4,
    });
    await new Promise((r) => setImmediate(r));
    f.child.stdout.write(src);
    f.close(0);
    const res = await p;
    assert.equal(res.truncated, true);
    // We should retain only the first complete "中" (3 bytes) — not 4 bytes
    // that would cut into the second char.
    assert.equal(res.captured_bytes, 3);
    assert.equal(res.text, "中");
    assert.equal(Buffer.byteLength(res.text, "utf8"), res.captured_bytes);
    assert.equal(res.total_bytes, 9);
  } finally {
    restore();
  }
});

test("parseClaudeJson: happy path extracts result / session_id / cost", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "hello",
    session_id: "abc-123",
    total_cost_usd: 0.0042,
  });
  const out = parseClaudeJson(raw);
  assert.equal(out.result, "hello");
  assert.equal(out.session_id, "abc-123");
  assert.equal(out.total_cost_usd, 0.0042);
});

test("parseClaudeJson: invalid JSON → all null", () => {
  const out = parseClaudeJson("not json");
  assert.equal(out.result, null);
  assert.equal(out.session_id, null);
  assert.equal(out.total_cost_usd, null);
  assert.equal(out.parsed, null);
});

test("parseClaudeJson: missing fields → individual nulls", () => {
  const raw = JSON.stringify({ type: "result" });
  const out = parseClaudeJson(raw);
  assert.equal(out.result, null);
  assert.equal(out.session_id, null);
  assert.equal(out.total_cost_usd, null);
  assert.ok(out.parsed);
});
