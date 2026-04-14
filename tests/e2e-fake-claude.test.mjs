// Real-spawn fixture tests for runClaude / probeHealth.
//
// Earlier *.test.mjs files mock runInternals.spawn to inject fake
// children. These tests instead let runClaude / probeHealth call the
// REAL child_process.spawn — but PATH-shadow `claude` with our fixture
// so they don't need a working Claude install. They cover the spawn /
// stdin / wait-for-exit / JSON-envelope-parse round-trip end-to-end at
// the lib/ layer.
//
// They do NOT exercise the broker MCP layer (those are in broker.test.mjs
// where mocking gives precise control over timing). Treat this file as
// "lib-level e2e": runClaude / probeHealth → real spawn → fixture.
//
// Maps to DESIGN.md checkpoints (lib-layer round-trips):
//   * spawn → fixture → JSON envelope parsed
//   * --resume miss + fallback to --session-id (session protocol)
//   * "Credit balance is too low" diagnostic in health probe
//   * "Please log in" diagnostic in health probe
//   * structured review JSON happy path + invalid verdict
//   * fake hang for timeout-budget exercise
//
// Other DESIGN checkpoints (concurrency, stale reclaim, orphan sweep,
// base64 pagination, cancel pid identity) are covered by unit tests in
// their respective *.test.mjs files.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaude } from "../plugins/cc/scripts/lib/claude-run.mjs";
import { probeHealth, _setCached } from "../plugins/cc/scripts/lib/health.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "fake-claude-fixture.mjs");

/**
 * Make our fixture look like `claude` on PATH for the duration of fn.
 * We create a tmpdir, symlink fixture → tmpdir/claude, prepend to PATH.
 */
async function withFakeClaudeOnPath(fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-fakebin-"));
  const linkPath = path.join(binDir, "claude");
  // Use a wrapper script (not symlink) so shebang resolves cleanly.
  fs.writeFileSync(
    linkPath,
    `#!/bin/sh\nexec /usr/bin/env node "${FIXTURE}" "$@"\n`,
    { mode: 0o755 },
  );
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test("e2e: real spawn → fake claude → success envelope parsed", async () => {
  await withFakeClaudeOnPath(async () => {
    const res = await runClaude({
      flags: ["-p", "--output-format=json"],
      prompt: "fake:succeed:hello world",
      timeoutMs: 5000,
      graceMs: 200,
    });
    assert.equal(res.error, null);
    assert.equal(res.exit_code, 0);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.result, "hello world");
  });
});

test("e2e: --resume miss → broker fallback to --session-id succeeds", async () => {
  await withFakeClaudeOnPath(async () => {
    const res = await runClaude({
      flags: ["-p", "--output-format=json", "--resume", "test-uuid-abc"],
      prompt: "fake:session-resume-miss",
      timeoutMs: 5000,
      graceMs: 200,
    });
    assert.equal(res.error, null);
    assert.equal(res.resume_retried, true);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.result, "created-via-fallback");
  });
});

test("e2e: --resume + --session-id both fail → propagate nonzero", async () => {
  await withFakeClaudeOnPath(async () => {
    const res = await runClaude({
      flags: ["-p", "--output-format=json", "--resume", "test-uuid-xyz"],
      prompt: "fake:session-resume-fail",
      timeoutMs: 5000,
      graceMs: 200,
    });
    assert.equal(res.error, "nonzero");
    assert.equal(res.resume_retried, true);
    assert.match(res.stderr, /No conversation found/);
  });
});

test("e2e: real claude --version → health.installed=true with version parsed", async () => {
  await withFakeClaudeOnPath(async () => {
    _setCached(null);
    const s = probeHealth();
    assert.equal(s.installed, true);
    assert.equal(s.version, "2.1.107");
    assert.equal(s.platform_supported, true);
    assert.equal(s.authenticated, true);
  });
});

