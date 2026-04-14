import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClaudeFlags,
  validateAddDirs,
  PermissionError,
} from "../plugins/cc/scripts/lib/permission.mjs";

const ORIG_STATE_DIR = process.env.CC_PLUGIN_CODEX_STATE_DIR;
function withStateDir(path, fn) {
  process.env.CC_PLUGIN_CODEX_STATE_DIR = path;
  try {
    return fn();
  } finally {
    if (ORIG_STATE_DIR === undefined)
      delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
    else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE_DIR;
  }
}

test("buildClaudeFlags: plan mode emits read-only tools + base flags", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
    });
    assert.deepEqual(flags.slice(0, 3), [
      "-p",
      "--strict-mcp-config",
      "--output-format=json",
    ]);
    assert.ok(!flags.includes("--bare"), "--bare must NOT be set (subscription support)");
    assert.ok(flags.includes("--permission-mode=plan"));
    const toolsIdx = flags.indexOf("--tools");
    assert.equal(flags[toolsIdx + 1], "Read,Grep,Glob");
    const addIdx = flags.indexOf("--add-dir");
    assert.equal(flags[addIdx + 1], fs.realpathSync("/tmp") + "/work");
    assert.ok(flags.includes("--no-session-persistence"));
  });
});

test("buildClaudeFlags: writes mode emits edit tools + acceptEdits", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "writes",
      cwd: "/tmp/work",
    });
    assert.ok(flags.includes("--permission-mode=acceptEdits"));
    const toolsIdx = flags.indexOf("--tools");
    assert.equal(flags[toolsIdx + 1], "Read,Edit,Write,Grep,Glob");
  });
});

test("buildClaudeFlags: session_id with useResume=true prepends --resume", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
      session_id: "abc-123",
    });
    const idx = flags.indexOf("--resume");
    assert.equal(flags[idx + 1], "abc-123");
    assert.ok(!flags.includes("--no-session-persistence"));
  });
});

test("buildClaudeFlags: session_id with useResume=false emits --session-id", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
      session_id: "abc-123",
      useResume: false,
    });
    const idx = flags.indexOf("--session-id");
    assert.equal(flags[idx + 1], "abc-123");
    assert.ok(!flags.includes("--resume"));
  });
});

test("buildClaudeFlags: no session_id → --no-session-persistence", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
    });
    assert.ok(flags.includes("--no-session-persistence"));
  });
});

test("buildClaudeFlags: schema injected as --json-schema with JSON string", () => {
  withStateDir("/tmp/state", () => {
    const schema = { type: "object" };
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
      schema,
    });
    const idx = flags.indexOf("--json-schema");
    assert.equal(flags[idx + 1], JSON.stringify(schema));
  });
});

test("buildClaudeFlags: add_dirs appended as multiple --add-dir", () => {
  withStateDir("/tmp/state", () => {
    const flags = buildClaudeFlags({
      permission: "plan",
      cwd: "/tmp/work",
      add_dirs: ["/tmp/a", "/tmp/b"],
    });
    const addDirs = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--add-dir") addDirs.push(flags[i + 1]);
    }
    const tmp = fs.realpathSync("/tmp");
    assert.deepEqual(addDirs, [`${tmp}/work`, `${tmp}/a`, `${tmp}/b`]);
  });
});

test("buildClaudeFlags: invalid permission level rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "shell",
          cwd: "/tmp/work",
        }),
      (err) => err instanceof PermissionError && err.reason === "invalid-permission",
    );
  });
});

test("buildClaudeFlags: non-absolute cwd rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () => buildClaudeFlags({ permission: "plan", cwd: "relative/work" }),
      (err) => err instanceof PermissionError && err.reason === "invalid-cwd",
    );
  });
});

test("buildClaudeFlags: cwd inside $STATE_DIR rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "plan",
          cwd: "/tmp/state/sessions",
        }),
      (err) => err instanceof PermissionError && err.reason === "forbidden-add-dir",
    );
  });
});

test("validateAddDirs: empty array → empty array", () => {
  assert.deepEqual(validateAddDirs([]), []);
  assert.deepEqual(validateAddDirs(undefined), []);
  assert.deepEqual(validateAddDirs(null), []);
});

test("validateAddDirs: non-array rejected", () => {
  assert.throws(
    () => validateAddDirs("string"),
    (err) => err instanceof PermissionError && err.reason === "invalid-add-dirs",
  );
});

test("validateAddDirs: relative path rejected", () => {
  assert.throws(
    () => validateAddDirs(["relative/dir"]),
    (err) => err instanceof PermissionError && err.reason === "invalid-add-dirs",
  );
});

test("validateAddDirs: path inside $STATE_DIR rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () => validateAddDirs(["/tmp/state/sessions"]),
      (err) =>
        err instanceof PermissionError && err.reason === "forbidden-add-dir",
    );
  });
});

test("buildClaudeFlags: add_dir entry inside $STATE_DIR rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "plan",
          cwd: "/tmp/work",
          add_dirs: ["/tmp/state/leak"],
        }),
      (err) =>
        err instanceof PermissionError && err.reason === "forbidden-add-dir",
    );
  });
});

test("buildClaudeFlags: symlink pointing into $STATE_DIR is rejected", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-symlink-"));
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const linkPath = path.join(tmpRoot, "innocent-looking-link");
  fs.symlinkSync(stateDir, linkPath);
  try {
    withStateDir(stateDir, () => {
      // cwd via symlink → must reject
      assert.throws(
        () =>
          buildClaudeFlags({
            permission: "plan",
            cwd: linkPath,
          }),
        (err) =>
          err instanceof PermissionError && err.reason === "forbidden-add-dir",
      );
      // add_dirs via symlink → must reject
      assert.throws(
        () =>
          buildClaudeFlags({
            permission: "plan",
            cwd: tmpRoot,
            add_dirs: [linkPath],
          }),
        (err) =>
          err instanceof PermissionError && err.reason === "forbidden-add-dir",
      );
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("validateAddDirs: empty object/array schema rejected", () => {
  withStateDir("/tmp/state", () => {
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "plan",
          cwd: "/tmp/work",
          schema: {},
        }),
      (err) => err instanceof PermissionError && err.reason === "invalid-schema",
    );
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "plan",
          cwd: "/tmp/work",
          schema: [],
        }),
      (err) => err instanceof PermissionError && err.reason === "invalid-schema",
    );
    assert.throws(
      () =>
        buildClaudeFlags({
          permission: "plan",
          cwd: "/tmp/work",
          schema: false,
        }),
      (err) => err instanceof PermissionError && err.reason === "invalid-schema",
    );
  });
});

test("buildClaudeFlags: realpath-resolved cwd appears in --add-dir", () => {
  const tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-realcwd-")),
  );
  const realDir = path.join(tmpRoot, "actual");
  fs.mkdirSync(realDir, { recursive: true });
  const linkDir = path.join(tmpRoot, "link");
  fs.symlinkSync(realDir, linkDir);
  try {
    withStateDir(path.join(tmpRoot, "state-elsewhere"), () => {
      const flags = buildClaudeFlags({
        permission: "plan",
        cwd: linkDir,
      });
      const idx = flags.indexOf("--add-dir");
      // Should emit the realpath target, not the symlink source.
      assert.equal(flags[idx + 1], realDir);
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
