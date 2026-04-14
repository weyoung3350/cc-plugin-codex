import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  probeHealth,
  getHealth,
  assertHealthy,
  HealthError,
  _internals,
  _setCached,
} from "../plugins/cc/scripts/lib/health.mjs";

const ORIG_SPAWN = _internals.spawnSync;
const ORIG_READ = _internals.readSettings;
const ORIG_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIG_STATE_DIR = process.env.CC_PLUGIN_CODEX_STATE_DIR;

// All tests get a writable per-test scratch state dir. Without this, the
// new state-dir-writable gate would fail on machines where the default
// $HOME/.local/state is root-owned (a real scenario we're fixing).
let scratchStateDir = null;
function setupScratchStateDir() {
  scratchStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-health-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = scratchStateDir;
}

function restore() {
  _internals.spawnSync = ORIG_SPAWN;
  _internals.readSettings = ORIG_READ;
  _setCached(null);
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY;
  if (ORIG_STATE_DIR === undefined)
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE_DIR;
  if (scratchStateDir) {
    try {
      fs.rmSync(scratchStateDir, { recursive: true, force: true });
    } catch {}
    scratchStateDir = null;
  }
}

// Helper: a fake spawnSync that routes by argv[0]/first arg.
function fakeSpawn({ version, probe }) {
  return (cmd, args) => {
    if (args[0] === "--version") return version;
    // probe: claude -p ...
    if (args[0] === "-p") return probe;
    throw new Error(`unexpected spawn args: ${args.join(" ")}`);
  };
}

test("probeHealth: not installed when claude --version spawn fails with ENOENT", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = () => ({
      error: Object.assign(new Error("no such file"), { code: "ENOENT" }),
      status: null,
      stdout: null,
      stderr: null,
      signal: null,
    });
    delete process.env.ANTHROPIC_API_KEY;
    const s = probeHealth();
    assert.equal(s.installed, false);
    assert.equal(s.authenticated, false);
    // bare_compatible removed; this branch just verifies installed=false.
    assert.ok(s.warnings.includes("claude-not-installed"));
  } finally {
    restore();
  }
});

test("probeHealth: happy path sets all flags", () => {
  setupScratchStateDir();
  try {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    _internals.spawnSync = fakeSpawn({
      version: {
        error: null,
        status: 0,
        stdout: "2.1.105 (Claude Code)\n",
        stderr: "",
        signal: null,
      },
      probe: {
        error: null,
        status: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "ok",
        }),
        stderr: "",
        signal: null,
      },
    });
    const s = probeHealth();
    assert.equal(s.installed, true);
    assert.equal(s.version, "2.1.105");
    assert.equal(s.authenticated, true);
    // bare_compatible removed: probe success itself is the predicate.
    assert.equal(s.api_key_source, "env");
    assert.equal(s.platform_supported, process.platform === "darwin" || process.platform === "linux");
  } finally {
    restore();
  }
});

test("probeHealth: version parsing tolerates trailing extras", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = fakeSpawn({
      version: {
        error: null,
        status: 0,
        stdout: "1.2.3-beta1 extra\n",
        stderr: "",
        signal: null,
      },
      probe: {
        error: null,
        status: 0,
        stdout: "{}",
        stderr: "",
        signal: null,
      },
    });
    const s = probeHealth();
    assert.equal(s.version, "1.2.3-beta1");
  } finally {
    restore();
  }
});

test("probeHealth: probe returns non-JSON → warns, not authenticated", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "garbage", stderr: "", signal: null },
    });
    const s = probeHealth();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.some((w) => w.includes("probe-non-json")));
  } finally {
    restore();
  }
});

test("probeHealth: probe stderr mentions auth → auth-required warning", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: {
        error: null,
        status: 1,
        stdout: "",
        stderr: "Authentication failed: invalid API key",
        signal: null,
      },
    });
    const s = probeHealth();
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.includes("auth-required"));
  } finally {
    restore();
  }
});

test("getHealth caches and refresh reprobes", () => {
  setupScratchStateDir();
  try {
    let calls = 0;
    const sp = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    _internals.spawnSync = (cmd, args, opts) => {
      calls += 1;
      return sp(cmd, args, opts);
    };
    getHealth();
    const callsAfterFirst = calls;
    getHealth();
    assert.equal(calls, callsAfterFirst, "second call should use cache");
    getHealth({ refresh: true });
    assert.ok(calls > callsAfterFirst, "refresh should reprobe");
  } finally {
    restore();
  }
});

test("assertHealthy throws HealthError when not installed", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = () => ({
      error: Object.assign(new Error("no such file"), { code: "ENOENT" }),
      status: null,
      stdout: null,
      stderr: null,
      signal: null,
    });
    assert.throws(
      () => assertHealthy(),
      (err) => err instanceof HealthError && err.reason === "not-installed",
    );
  } finally {
    restore();
  }
});

