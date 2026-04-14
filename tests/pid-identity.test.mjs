import test from "node:test";
import assert from "node:assert/strict";

import {
  readLstart,
  sameIdentity,
  isAlive,
  _internals,
} from "../plugins/cc/scripts/lib/pid-identity.mjs";

const ORIG_SPAWN = _internals.spawnSync;
const ORIG_KILL = _internals.kill;
function restore() {
  _internals.spawnSync = ORIG_SPAWN;
  _internals.kill = ORIG_KILL;
}

test("readLstart(own pid) returns a non-empty string", () => {
  const s = readLstart(process.pid);
  assert.equal(typeof s, "string");
  assert.ok(s && s.length > 0);
});

test("readLstart: invalid pid returns null", () => {
  assert.equal(readLstart(0), null);
  assert.equal(readLstart(-1), null);
  assert.equal(readLstart(1.5), null);
  assert.equal(readLstart(NaN), null);
  assert.equal(readLstart("abc"), null);
});

test("readLstart: very large non-existent pid returns null", () => {
  // Picking 2_000_000+ is extremely unlikely to collide on Darwin/Linux.
  const ghost = 2_147_483_646;
  assert.equal(readLstart(ghost), null);
});

test("sameIdentity(self, currentLstart) === true", () => {
  const lstart = readLstart(process.pid);
  assert.ok(lstart, "own lstart should be readable");
  assert.equal(sameIdentity(process.pid, lstart), true);
});

test("sameIdentity with stale string returns false (PID reuse defense)", () => {
  const bogus = "Wed Jan  1 00:00:00 2000";
  assert.equal(sameIdentity(process.pid, bogus), false);
});

test("sameIdentity: empty/invalid lstart_raw returns false", () => {
  assert.equal(sameIdentity(process.pid, ""), false);
  // @ts-expect-error intentional
  assert.equal(sameIdentity(process.pid, null), false);
  // @ts-expect-error intentional
  assert.equal(sameIdentity(process.pid, undefined), false);
});

test("sameIdentity: non-existent pid returns false", () => {
  assert.equal(sameIdentity(2_147_483_646, "anything"), false);
});

test("isAlive(self) === true", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive: non-existent pid returns false", () => {
  assert.equal(isAlive(2_147_483_646), false);
});

test("isAlive: invalid inputs return false", () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(1.5), false);
});

test("readLstart: LC_ALL=C is injected into ps env", () => {
  try {
    let capturedEnv = null;
    _internals.spawnSync = (cmd, args, opts) => {
      capturedEnv = opts?.env;
      return { status: 0, stdout: "Mon Apr 14 12:00:00 2026\n", error: null };
    };
    readLstart(12345);
    assert.equal(capturedEnv.LC_ALL, "C");
  } finally {
    restore();
  }
});

test("readLstart: non-zero ps exit returns null", () => {
  try {
    _internals.spawnSync = () => ({ status: 1, stdout: "", error: null });
    assert.equal(readLstart(12345), null);
  } finally {
    restore();
  }
});

test("readLstart: empty stdout returns null", () => {
  try {
    _internals.spawnSync = () => ({ status: 0, stdout: "   \n", error: null });
    assert.equal(readLstart(12345), null);
  } finally {
    restore();
  }
});

test("readLstart: spawnSync throws returns null", () => {
  try {
    _internals.spawnSync = () => {
      throw new Error("forbidden");
    };
    assert.equal(readLstart(12345), null);
  } finally {
    restore();
  }
});

test("readLstart: preserves leading whitespace in ps output", () => {
  try {
    _internals.spawnSync = () => ({
      status: 0,
      stdout: "  Mon Apr 14 12:00:00 2026\n",
      error: null,
    });
    // Leading spaces should be kept (only trailing whitespace stripped).
    assert.equal(readLstart(12345), "  Mon Apr 14 12:00:00 2026");
  } finally {
    restore();
  }
});

test("isAlive: EPERM is treated as alive", () => {
  try {
    const err = new Error("not permitted");
    err.code = "EPERM";
    _internals.kill = () => {
      throw err;
    };
    assert.equal(isAlive(12345), true);
  } finally {
    restore();
  }
});

test("isAlive: ESRCH is treated as not alive", () => {
  try {
    const err = new Error("no such process");
    err.code = "ESRCH";
    _internals.kill = () => {
      throw err;
    };
    assert.equal(isAlive(12345), false);
  } finally {
    restore();
  }
});

test("isAlive: unknown errno is treated as not alive (conservative)", () => {
  try {
    const err = new Error("boom");
    err.code = "EIO";
    _internals.kill = () => {
      throw err;
    };
    assert.equal(isAlive(12345), false);
  } finally {
    restore();
  }
});
