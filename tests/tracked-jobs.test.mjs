import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createJob,
  readJobState,
  finalizeJobIfNonTerminal,
  patchJobIfNonTerminal,
  requestCancel,
  TrackedJobError,
} from "../plugins/cc/scripts/lib/tracked-jobs.mjs";
import { readLstart } from "../plugins/cc/scripts/lib/pid-identity.mjs";

const ORIG_STATE = process.env.CC_PLUGIN_CODEX_STATE_DIR;

function withScratch(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-jobs-"));
  process.env.CC_PLUGIN_CODEX_STATE_DIR = tmp;
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      if (ORIG_STATE === undefined)
        delete process.env.CC_PLUGIN_CODEX_STATE_DIR;
      else process.env.CC_PLUGIN_CODEX_STATE_DIR = ORIG_STATE;
      fs.rmSync(tmp, { recursive: true, force: true });
    });
}

function baseInit(extra = {}) {
  return {
    job_id: "job-x",
    session_id: null,
    session_persisted: false,
    worker_pid: process.pid,
    worker_lstart_raw: readLstart(process.pid),
    ...extra,
  };
}

test("createJob writes a queued state.json with all required fields", async () => {
  await withScratch(() => {
    createJob(baseInit());
    const s = readJobState("job-x");
    assert.equal(s.state, "queued");
    assert.equal(s.job_id, "job-x");
    assert.equal(s.cancel_requested, false);
    assert.equal(s.claude_pid, null);
    assert.equal(s.claude_lstart_raw, null);
    assert.equal(s.exit_code, null);
    assert.equal(s.exit_signal, null);
    assert.equal(s.error, null);
    assert.equal(s.output_bytes, 0);
    assert.equal(s.session_persisted, false);
    assert.equal(typeof s.created_at_ms, "number");
    assert.equal(s.started_at_ms, null);
    assert.equal(s.ended_at_ms, null);
  });
});

test("createJob: duplicate job_id rejected", async () => {
  await withScratch(() => {
    createJob(baseInit());
    assert.throws(
      () => createJob(baseInit()),
      (err) => err instanceof TrackedJobError && err.reason === "duplicate-job",
    );
  });
});

test("patchJobIfNonTerminal: queued → running", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    const ok = await patchJobIfNonTerminal("job-x", {
      state: "running",
      started_at_ms: 1234,
      claude_pid: 9999,
      claude_lstart_raw: "Mon Apr 14 12:00:00 2026",
    });
    assert.equal(ok, true);
    const s = readJobState("job-x");
    assert.equal(s.state, "running");
    assert.equal(s.started_at_ms, 1234);
    assert.equal(s.claude_pid, 9999);
  });
});

test("patchJobIfNonTerminal: cannot set terminal state (must use finalize)", async () => {
  await withScratch(() => {
    createJob(baseInit());
    return assert.rejects(
      () =>
        patchJobIfNonTerminal("job-x", {
          state: "succeeded",
        }),
      (err) =>
        err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("patchJobIfNonTerminal: noop after job is terminal", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await finalizeJobIfNonTerminal("job-x", {
      state: "succeeded",
      exit_code: 0,
      ended_at_ms: 100,
    });
    const wrote = await patchJobIfNonTerminal("job-x", { output_bytes: 999 });
    assert.equal(wrote, false);
    const s = readJobState("job-x");
    assert.equal(s.output_bytes, 0);
    assert.equal(s.state, "succeeded");
  });
});

test("finalizeJobIfNonTerminal: valid terminal write", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    const wrote = await finalizeJobIfNonTerminal("job-x", {
      state: "succeeded",
      exit_code: 0,
      ended_at_ms: 100,
    });
    assert.equal(wrote, true);
    const s = readJobState("job-x");
    assert.equal(s.state, "succeeded");
    assert.equal(s.exit_code, 0);
    assert.equal(s.exit_signal, null);
    assert.equal(s.error, null);
    assert.equal(s.ended_at_ms, 100);
  });
});

