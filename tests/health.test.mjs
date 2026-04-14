import test from "node:test";
import assert from "node:assert/strict";

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

function restore() {
  _internals.spawnSync = ORIG_SPAWN;
  _internals.readSettings = ORIG_READ;
  _setCached(null);
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY;
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

test("assertHealthy returns state on success", () => {
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
