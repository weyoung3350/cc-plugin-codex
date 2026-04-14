import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { runWorker, _internals } from "../plugins/cc/scripts/claude-worker.mjs";
import {
  createJob,
  readJobState,
  requestCancel,
} from "../plugins/cc/scripts/lib/tracked-jobs.mjs";
import {
  readLstart,
  _internals as pidInternals,
} from "../plugins/cc/scripts/lib/pid-identity.mjs";

const ORIG_STATE = process.env.CC_PLUGIN_CODEX_STATE_DIR;
const ORIG_SPAWN = _internals.spawn;
const ORIG_PID_SPAWN = pidInternals.spawnSync;

function withScratch(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-worker-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = tmp;
  // Default pid-identity mock: any pid query returns a stable lstart.
  // Specific tests can override.
  pidInternals.spawnSync = (cmd, args, opts) => {
    const idx = args.indexOf("-p");
    const pid = idx >= 0 ? args[idx + 1] : null;
    if (pid && pid !== String(process.pid)) {
      return {
        status: 0,
        stdout: "Mon Apr 14 12:00:00 2026\n",
        stderr: "",
        error: null,
        signal: null,
      };
    }
    return ORIG_PID_SPAWN(cmd, args, opts);
  };
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      _internals.spawn = ORIG_SPAWN;
      pidInternals.spawnSync = ORIG_PID_SPAWN;
      if (ORIG_STATE === undefined)
        delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
      else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE;
      fs.rmSync(tmp, { recursive: true, force: true });
    });
}

function fakeChild({ exitCode = 0, signal = null, delayMs = 0 } = {}) {
  const emitter = new EventEmitter();
  const child = {
    pid: 99999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: emitter.on.bind(emitter),
    kill: () => {},
  };
  setTimeout(() => emitter.emit("exit", exitCode, signal), delayMs);
  return child;
}

function setupJob(stateRoot, jobId, spec, extraInit = {}) {
  // Mirror what the broker will do: createJob then write spec.json.
  createJob({
    job_id: jobId,
    session_id: spec.session_id,
    session_persisted: !!spec.session_id,
    worker_pid: process.pid,
    worker_lstart_raw: readLstart(process.pid),
    ...extraInit,
  });
  fs.writeFileSync(
    path.join(stateRoot, "jobs", jobId, "spec.json"),
    JSON.stringify(spec),
  );
}

test("worker: happy path → succeeded with exit_code 0", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j1", {
      argv: ["-p", "--output-format=json"],
      prompt: "hi",
      cwd: root,
      session_id: null,
    });
    _internals.spawn = () => fakeChild({ exitCode: 0 });
    await runWorker("j1");
    const s = readJobState("j1");
    assert.equal(s.state, "succeeded");
    assert.equal(s.exit_code, 0);
    assert.equal(s.exit_signal, null);
    assert.equal(s.error, null);
    assert.ok(s.ended_at_ms > 0);
  });
});

test("worker: non-zero exit → failed with non-zero-exit error", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j2", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    _internals.spawn = () => fakeChild({ exitCode: 1 });
    await runWorker("j2");
    const s = readJobState("j2");
    assert.equal(s.state, "failed");
    assert.equal(s.exit_code, 1);
    assert.equal(s.error, "non-zero-exit");
  });
});

test("worker: signal exit + cancel_requested → cancelled with exit_signal", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j3", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    // cancel during running: spawn → request cancel → emit exit signal.
    _internals.spawn = () => {
      // Defer cancel until worker has spawned.
      setImmediate(() => {
        requestCancel("j3").then(() => {});
      });
      return fakeChild({ exitCode: null, signal: "SIGTERM", delayMs: 30 });
    };
    await runWorker("j3");
    const s = readJobState("j3");
    assert.equal(s.state, "cancelled");
    assert.equal(s.exit_code, null);
    assert.equal(s.exit_signal, "SIGTERM");
    assert.equal(s.error, null);
  });
});

test("worker: signal exit WITHOUT cancel_requested → failed/killed", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j4", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    _internals.spawn = () => fakeChild({ exitCode: null, signal: "SIGKILL" });
    await runWorker("j4");
    const s = readJobState("j4");
    assert.equal(s.state, "failed");
    assert.equal(s.exit_code, null);
    assert.equal(s.exit_signal, "SIGKILL");
    assert.equal(s.error, "killed");
  });
});

test("worker: queued + cancel_requested before spawn → cancelled, no spawn", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j5", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    await requestCancel("j5");
    let spawned = false;
    _internals.spawn = () => {
      spawned = true;
      return fakeChild();
    };
    await runWorker("j5");
    const s = readJobState("j5");
    assert.equal(s.state, "cancelled");
    assert.equal(s.claude_pid, null);
    assert.equal(spawned, false);
  });
});