test("finalizeJobIfNonTerminal: noop on already-terminal job", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await finalizeJobIfNonTerminal("job-x", {
      state: "succeeded",
      exit_code: 0,
      ended_at_ms: 100,
    });
    // Try to overwrite with a different terminal state — must be ignored.
    const wrote = await finalizeJobIfNonTerminal("job-x", {
      state: "cancelled",
      ended_at_ms: 200,
    });
    assert.equal(wrote, false);
    const s = readJobState("job-x");
    assert.equal(s.state, "succeeded");
    assert.equal(s.ended_at_ms, 100);
  });
});

test("finalizeJobIfNonTerminal: rejects non-terminal state", async () => {
  await withScratch(() => {
    createJob(baseInit());
    return assert.rejects(
      () =>
        finalizeJobIfNonTerminal("job-x", {
          state: "running",
          ended_at_ms: 100,
        }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("finalizeJobIfNonTerminal: rejects unknown error code", async () => {
  await withScratch(() => {
    createJob(baseInit());
    return assert.rejects(
      () =>
        finalizeJobIfNonTerminal("job-x", {
          state: "failed",
          error: "something-weird",
          ended_at_ms: 100,
        }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-error",
    );
  });
});

test("requestCancel: sets cancel_requested on non-terminal", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    const wrote = await requestCancel("job-x");
    assert.equal(wrote, true);
    assert.equal(readJobState("job-x").cancel_requested, true);
  });
});

test("requestCancel: idempotent (second call returns false)", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await requestCancel("job-x");
    const second = await requestCancel("job-x");
    assert.equal(second, false);
  });
});

test("requestCancel: noop on terminal job", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await finalizeJobIfNonTerminal("job-x", {
      state: "succeeded",
      exit_code: 0,
      ended_at_ms: 100,
    });
    const wrote = await requestCancel("job-x");
    assert.equal(wrote, false);
    assert.equal(readJobState("job-x").cancel_requested, false);
  });
});

test("readJobState returns null for unknown job", async () => {
  await withScratch(() => {
    assert.equal(readJobState("nope"), null);
  });
});

test("concurrent finalize + patch: terminal state preserved (no lost update)", async () => {
  // Without the per-job mutex, two RMWs could race: both read "running",
  // patch tries to add output_bytes, finalize wants to set "succeeded".
  // The interleaving might overwrite the terminal state with the patch.
  await withScratch(async () => {
    createJob(baseInit());
    await patchJobIfNonTerminal("job-x", {
      state: "running",
      started_at_ms: 1,
      claude_pid: 9999,
      claude_lstart_raw: "x",
    });
    // Fire many in parallel.
    const promises = [];
    promises.push(
      finalizeJobIfNonTerminal("job-x", {
        state: "succeeded",
        exit_code: 0,
        ended_at_ms: 100,
      }),
    );
    for (let i = 0; i < 20; i++) {
      promises.push(
        patchJobIfNonTerminal("job-x", { output_bytes: i + 1 }),
      );
    }
    await Promise.all(promises);
    const s = readJobState("job-x");
    assert.equal(s.state, "succeeded");
    assert.equal(s.exit_code, 0);
    assert.equal(s.ended_at_ms, 100);
  });
});

test("createJob populates worker pid and lstart correctly", async () => {
  await withScratch(() => {
    createJob(baseInit());
    const s = readJobState("job-x");
    assert.equal(s.worker_pid, process.pid);
    assert.equal(s.worker_lstart_raw, readLstart(process.pid));
  });
});