test("e2e: Credit balance is too low → health surfaces credit-exhausted", async () => {
  // For this we need the fake to BOTH respond to --version AND to the
  // probe with credit-exhausted. The probe uses prompt "ok" so we
  // override that mapping at the fixture level — simplest approach is
  // a wrapper that intercepts the probe prompt.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-credbin-"));
  const wrapperPath = path.join(binDir, "claude");
  // The wrapper rewrites the stdin prompt to "fake:credit-exhausted"
  // before forwarding to the fixture.
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh\necho "fake:credit-exhausted" | /usr/bin/env node "${FIXTURE}" "$@" < /dev/null\n`,
    { mode: 0o755 },
  );
  // For --version we need the real fixture path, but our wrapper forces
  // every call into credit-exhausted; that's fine — health doesn't care
  // about --version's stdout content beyond regex-matching a version.
  // Simpler: write a wrapper that handles --version explicitly.
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh
case " $* " in
  *" --version "*) /usr/bin/env node "${FIXTURE}" --version ;;
  *) echo "fake:credit-exhausted" | /usr/bin/env node "${FIXTURE}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    _setCached(null);
    const s = probeHealth();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.includes("credit-exhausted"));
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    _setCached(null);
  }
});

test("e2e: real spawn returns valid review JSON parseable by validateReviewOutput", async () => {
  const { validateReviewOutput } = await import(
    "../plugins/cc/scripts/lib/review-schema.mjs"
  );
  const { parseClaudeJson } = await import(
    "../plugins/cc/scripts/lib/claude-run.mjs"
  );
  await withFakeClaudeOnPath(async () => {
    const res = await runClaude({
      flags: ["-p", "--output-format=json", "--json-schema", "{}"],
      prompt: "fake:review-valid",
      timeoutMs: 5000,
      graceMs: 200,
    });
    assert.equal(res.error, null);
    const parsedEnv = parseClaudeJson(res.text);
    const reviewObj = JSON.parse(parsedEnv.result);
    // Should pass strict validation.
    validateReviewOutput(reviewObj);
    assert.equal(reviewObj.verdict, "needs-attention");
    assert.equal(reviewObj.findings.length, 1);
  });
});

test("e2e: invalid review verdict → broker-side validateReviewOutput throws", async () => {
  const { validateReviewOutput, ReviewValidationError } = await import(
    "../plugins/cc/scripts/lib/review-schema.mjs"
  );
  const { parseClaudeJson } = await import(
    "../plugins/cc/scripts/lib/claude-run.mjs"
  );
  await withFakeClaudeOnPath(async () => {
    const res = await runClaude({
      flags: ["-p", "--output-format=json", "--json-schema", "{}"],
      prompt: "fake:review-invalid-verdict",
      timeoutMs: 5000,
      graceMs: 200,
    });
    const parsedEnv = parseClaudeJson(res.text);
    const reviewObj = JSON.parse(parsedEnv.result);
    assert.throws(
      () => validateReviewOutput(reviewObj),
      (err) =>
        err instanceof ReviewValidationError && err.field === "verdict",
    );
  });
});

test("e2e: fake:hang triggers timeout error within budget", async () => {
  await withFakeClaudeOnPath(async () => {
    const start = Date.now();
    const res = await runClaude({
      flags: ["-p", "--output-format=json"],
      prompt: "fake:hang:5000",
      timeoutMs: 200,
      graceMs: 50,
    });
    const elapsed = Date.now() - start;
    assert.equal(res.error, "timeout");
    // Should not wait the full 5 s; budget plus grace.
    assert.ok(elapsed < 1500, `expected timeout fast, took ${elapsed}ms`);
  });
});

test("e2e: 'please log in' result → health surfaces auth-required", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-authbin-"));
  const wrapperPath = path.join(binDir, "claude");
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh
case " $* " in
  *" --version "*) /usr/bin/env node "${FIXTURE}" --version ;;
  *) echo "fake:auth-required" | /usr/bin/env node "${FIXTURE}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    _setCached(null);
    const s = probeHealth();
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, false);
    assert.ok(s.warnings.includes("auth-required"));
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    _setCached(null);
  }
});
