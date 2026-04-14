import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquire,
  release,
  inspect,
  SessionLockError,
} from "../plugins/cc/scripts/lib/session-lock.mjs";
import {
  _internals as pidInternals,
} from "../plugins/cc/scripts/lib/pid-identity.mjs";

const ORIG_STATE_DIR = process.env.CC_PLUGIN_CODEX_STATE_DIR;
const ORIG_PID_KILL = pidInternals.kill;
const ORIG_PID_SPAWN = pidInternals.spawnSync;

function withFreshStateDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-lock-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = tmp;
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      pidInternals.kill = ORIG_PID_KILL;
      pidInternals.spawnSync = ORIG_PID_SPAWN;
      if (ORIG_STATE_DIR === undefined)
        delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
      else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    });
}

test("acquire then release: lock dir created and removed", async () => {
  await withFreshStateDir(async (root) => {
    const h = await acquire("test-1");
    const lockDir = path.join(root, "sessions", "test-1.lock");
    assert.ok(fs.existsSync(lockDir), "lock dir should exist after acquire");
    assert.ok(fs.existsSync(path.join(lockDir, "info.json")));
    release(h);
    assert.ok(!fs.existsSync(lockDir), "lock dir should be gone after release");
  });
});

test("info.json carries owner_pid + lstart_raw + request_id", async () => {
  await withFreshStateDir(async () => {
    const h = await acquire("test-2", { requestId: "req-abc" });
    try {
      const info = inspect("test-2");
      assert.ok(info);
      assert.equal(info.owner_pid, process.pid);
      assert.equal(typeof info.owner_lstart_raw, "string");
      assert.ok(info.owner_lstart_raw.length > 0);
      assert.equal(info.request_id, "req-abc");
      assert.equal(typeof info.acquired_at_ms, "number");
      assert.equal(typeof info.heartbeat_at_ms, "number");
    } finally {
      release(h);
    }
  });
});

test("acquire blocks while lock is held; resumes after release", async () => {
  await withFreshStateDir(async () => {
    const h1 = await acquire("test-3");
    let resolved = false;
    const acq2 = acquire("test-3", { timeoutMs: 5000 }).then((h) => {
      resolved = true;
      return h;
    });
    // Give the second attempt a couple of poll cycles to confirm it's waiting.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(resolved, false, "second acquire should still be blocked");
    release(h1);
    const h2 = await acq2;
    assert.equal(resolved, true);
    release(h2);
  });
});

test("acquire(timeoutMs:0) on held lock fails fast with would-block", async () => {
  await withFreshStateDir(async () => {
    const h1 = await acquire("test-4");
    try {
      await assert.rejects(
        () => acquire("test-4", { timeoutMs: 0 }),
        (err) =>
          err instanceof SessionLockError && err.reason === "would-block",
      );
    } finally {
      release(h1);
    }
  });
});

test("acquire times out with reason='timeout'", async () => {
  await withFreshStateDir(async () => {
    const h1 = await acquire("test-5");
    try {
      await assert.rejects(
        () => acquire("test-5", { timeoutMs: 50 }),
        (err) => err instanceof SessionLockError && err.reason === "timeout",
      );
    } finally {
      release(h1);
    }
  });
});

test("different session_ids are independent", async () => {
  await withFreshStateDir(async () => {
    const a = await acquire("test-6a");
    // No timeout: should succeed immediately.
    const b = await acquire("test-6b", { timeoutMs: 100 });
    assert.ok(a && b);
    release(a);
    release(b);
  });
});

test("stale reclaim: dead owner pid → second acquire wins quickly", async () => {
  await withFreshStateDir(async (root) => {
    // Manually plant a lock dir whose owner_pid is dead.
    const lockDir = path.join(root, "sessions", "test-stale.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      JSON.stringify({
        owner_pid: 2_147_483_646, // pseudo-impossible pid
        owner_lstart_raw: "Mon Jan  1 00:00:00 2000",
        acquired_at_ms: Date.now() - 60_000,
        request_id: "ghost",
        heartbeat_at_ms: Date.now() - 60_000,
      }),
    );
    const start = Date.now();
    const h = await acquire("test-stale", { timeoutMs: 5000 });
    const took = Date.now() - start;
    try {
      assert.ok(took < 1000, `reclaim should be fast; took ${took}ms`);
      const info = inspect("test-stale");
      assert.equal(info.owner_pid, process.pid);
    } finally {
      release(h);
    }
  });
});

test("stale reclaim: pid lives but lstart mismatches → reclaim wins", async () => {
  await withFreshStateDir(async (root) => {
    // Plant: owner_pid = ourselves (alive), owner_lstart_raw = clearly wrong.
    const lockDir = path.join(root, "sessions", "test-pidreuse.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      JSON.stringify({
        owner_pid: process.pid,
        owner_lstart_raw: "Mon Jan  1 00:00:00 1999",
        acquired_at_ms: Date.now() - 60_000,
        request_id: "ghost",
        heartbeat_at_ms: Date.now() - 60_000,
      }),
    );
    const h = await acquire("test-pidreuse", { timeoutMs: 5000 });
    try {
      assert.equal(inspect("test-pidreuse").owner_pid, process.pid);
    } finally {
      release(h);
    }
  });
});