test("createJob: rejects bad worker_pid / worker_lstart_raw / session_persisted", async () => {
  await withScratch(() => {
    assert.throws(
      () => createJob(baseInit({ worker_pid: -1 })),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    assert.throws(
      () => createJob(baseInit({ worker_lstart_raw: "" })),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    assert.throws(
      () => createJob(baseInit({ session_persisted: "yes" })),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    assert.throws(
      () => createJob(baseInit({ session_id: 42 })),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("readJobState: corrupt / missing fields → null", async () => {
  await withScratch(async (root) => {
    createJob(baseInit());
    // Replace state.json with one missing required fields.
    const sp = path.join(root, "jobs", "job-x", "state.json");
    fs.writeFileSync(sp, JSON.stringify({ job_id: "job-x", state: "queued" }));
    assert.equal(readJobState("job-x"), null);
    // Wrong type for output_bytes.
    fs.writeFileSync(
      sp,
      JSON.stringify({
        job_id: "job-x",
        state: "queued",
        session_id: null,
        session_persisted: false,
        worker_pid: 1,
        worker_lstart_raw: "x",
        claude_pid: null,
        claude_lstart_raw: null,
        cancel_requested: false,
        created_at_ms: 1,
        started_at_ms: null,
        ended_at_ms: null,
        exit_code: null,
        exit_signal: null,
        error: null,
        output_bytes: "many", // wrong type
      }),
    );
    assert.equal(readJobState("job-x"), null);
  });
});

test("patchJobIfNonTerminal: rejects non-whitelisted fields", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { worker_pid: 999 }),
      (err) =>
        err instanceof TrackedJobError &&
        err.reason === "invalid-args" &&
        /worker_pid/.test(err.message),
    );
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { exit_code: 0 }),
      (err) =>
        err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { error: "timeout" }),
      (err) =>
        err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("createJob: concurrent first-callers, loser gets duplicate-job (not raw EEXIST)", async () => {
  await withScratch(async () => {
    // Fire many concurrent createJob with the same job_id from a fresh
    // state dir (jobs/ doesn't exist yet). Exactly one should win;
    // the rest must throw TrackedJobError("duplicate-job").
    const inits = Array.from({ length: 10 }, () => baseInit({ job_id: "race" }));
    const results = await Promise.allSettled(
      inits.map((i) => Promise.resolve().then(() => createJob(i))),
    );
    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");
    assert.equal(successes.length, 1);
    for (const f of failures) {
      assert.ok(
        f.reason instanceof TrackedJobError &&
          f.reason.reason === "duplicate-job",
        `expected duplicate-job, got ${f.reason?.reason ?? f.reason?.code}`,
      );
    }
  });
});

test("patchJobIfNonTerminal: rejects bad claude_pid type / output_bytes", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { claude_pid: -1 }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { claude_pid: 1.5 }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { output_bytes: "many" }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("patchJobIfNonTerminal: queued→running rejected without claude pid + lstart + started_at", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await assert.rejects(
      () => patchJobIfNonTerminal("job-x", { state: "running" }),
      (err) =>
        err instanceof TrackedJobError &&
        err.reason === "invalid-running-transition",
    );
    await assert.rejects(
      () =>
        patchJobIfNonTerminal("job-x", {
          state: "running",
          claude_pid: 1234,
          // missing claude_lstart_raw and started_at_ms
        }),
      (err) =>
        err instanceof TrackedJobError &&
        err.reason === "invalid-running-transition",
    );
    // Complete patch should succeed.
    const ok = await patchJobIfNonTerminal("job-x", {
      state: "running",
      started_at_ms: Date.now(),
      claude_pid: 1234,
      claude_lstart_raw: "x",
    });
    assert.equal(ok, true);
  });
});

test("finalizeJobIfNonTerminal: exit_code and exit_signal are mutually exclusive", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await assert.rejects(
      () =>
        finalizeJobIfNonTerminal("job-x", {
          state: "failed",
          exit_code: 1,
          exit_signal: "SIGTERM",
          ended_at_ms: 100,
        }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});

test("finalizeJobIfNonTerminal: succeeded enforces exit_code=0/signal=null/error=null", async () => {
  await withScratch(async () => {
    createJob(baseInit());
    await assert.rejects(
      () =>
        finalizeJobIfNonTerminal("job-x", {
          state: "succeeded",
          exit_code: 1,
          ended_at_ms: 100,
        }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
    await assert.rejects(
      () =>
        finalizeJobIfNonTerminal("job-x", {
          state: "succeeded",
          exit_code: 0,
          error: "something",
          ended_at_ms: 100,
        }),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-error",
    );
  });
});

test("invalid job_id rejected by createJob", async () => {
  await withScratch(() => {
    assert.throws(
      () => createJob(baseInit({ job_id: "" })),
      (err) => err instanceof TrackedJobError && err.reason === "invalid-args",
    );
  });
});
