import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBroker, isDirectInvocation } from "../plugins/cc/scripts/claude-broker.mjs";
import {
  _internals as healthInternals,
  _setCached,
} from "../plugins/cc/scripts/lib/health.mjs";
import { _internals as runInternals } from "../plugins/cc/scripts/lib/claude-run.mjs";

const ORIG_SPAWN = healthInternals.spawnSync;
const ORIG_READ_SETTINGS = healthInternals.readSettings;
const ORIG_RUN_SPAWN = runInternals.spawn;
const ORIG_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIG_STATE_DIR = process.env.CC_PLUGIN_CODEX_STATE_DIR;

/** Per-test scratch dir used when a test passes session_id (so the lock
 * has a writable state root and doesn't collide with other tests). */
let activeScratchDir = null;
function setupScratchStateDir() {
  activeScratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-broker-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = activeScratchDir;
}

function restoreEnv() {
  healthInternals.spawnSync = ORIG_SPAWN;
  healthInternals.readSettings = ORIG_READ_SETTINGS;
  runInternals.spawn = ORIG_RUN_SPAWN;
  _setCached(null);
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY;
  if (ORIG_STATE_DIR === undefined)
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE_DIR;
  if (activeScratchDir) {
    try {
      fs.rmSync(activeScratchDir, { recursive: true, force: true });
    } catch {}
    activeScratchDir = null;
  }
}

/** Build a fake child for runClaude's async spawn. */
function fakeRunChild({ stdout = "", stderr = "", exitCode = 0, delayMs = 0 } = {}) {
  const emitter = new EventEmitter();
  let scheduled = null;
  let closed = false;
  const child = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: emitter.on.bind(emitter),
    kill: (signal) => {
      // Real Claude obeys SIGTERM quickly; mimic that so broker's grace
      // window doesn't dominate test wall-clock.
      if (closed) return;
      if (scheduled) clearTimeout(scheduled);
      // Tear down on next tick with the signal Node would surface.
      setImmediate(() => {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        emitter.emit("close", null, signal ?? "SIGTERM");
      });
    },
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    emitter.emit("close", exitCode, null);
  };
  if (delayMs > 0) scheduled = setTimeout(finish, delayMs);
  else setImmediate(finish);
  return child;
}

function mockHealthHappy() {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  healthInternals.readSettings = () => null;
  healthInternals.spawnSync = (cmd, args) => {
    if (args[0] === "--version") {
      return { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null };
    }
    return { error: null, status: 0, stdout: "{}", stderr: "", signal: null };
  };
  _setCached(null);
}

function mockHealthNotInstalled() {
  delete process.env.ANTHROPIC_API_KEY;
  healthInternals.readSettings = () => null;
  healthInternals.spawnSync = () => ({
    error: Object.assign(new Error("enoent"), { code: "ENOENT" }),
    status: null,
    stdout: null,
    stderr: null,
    signal: null,
  });
  _setCached(null);
}

function startHarness(server) {
  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {any[]} */
  const outbox = [];
  let buf = "";
  output.on("data", (c) => {
    buf += c.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      outbox.push(JSON.parse(line));
    }
  });
  server.start({ input, output, onClose: () => {} });

  function send(obj) {
    input.write(JSON.stringify(obj) + "\n");
  }
  async function nextMessage(maxWaitMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (outbox.length > 0) return outbox.shift();
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout");
  }
  function close() {
    input.end();
    server.stop();
  }
  return { send, nextMessage, close };
}