test("stale heartbeat alone is NOT a reclaim trigger (live pid)", async () => {
  await withFreshStateDir(async (root) => {
    const lockDir = path.join(root, "sessions", "test-hbstale.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    // Owner pid = ourselves (alive); lstart matches; but heartbeat is ancient.
    // Mock pidInternals.spawnSync to return a known lstart so we can lie
    // matching it in info.json.
    pidInternals.spawnSync = () => ({
      status: 0,
      stdout: "Mon Apr 14 12:00:00 2026\n",
      error: null,
      stderr: "",
      signal: null,
    });
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      JSON.stringify({
        owner_pid: process.pid,
        owner_lstart_raw: "Mon Apr 14 12:00:00 2026",
        acquired_at_ms: Date.now() - 600_000,
        request_id: "live-but-quiet",
        heartbeat_at_ms: Date.now() - 600_000, // 10 min stale
      }),
    );
    await assert.rejects(
      () => acquire("test-hbstale", { timeoutMs: 100 }),
      (err) => err instanceof SessionLockError && err.reason === "timeout",
    );
  });
});

test("orphaned info.json (corrupt) is reclaimed", async () => {
  await withFreshStateDir(async (root) => {
    const lockDir = path.join(root, "sessions", "test-corrupt.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "info.json"), "{ not json");
    const h = await acquire("test-corrupt", { timeoutMs: 1000 });
    try {
      const info = inspect("test-corrupt");
      assert.equal(info.owner_pid, process.pid);
    } finally {
      release(h);
    }
  });
});

test("release is idempotent", async () => {
  await withFreshStateDir(async () => {
    const h = await acquire("test-idem");
    release(h);
    release(h); // must not throw
    assert.equal(h.released, true);
  });
});

test("ps unknown state (live pid + ps fails on classify) does NOT reclaim live lock", async () => {
  await withFreshStateDir(async (root) => {
    // Plant a held lock whose owner_lstart matches ourselves (real value).
    const realLstart = (await import("../plugins/cc/scripts/lib/pid-identity.mjs")).readLstart(process.pid);
    assert.ok(realLstart, "must be able to read own lstart in test setup");
    const lockDir = path.join(root, "sessions", "test-unknown.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      JSON.stringify({
        owner_pid: process.pid,
        owner_lstart_raw: realLstart,
        acquired_at_ms: Date.now() - 1000,
        request_id: "live-but-ps-broken",
        heartbeat_at_ms: Date.now() - 1000,
      }),
    );
    // First spawnSync call (acquire reading self lstart) succeeds with the
    // real value; subsequent calls (reclaim's classifyOwner) fail.
    let calls = 0;
    pidInternals.spawnSync = () => {
      calls += 1;
      if (calls === 1) {
        return { status: 0, stdout: realLstart + "\n", error: null, stderr: "", signal: null };
      }
      throw new Error("ps not allowed");
    };
    await assert.rejects(
      () => acquire("test-unknown", { timeoutMs: 200 }),
      (err) => err instanceof SessionLockError && err.reason === "timeout",
    );
  });
});

test("partial corrupt info.json (missing fields) treated as orphan", async () => {
  await withFreshStateDir(async (root) => {
    const lockDir = path.join(root, "sessions", "test-partial.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    // Valid JSON, but missing acquired_at_ms / request_id / heartbeat_at_ms.
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      JSON.stringify({
        owner_pid: process.pid,
        owner_lstart_raw: "Mon Apr 14 12:00:00 2026",
      }),
    );
    const h = await acquire("test-partial", { timeoutMs: 1000 });
    try {
      const info = inspect("test-partial");
      assert.equal(info.owner_pid, process.pid);
      // Now has all 5 required fields.
      assert.ok(Number.isFinite(info.acquired_at_ms));
      assert.equal(typeof info.request_id, "string");
    } finally {
      release(h);
    }
  });
});

test("acquire fails fast when readLstart returns null (cannot snapshot self)", async () => {
  await withFreshStateDir(async () => {
    pidInternals.spawnSync = () => ({
      status: 1,
      stdout: "",
      stderr: "",
      error: null,
      signal: null,
    });
    await assert.rejects(
      () => acquire("test-noself"),
      (err) =>
        err instanceof SessionLockError && err.reason === "lstart-unreadable",
    );
  });
});

test("inspect returns null for unheld lock", async () => {
  await withFreshStateDir(async () => {
    assert.equal(inspect("never-held"), null);
  });
});