test("assertHealthy throws when installed but not authenticated", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 1, stdout: "", stderr: "oops", signal: null },
    });
    assert.throws(
      () => assertHealthy(),
      (err) => err instanceof HealthError && err.reason === "auth-required",
    );
  } finally {
    restore();
  }
});

test("probeHealth: probe timeout classified as probe-timeout warning", () => {
  setupScratchStateDir();
  try {
    _internals.spawnSync = (cmd, args, opts) => {
      if (args[0] === "--version") {
        return { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null };
      }
      // Simulate timeout: error ETIMEDOUT + signal SIGTERM (Node 22 behavior)
      return {
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        status: null,
        stdout: "",
        stderr: "",
        signal: "SIGTERM",
      };
    };
    const s = probeHealth();
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.includes("probe-timeout"));
    assert.ok(!s.warnings.some((w) => w.startsWith("probe-failed")));
  } finally {
    restore();
  }
});

test("probeHealth: api_key_source = helper when settings.apiKeyHelper present", () => {
  setupScratchStateDir();
  try {
    delete process.env.ANTHROPIC_API_KEY;
    _internals.readSettings = () => ({ apiKeyHelper: "/path/to/helper.sh" });
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    const s = probeHealth();
    assert.equal(s.api_key_source, "helper");
  } finally {
    restore();
  }
});

test("probeHealth: api_key_source = oauth when probe succeeds without env/helper", () => {
  setupScratchStateDir();
  try {
    delete process.env.ANTHROPIC_API_KEY;
    _internals.readSettings = () => null;
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    const s = probeHealth();
    // Subscription/OAuth path: env and helper are both absent yet the
    // probe authenticated → infer OAuth keychain.
    assert.equal(s.api_key_source, "oauth");
    assert.equal(s.authenticated, true);
  } finally {
    restore();
  }
});

test("probeHealth: api_key_source = null when probe fails and no env/helper", () => {
  setupScratchStateDir();
  try {
    delete process.env.ANTHROPIC_API_KEY;
    _internals.readSettings = () => null;
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: {
        error: null,
        status: 1,
        stdout: '{"is_error":true,"result":"please log in"}',
        stderr: "",
        signal: null,
      },
    });
    const s = probeHealth();
    assert.equal(s.api_key_source, null);
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.includes("auth-required"));
  } finally {
    restore();
  }
});

test("probeHealth: platform unsupported short-circuits, no spawn", () => {
  setupScratchStateDir();
  try {
    let spawned = false;
    _internals.spawnSync = () => {
      spawned = true;
      throw new Error("should not run");
    };
    // Temporarily monkey-patch process.platform for this test.
    const origPlat = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const s = probeHealth();
      assert.equal(s.platform_supported, false);
      assert.equal(spawned, false);
      assert.deepEqual(s.warnings, ["platform-unsupported"]);
      assert.equal(s.installed, false);
      assert.equal(s.authenticated, false);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlat, configurable: true });
    }
  } finally {
    restore();
  }
});

test("assertHealthy throws platform-unsupported on non-POSIX", () => {
  setupScratchStateDir();
  try {
    const origPlat = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      assert.throws(
        () => assertHealthy(),
        (err) => err instanceof HealthError && err.reason === "platform-unsupported",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: origPlat, configurable: true });
    }
  } finally {
    restore();
  }
});

test("probeHealth: includes state_dir field with writable + hint", async () => {
  setupScratchStateDir();
  try {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    const s = probeHealth();
    assert.ok(s.state_dir);
    assert.equal(typeof s.state_dir.path, "string");
    assert.equal(typeof s.state_dir.writable, "boolean");
    // Default HOME .local/state should normally be writable on a dev machine.
    // The point of the test is the field exists with correct shape, not the
    // specific value (CI environments vary).
  } finally {
    restore();
  }
});

test("assertHealthy throws state-dir-not-writable when writable=false", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-sdw-h-"));
  const sealed = path.join(tmp, "sealed");
  fs.mkdirSync(sealed);
  fs.chmodSync(sealed, 0o555);
  const ORIG = process.env.CC_PLUGIN_CODEX_STATE_DIR;
  // NOTE: we DO NOT call setupScratchStateDir() here — the whole point
  // of this test is a NON-writable state dir.
  process.env.CC_PLUGIN_CODEX_STATE_DIR = path.join(sealed, "state");
  try {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    assert.throws(
      () => assertHealthy(),
      (err) => err instanceof HealthError && err.reason === "state-dir-not-writable",
    );
  } finally {
    if (ORIG === undefined) delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
    else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG;
    fs.chmodSync(sealed, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    restore();
  }
});

test("assertHealthy returns state on success", () => {
  setupScratchStateDir();
  try {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    _internals.spawnSync = fakeSpawn({
      version: { error: null, status: 0, stdout: "2.1.105\n", stderr: "", signal: null },
      probe: { error: null, status: 0, stdout: "{}", stderr: "", signal: null },
    });
    const s = assertHealthy();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, true);
  } finally {
    restore();
  }
});
