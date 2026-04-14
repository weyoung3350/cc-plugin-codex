import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import {
  stateRoot,
  sessionsDir,
  jobsDir,
  sessionLockPath,
  jobDir,
  ackFlagPath,
  isUnderStateDir,
  isPlatformSupported,
} from "../plugins/cc/scripts/lib/xdg.mjs";

const ORIG_XDG = process.env.XDG_STATE_HOME;
const ORIG_OVERRIDE = process.env.CC_PLUGIN_CODEX_STATE_DIR;
const ORIG_HOME = process.env.HOME;

function restoreEnv() {
  if (ORIG_XDG === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIG_XDG;
  if (ORIG_OVERRIDE === undefined) delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
  else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_OVERRIDE;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
}

test("stateRoot: absolute override wins", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/tmp/ccpc-test-override";
    assert.equal(stateRoot(), "/tmp/ccpc-test-override");
  } finally {
    restoreEnv();
  }
});

test("stateRoot: relative override is ignored", () => {
  try {
    delete process.env.XDG_STATE_HOME;
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "relative-should-be-ignored";
    process.env.HOME = "/home/alice";
    assert.equal(
      stateRoot(),
      path.join("/home/alice", ".local", "state", "cc-plugin-codex"),
    );
  } finally {
    restoreEnv();
  }
});

test("stateRoot: XDG_STATE_HOME absolute used when no override", () => {
  try {
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
    process.env.XDG_STATE_HOME = "/var/state";
    assert.equal(stateRoot(), "/var/state/cc-plugin-codex");
  } finally {
    restoreEnv();
  }
});

test("stateRoot: relative XDG_STATE_HOME ignored", () => {
  try {
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
    process.env.XDG_STATE_HOME = "relative";
    process.env.HOME = "/home/alice";
    assert.equal(
      stateRoot(),
      path.join("/home/alice", ".local", "state", "cc-plugin-codex"),
    );
  } finally {
    restoreEnv();
  }
});

test("stateRoot: default to $HOME/.local/state", () => {
  try {
    delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/alice";
    assert.equal(
      stateRoot(),
      path.join("/home/alice", ".local", "state", "cc-plugin-codex"),
    );
  } finally {
    restoreEnv();
  }
});

test("sessionsDir / jobsDir", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/tmp/ccpc-x";
    assert.equal(sessionsDir(), "/tmp/ccpc-x/sessions");
    assert.equal(jobsDir(), "/tmp/ccpc-x/jobs");
  } finally {
    restoreEnv();
  }
});

test("sessionLockPath / jobDir: ID validation", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/tmp/ccpc-x";
    assert.equal(
      sessionLockPath("abc-123"),
      "/tmp/ccpc-x/sessions/abc-123.lock",
    );
    assert.equal(jobDir("job_42"), "/tmp/ccpc-x/jobs/job_42");

    assert.throws(() => sessionLockPath(".."), /invalid sessionId/);
    assert.throws(() => sessionLockPath("a/b"), /invalid sessionId/);
    assert.throws(() => sessionLockPath(""), /invalid sessionId/);
    assert.throws(() => jobDir("../etc"), /invalid jobId/);
  } finally {
    restoreEnv();
  }
});

test("ackFlagPath: workspaceRoot must be absolute", () => {
  assert.equal(
    ackFlagPath("/repo/foo"),
    "/repo/foo/.cc-plugin-codex/allow_writes_acknowledged.flag",
  );
  assert.throws(() => ackFlagPath("relative/workspace"), /absolute/);
});

test("isUnderStateDir: root itself is inside", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/state";
    assert.equal(isUnderStateDir("/state"), true);
    assert.equal(isUnderStateDir("/state/"), true);
  } finally {
    restoreEnv();
  }
});

test("isUnderStateDir: normal descendants true", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/state";
    assert.equal(isUnderStateDir("/state/sessions"), true);
    assert.equal(isUnderStateDir("/state/jobs/abc/state.json"), true);
  } finally {
    restoreEnv();
  }
});

test("isUnderStateDir: sibling/outside false", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/state";
    assert.equal(isUnderStateDir("/other"), false);
    assert.equal(isUnderStateDir("/statex"), false);
    assert.equal(isUnderStateDir("/"), false);
    assert.equal(isUnderStateDir("/foo/state"), false);
  } finally {
    restoreEnv();
  }
});

test("isUnderStateDir: ..foo is a descendant, not an escape", () => {
  try {
    process.env.CC_PLUGIN_CODEX_STATE_DIR = "/state";
    // Legitimate: a child literally named "..foo" lives under /state.
    assert.equal(isUnderStateDir("/state/..foo"), true);
    assert.equal(isUnderStateDir("/state/..foo/bar"), true);
  } finally {
    restoreEnv();
  }
});

test("isPlatformSupported", () => {
  const p = process.platform;
  const expected = p === "darwin" || p === "linux";
  assert.equal(isPlatformSupported(), expected);
});
