import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { buildBroker, isDirectInvocation } from "../plugins/cc/scripts/claude-broker.mjs";
import {
  _internals as healthInternals,
  _setCached,
} from "../plugins/cc/scripts/lib/health.mjs";

const ORIG_SPAWN = healthInternals.spawnSync;
const ORIG_READ_SETTINGS = healthInternals.readSettings;
const ORIG_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function restoreEnv() {
  healthInternals.spawnSync = ORIG_SPAWN;
  healthInternals.readSettings = ORIG_READ_SETTINGS;
  _setCached(null);
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY;
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
  async function nextMessage() {
    for (let i = 0; i < 100; i++) {
      if (outbox.length > 0) return outbox.shift();
      await new Promise((r) => setTimeout(r, 2));
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

test("broker: stub tool returns not-implemented when health is OK", async () => {
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
        params: { name: "claude_ask", arguments: { prompt: "hi" } },
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
        params: { name: "claude_review", arguments: { target: "src/" } },
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
