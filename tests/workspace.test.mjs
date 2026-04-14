import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectWorkspaceRoot,
  ackFlagExists,
  writeAckFlag,
  _internals,
} from "../plugins/cc/scripts/lib/workspace.mjs";

const ORIG_SPAWN = _internals.spawnSync;
function restore() {
  _internals.spawnSync = ORIG_SPAWN;
}

test("detectWorkspaceRoot: git toplevel wins when git succeeds", () => {
  try {
    const realRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ws-")),
    );
    const sub = path.join(realRoot, "deep", "nested");
    fs.mkdirSync(sub, { recursive: true });
    _internals.spawnSync = () => ({
      status: 0,
      stdout: realRoot + "\n",
      stderr: "",
      error: null,
      signal: null,
    });
    const got = detectWorkspaceRoot(sub);
    assert.equal(got, realRoot);
    fs.rmSync(realRoot, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("detectWorkspaceRoot: git failure falls back to cwd", () => {
  try {
    const real = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ws-")),
    );
    _internals.spawnSync = () => ({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      error: null,
      signal: null,
    });
    const got = detectWorkspaceRoot(real);
    assert.equal(got, real);
    fs.rmSync(real, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("detectWorkspaceRoot: git spawn throws → cwd fallback", () => {
  try {
    const real = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ws-")),
    );
    _internals.spawnSync = () => {
      throw new Error("git not on PATH");
    };
    const got = detectWorkspaceRoot(real);
    assert.equal(got, real);
    fs.rmSync(real, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("detectWorkspaceRoot: relative cwd rejected", () => {
  assert.throws(() => detectWorkspaceRoot("relative/path"), /absolute/);
});

test("detectWorkspaceRoot: symlinked workdir realpath'd to true root", () => {
  try {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-wsl-")),
    );
    const realRoot = path.join(tmp, "real");
    fs.mkdirSync(realRoot, { recursive: true });
    const link = path.join(tmp, "link");
    fs.symlinkSync(realRoot, link);
    _internals.spawnSync = () => ({
      status: 0,
      stdout: link + "\n",
      stderr: "",
      error: null,
      signal: null,
    });
    const got = detectWorkspaceRoot(link);
    assert.equal(got, realRoot, "symlink must be realpath'd");
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("ackFlagExists / writeAckFlag round-trip", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ackstate-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ack-")),
  );
  try {
    assert.equal(ackFlagExists(root), false);
    const flagPath = writeAckFlag(root);
    // Lives in $STATE_DIR/ack/<hash>.json, NOT inside the workspace.
    assert.ok(flagPath.startsWith(stateDir));
    assert.ok(flagPath.includes("/ack/"));
    assert.ok(flagPath.endsWith(".json"));
    assert.equal(ackFlagExists(root), true);
    const second = writeAckFlag(root);
    assert.equal(second, flagPath);
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf8"));
    assert.equal(typeof parsed.acknowledged_at_ms, "number");
    assert.equal(parsed.workspace_root, root);
    assert.equal(parsed.acknowledged_by_pid, process.pid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("ackFlagExists rejects pre-existing workspace-internal file (cannot bypass)", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ackbypass-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-bypass-")),
  );
  try {
    // Hostile: try to plant a file inside the workspace at the OLD path.
    fs.mkdirSync(path.join(root, ".cc-plugin-codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cc-plugin-codex/allow_writes_acknowledged.flag"),
      "anything",
    );
    // ackFlagExists must NOT see this — the real path is in $STATE_DIR.
    assert.equal(ackFlagExists(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("ackFlagExists: different workspaces hash to different slots (no leakage)", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ackmm-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-A-")));
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-B-")));
  try {
    writeAckFlag(rootA);
    assert.equal(ackFlagExists(rootB), false);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("ackFlagExists: rejects flag whose workspace_root field doesn't match", () => {
  // Direct attack on the same hash slot: write a file whose payload
  // claims a DIFFERENT workspace_root. ackFlagExists must reject it.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ackpayload-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-payload-")),
  );
  try {
    // Write a "real" flag for root, then deliberately rewrite the
    // payload to point at a different workspace_root.
    writeAckFlag(root);
    const flagPath = path.join(
      stateDir,
      "ack",
      fs.readdirSync(path.join(stateDir, "ack"))[0],
    );
    fs.writeFileSync(
      flagPath,
      JSON.stringify({
        acknowledged_at_ms: Date.now(),
        acknowledged_by_pid: 1,
        workspace_root: "/some/other/workspace",
      }),
    );
    assert.equal(
      ackFlagExists(root),
      false,
      "must reject when workspace_root field mismatches",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("writeAckFlag is true-noop on second call: payload unchanged", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-noopstate-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ack-")),
  );
  try {
    const flag = writeAckFlag(root);
    const first = fs.readFileSync(flag, "utf8");
    const firstParsed = JSON.parse(first);
    assert.equal(firstParsed.acknowledged_by_pid, process.pid);
    // Sleep a tick so any non-noop write would flip acknowledged_at_ms.
    const start = firstParsed.acknowledged_at_ms;
    while (Date.now() === start) {
      // busy-wait one ms tick
    }
    const flag2 = writeAckFlag(root);
    assert.equal(flag2, flag);
    const second = fs.readFileSync(flag, "utf8");
    assert.equal(second, first, "second write must not change payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("ackFlagExists / writeAckFlag normalise symlinked workspace_root", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-acksymst-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-acksym-")),
  );
  try {
    const realRoot = path.join(tmp, "real");
    fs.mkdirSync(realRoot, { recursive: true });
    const link = path.join(tmp, "link");
    fs.symlinkSync(realRoot, link);
    writeAckFlag(link);
    // Both forms hash to the same key (because both realpath to realRoot).
    assert.equal(ackFlagExists(realRoot), true);
    assert.equal(ackFlagExists(link), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});

test("writeAckFlag creates parent ack/ dir if missing", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-mkparent-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = stateDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-ack-")),
  );
  try {
    const flag = writeAckFlag(root);
    assert.ok(fs.existsSync(path.dirname(flag)));
    assert.ok(flag.includes("/ack/"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  }
});