test("broker: initialize + tools/list returns 6 tools", async () => {
  try {
    mockHealthHappy();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const resp = await nextMessage();
      const names = resp.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "claude_ask",
        "claude_cancel",
        "claude_health",
        "claude_job_get",
        "claude_review",
        "claude_task",
      ]);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_health returns parseable state", async () => {
  try {
    mockHealthHappy();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_health", arguments: {} },
      });
      const resp = await nextMessage();
      assert.equal(resp.id, 2);
      assert.equal(resp.result.isError, false);
      const jsonChunk = resp.result.content.find((c) =>
        c.text && c.text.startsWith("{"),
      );
      const parsed = JSON.parse(jsonChunk.text);
      assert.equal(parsed.installed, true);
      assert.equal(parsed.authenticated, true);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_health refresh=true re-runs probe", async () => {
  try {
    mockHealthHappy();
    let probeCount = 0;
    const wrapped = healthInternals.spawnSync;
    healthInternals.spawnSync = (...a) => {
      probeCount += 1;
      return wrapped(...a);
    };
    // Pre-prime the cache (mirrors broker.main() startup behaviour).
    const { probeHealth } = await import(
      "../plugins/cc/scripts/lib/health.mjs"
    );
    probeHealth();
    const afterPrime = probeCount;
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      // First call: uses cache, no new spawns.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_health", arguments: {} },
      });
      await nextMessage();
      assert.equal(probeCount, afterPrime, "cached call should not spawn");
      // refresh=true: one more spawn cycle (version + probe).
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "claude_health", arguments: { refresh: true } },
      });
      await nextMessage();
      assert.ok(probeCount > afterPrime, "refresh should trigger new spawns");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: stub tool (claude_task) returns not-implemented when health is OK", async () => {
  try {
    mockHealthHappy();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_task", arguments: { task: "do x" } },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "not-implemented");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: stub tool returns health error when claude not installed", async () => {
  try {
    mockHealthNotInstalled();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_job_get", arguments: { job_id: "x" } },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "not-installed");
      assert.ok(parsed.hint);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_ask returns text + metadata on success", async () => {
  try {
    mockHealthHappy();
    const claudeEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello from Claude.",
      session_id: "auto-gen-xyz",
      total_cost_usd: 0.0023,
    });
    runInternals.spawn = () =>
      fakeRunChild({ stdout: claudeEnvelope, exitCode: 0 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "what is 2+2?" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, false);
      assert.equal(resp.result.content[0].text, "Hello from Claude.");
      const meta = JSON.parse(resp.result.content[1].text);
      // No session_id supplied → must be null even if Claude returned one.
      assert.equal(meta.session_id, null);
      assert.equal(meta.session_persisted, false);
      assert.equal(meta.cost_usd, 0.0023);
      assert.equal(meta.truncated, false);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_ask with session_id sets session_persisted=true", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    const env = JSON.stringify({
      type: "result",
      result: "ok",
      session_id: "abc-123",
    });
    runInternals.spawn = () =>
      fakeRunChild({ stdout: env, exitCode: 0 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "hi", session_id: "abc-123" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, false);
      const meta = JSON.parse(resp.result.content[1].text);
      assert.equal(meta.session_persisted, true);
      assert.equal(meta.session_id, "abc-123");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_ask claude-nonzero-exit surfaces error", async () => {
  try {
    mockHealthHappy();
    runInternals.spawn = () =>
      fakeRunChild({ stderr: "boom", exitCode: 1 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "hi" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "claude-nonzero-exit");
      assert.equal(parsed.exit_code, 1);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_review happy path returns schema-validated JSON", async () => {
  try {
    mockHealthHappy();
    const reviewObj = {
      verdict: "needs-attention",
      summary: "Found one bug.",
      findings: [
        {
          severity: "high",
          title: "Null deref",
          body: "user may be undefined here",
          file: "src/user.ts",
          line_start: 42,
          line_end: 42,
          confidence: 0.85,
          recommendation: "Add null check.",
        },
      ],
      next_steps: ["Fix the null deref."],
    };
    const env = JSON.stringify({
      type: "result",
      result: JSON.stringify(reviewObj),
      session_id: "rev-1",
    });
    runInternals.spawn = () => fakeRunChild({ stdout: env, exitCode: 0 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_review",
          arguments: { target: "src/user.ts" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, false);
      const body = JSON.parse(resp.result.content[0].text);
      assert.equal(body.verdict, "needs-attention");
      assert.equal(body.findings.length, 1);
      assert.equal(body.findings[0].severity, "high");
      // Meta fields merged in.
      assert.equal(body.session_persisted, false);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_review detects schema mismatch", async () => {
  try {
    mockHealthHappy();
    const bad = JSON.stringify({ verdict: "maybe" }); // missing summary/findings/next_steps
    const env = JSON.stringify({ type: "result", result: bad });
    runInternals.spawn = () => fakeRunChild({ stdout: env, exitCode: 0 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_review",
          arguments: { target: "src/x.ts" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "claude-review-schema-mismatch");
      assert.equal(parsed.field, "verdict");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_ask rejects empty prompt with invalid-prompt", async () => {
  try {
    mockHealthHappy();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_ask", arguments: { prompt: "" } },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "invalid-prompt");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_review rejects empty target with invalid-target", async () => {
  try {
    mockHealthHappy();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_review", arguments: { target: "" } },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "invalid-target");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_review strips undeclared args (add_dirs/model)", async () => {
  try {
    mockHealthHappy();
    let argvSeen = null;
    runInternals.spawn = (bin, argv) => {
      argvSeen = argv;
      const reviewObj = {
        verdict: "approve",
        summary: "ok",
        findings: [],
        next_steps: [],
      };
      const env = JSON.stringify({ type: "result", result: JSON.stringify(reviewObj) });
      return fakeRunChild({ stdout: env, exitCode: 0 });
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_review",
          arguments: {
            target: "src/x.ts",
            // Caller tries to smuggle in extra dirs / model — must be ignored.
            add_dirs: ["/etc"],
            model: "claude-rogue",
          },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, false);
      // /etc must NOT appear as --add-dir target;
      // --model must NOT appear at all.
      const addDirIndices = [];
      for (let i = 0; i < argvSeen.length; i += 1) {
        if (argvSeen[i] === "--add-dir") addDirIndices.push(i + 1);
      }
      const addDirValues = addDirIndices.map((i) => argvSeen[i]);
      assert.ok(!addDirValues.includes("/etc"), "add_dirs leaked into argv");
      assert.ok(!argvSeen.includes("--model"), "model leaked into argv");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: claude_review with non-JSON result returns claude-output-malformed", async () => {
  try {
    mockHealthHappy();
    const env = JSON.stringify({ type: "result", result: "not json at all" });
    runInternals.spawn = () => fakeRunChild({ stdout: env, exitCode: 0 });
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_review",
          arguments: { target: "src/x.ts" },
        },
      });
      const resp = await nextMessage();
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.equal(parsed.error, "claude-output-malformed");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: same session_id calls run serialised", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    /** @type {string[]} */
    const order = [];
    let inflight = 0;
    let maxInflight = 0;
    runInternals.spawn = (bin, argv) => {
      const idx = order.length;
      order.push(`spawn-${idx}`);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const env = JSON.stringify({
        type: "result",
        result: `ok-${idx}`,
        session_id: "S-1",
      });
      // Hold the child open for ~80 ms so concurrency would be observable
      // if serialisation were broken.
      const f = fakeRunChild({ stdout: env, exitCode: 0, delayMs: 80 });
      f.on("close", () => {
        inflight -= 1;
      });
      return f;
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      // Fire two concurrent calls with the same session_id.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "first", session_id: "S-1" },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "second", session_id: "S-1" },
        },
      });
      await nextMessage();
      await nextMessage();
      assert.equal(maxInflight, 1, `expected serial; saw ${maxInflight} inflight`);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: different session_ids run concurrently", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    let inflight = 0;
    let maxInflight = 0;
    runInternals.spawn = () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const env = JSON.stringify({ type: "result", result: "ok" });
      const f = fakeRunChild({ stdout: env, exitCode: 0, delayMs: 80 });
      f.on("close", () => {
        inflight -= 1;
      });
      return f;
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "a", session_id: "S-A" },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "b", session_id: "S-B" },
        },
      });
      await nextMessage();
      await nextMessage();
      assert.ok(maxInflight >= 2, `expected concurrent; saw ${maxInflight}`);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: lock-wait timeout returns timeout error with phase=lock-wait", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    // First call holds the lock for 2 seconds; second call has 1 second
    // budget, so it MUST time out in lock-wait.
    let spawnIdx = 0;
    runInternals.spawn = () => {
      spawnIdx += 1;
      const env = JSON.stringify({ type: "result", result: `x${spawnIdx}` });
      // First spawn: hold lock 2 s. Subsequent: instant.
      const delay = spawnIdx === 1 ? 2000 : 0;
      return fakeRunChild({ stdout: env, exitCode: 0, delayMs: delay });
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "first", session_id: "S-LOCK", timeout_sec: 30 },
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "second", session_id: "S-LOCK", timeout_sec: 1 },
        },
      });
      // r3 (second response) arrives FIRST because it times out at ~1s
      // while r2 keeps holding.
      const r3 = await nextMessage(3000);
      assert.equal(r3.result.isError, true);
      const parsed = JSON.parse(r3.result.content[0].text);
      assert.equal(parsed.error, "timeout");
      assert.equal(parsed.phase, "lock-wait");
      assert.equal(parsed.lock_reason, "timeout");
      assert.ok(parsed.duration_ms >= 900 && parsed.duration_ms <= 2000);
      // Drain r2 so we don't leak to other tests.
      await nextMessage(3000);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: total timeout budget is shared across lock-wait + run phases", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    // First holds 400ms; second has 2s budget. Lock-wait should consume
    // ~400ms, leaving ~1.6s for the run phase. The second spawn hangs;
    // it must time out in the RUN phase (not lock-wait).
    let spawnIdx = 0;
    runInternals.spawn = () => {
      spawnIdx += 1;
      const env = JSON.stringify({ type: "result", result: "x" });
      if (spawnIdx === 1) {
        return fakeRunChild({ stdout: env, exitCode: 0, delayMs: 400 });
      }
      // Second spawn: never completes within budget.
      const f = fakeRunChild({ stdout: env, exitCode: 0, delayMs: 10000 });
      return f;
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "a", session_id: "S-BUDGET", timeout_sec: 30 },
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "b", session_id: "S-BUDGET", timeout_sec: 2 },
        },
      });
      const r2 = await nextMessage(5000); // 1st finishes ~400ms
      const r3 = await nextMessage(5000); // 2nd times out shortly after
      assert.equal(r2.result.isError, false);
      assert.equal(r3.result.isError, true);
      const parsed = JSON.parse(r3.result.content[0].text);
      assert.equal(parsed.error, "timeout");
      // Critical: phase should be "run" because lock-wait consumed budget
      // BUT didn't fail — the run phase did.
      assert.equal(parsed.phase, "run");
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: lock-wait that exhausts budget refuses to spawn", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    let spawnCount = 0;
    runInternals.spawn = () => {
      spawnCount += 1;
      const env = JSON.stringify({ type: "result", result: "x" });
      const f = fakeRunChild({ stdout: env, exitCode: 0, delayMs: 1500 });
      return f;
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      // First call holds the lock for ~1.5s (one spawn).
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "first", session_id: "S-EX", timeout_sec: 30 },
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      // Second call has 1s budget; first holds 1.5s; lock-wait will
      // consume the entire budget before the lock is released. Broker
      // must NOT spawn a second Claude.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "claude_ask",
          arguments: { prompt: "second", session_id: "S-EX", timeout_sec: 1 },
        },
      });
      const r3 = await nextMessage(3000);
      assert.equal(r3.result.isError, true);
      const parsed = JSON.parse(r3.result.content[0].text);
      assert.equal(parsed.error, "timeout");
      assert.equal(parsed.phase, "lock-wait");
      // Drain r2 so we don't leak.
      await nextMessage(3000);
      // CRITICAL: spawnCount must be 1 — the second call never got to
      // claude.
      assert.equal(spawnCount, 1, `expected 1 spawn, got ${spawnCount}`);
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("broker: one-shot calls (no session_id) do NOT serialise", async () => {
  try {
    setupScratchStateDir();
    mockHealthHappy();
    let inflight = 0;
    let maxInflight = 0;
    runInternals.spawn = () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const env = JSON.stringify({ type: "result", result: "x" });
      const f = fakeRunChild({ stdout: env, exitCode: 0, delayMs: 80 });
      f.on("close", () => {
        inflight -= 1;
      });
      return f;
    };
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_ask", arguments: { prompt: "x" } },
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "claude_ask", arguments: { prompt: "y" } },
      });
      await nextMessage();
      await nextMessage();
      assert.ok(
        maxInflight >= 2,
        `one-shot must run concurrently; saw ${maxInflight}`,
      );
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});