test("worker: missing spec.json → failed/spawn-failed", async () => {
  await withScratch(async (root) => {
    // createJob WITHOUT writing spec.json.
    createJob({
      job_id: "j6",
      session_id: null,
      session_persisted: false,
      worker_pid: process.pid,
      worker_lstart_raw: readLstart(process.pid),
    });
    let spawned = false;
    _internals.spawn = () => {
      spawned = true;
      return fakeChild();
    };
    // runWorker will process.exit(1) — wrap so test doesn't die.
    const origExit = process.exit;
    let exitCode = null;
    // @ts-ignore intentional
    process.exit = (c) => {
      exitCode = c;
      throw new Error(`__exit_${c}__`);
    };
    try {
      await runWorker("j6").catch((e) => {
        if (!/__exit_/.test(e.message)) throw e;
      });
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCode, 1);
    assert.equal(spawned, false);
    const s = readJobState("j6");
    assert.equal(s.state, "failed");
    assert.equal(s.error, "spawn-failed");
  });
});

test("worker: queued→running transition records claude_pid + lstart", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j7", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    _internals.spawn = () => fakeChild({ exitCode: 0, delayMs: 30 });
    const p = runWorker("j7");
    // Give the worker a moment to spawn and patch.
    await new Promise((r) => setTimeout(r, 15));
    const mid = readJobState("j7");
    assert.equal(mid.state, "running");
    assert.equal(mid.claude_pid, 99999);
    assert.ok(mid.started_at_ms > 0);
    await p;
    const fin = readJobState("j7");
    assert.equal(fin.state, "succeeded");
  });
});

test("worker: cancel race between queued→running spawns SIGTERM after running", async () => {
  // Simulate: cancel_requested becomes true AFTER the second pre-spawn check
  // but before patch state=running. Worker must re-check post-spawn and
  // SIGTERM the just-spawned child.
  await withScratch(async (root) => {
    setupJob(root, "race", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    let spawnedChild = null;
    _internals.spawn = () => {
      const emitter = new EventEmitter();
      const child = {
        pid: 99999,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on: emitter.on.bind(emitter),
        kill: (sig) => {
          setImmediate(() => emitter.emit("exit", null, sig ?? "SIGTERM"));
        },
      };
      spawnedChild = child;
      // Synchronously simulate the race by directly toggling
      // cancel_requested in the on-disk state.json. (Bypasses the async
      // mutex; safe in this single-process test.)
      const sp = path.join(root, "jobs", "race", "state.json");
      const cur = JSON.parse(fs.readFileSync(sp, "utf8"));
      cur.cancel_requested = true;
      fs.writeFileSync(sp, JSON.stringify(cur));
      return child;
    };
    const origKill = process.kill;
    process.kill = (pid, sig) => {
      if (pid === -99999 && spawnedChild) {
        spawnedChild.kill(sig);
        return true;
      }
      return origKill.call(process, pid, sig);
    };
    try {
      await runWorker("race");
      const s = readJobState("race");
      assert.equal(s.state, "cancelled");
      assert.equal(s.exit_signal, "SIGTERM");
    } finally {
      process.kill = origKill;
    }
  });
});

test("worker: readLstart(child) failure → kill child + finalize spawn-failed", async () => {
  await withScratch(async (root) => {
    setupJob(root, "lstart", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    // Override the default mock: fail for child pid 99999, succeed for self.
    pidInternals.spawnSync = (cmd, args, opts) => {
      const idx = args.indexOf("-p");
      const pid = idx >= 0 ? args[idx + 1] : null;
      if (pid === "99999") {
        return { status: 1, stdout: "", stderr: "", error: null, signal: null };
      }
      return ORIG_PID_SPAWN(cmd, args, opts);
    };
    let killed = null;
    _internals.spawn = () => {
      const emitter = new EventEmitter();
      const child = {
        pid: 99999,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on: emitter.on.bind(emitter),
        kill: (sig) => {
          killed = sig;
        },
      };
      return child;
    };
    const origKill = process.kill;
    process.kill = (pid, sig) => {
      if (pid === -99999) {
        killed = sig;
        return true;
      }
      return origKill.call(process, pid, sig);
    };
    try {
      await runWorker("lstart");
      const s = readJobState("lstart");
      assert.equal(s.state, "failed");
      assert.equal(s.error, "spawn-failed");
      assert.ok(killed === "SIGKILL", `expected SIGKILL, got ${killed}`);
    } finally {
      process.kill = origKill;
    }
  });
});

test("worker: spawn 'error' event → failed/spawn-failed", async () => {
  await withScratch(async (root) => {
    setupJob(root, "j8", {
      argv: ["-p"],
      prompt: "",
      cwd: root,
      session_id: null,
    });
    _internals.spawn = () => {
      const emitter = new EventEmitter();
      const child = {
        pid: 99999,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on: emitter.on.bind(emitter),
        kill: () => {},
      };
      setImmediate(() => emitter.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" })));
      return child;
    };
    await runWorker("j8");
    const s = readJobState("j8");
    assert.equal(s.state, "failed");
    assert.equal(s.error, "spawn-failed");
  });
});