test("isDirectInvocation: true when moduleUrl and argv1 resolve to same path", () => {
  const url = "file:///tmp/a/broker.mjs";
  assert.equal(
    isDirectInvocation({ moduleUrl: url, argv1: "/tmp/a/broker.mjs" }),
    true,
  );
});

test("isDirectInvocation: false when paths differ", () => {
  const url = "file:///tmp/a/broker.mjs";
  assert.equal(
    isDirectInvocation({ moduleUrl: url, argv1: "/tmp/b/other.mjs" }),
    false,
  );
});

test("isDirectInvocation: handles paths with spaces and unicode", () => {
  // URL encodes ' ' as %20; fileURLToPath must decode.
  const url = "file:///tmp/a%20b/%E4%B8%AD%E6%96%87.mjs";
  assert.equal(
    isDirectInvocation({ moduleUrl: url, argv1: "/tmp/a b/中文.mjs" }),
    true,
  );
});

test("isDirectInvocation: returns false when argv1 is undefined", () => {
  assert.equal(
    isDirectInvocation({
      moduleUrl: "file:///tmp/a/broker.mjs",
      argv1: undefined,
    }),
    false,
  );
});

test("broker: claude_health itself never blocks when claude not installed", async () => {
  try {
    mockHealthNotInstalled();
    const server = buildBroker();
    const { send, nextMessage, close } = startHarness(server);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      await nextMessage();
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_health", arguments: {} },
      });
      const resp = await nextMessage();
      // claude_health reports the bad state as isError:true, but still returns
      // a well-formed content payload (not a JSON-RPC error).
      assert.equal(resp.result.isError, true);
      const parsed = JSON.parse(resp.result.content[1].text);
      assert.equal(parsed.installed, false);
      assert.ok(parsed.warnings.includes("claude-not-installed"));
    } finally {
      close();
    }
  } finally {
    restoreEnv();
  }
});
