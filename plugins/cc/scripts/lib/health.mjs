// Health probe for the local Claude Code CLI.
//
// Contract (docs/DESIGN.md):
//   - Probe on broker startup; cache result in-process.
//   - Probe Claude using the same flags as real claude_ask calls, so a
//     successful probe is a strong predicate for real calls working.
//   - Report: installed / version / authenticated / api_key_source /
//     platform_supported / warnings[] / checked_at_ms.
//   - Non-claude_health tools MUST gate on assertHealthy().
//   - claude_health({ refresh: true }) triggers a reprobe. No TTL.
//
// Auth model (post-`--bare` removal):
//   We do NOT force any auth path. Whichever auth Claude resolves on its
//   own — OAuth keychain (subscription) OR ANTHROPIC_API_KEY OR
//   apiKeyHelper — counts as "authenticated". `api_key_source` is best-
//   effort metadata: "env" if $ANTHROPIC_API_KEY is set, "helper" if
//   ~/.claude/settings.json carries apiKeyHelper, "oauth" if neither but
//   the live probe still succeeds (implying keychain auth), else null.
//
// Failure detection:
//   - status=0 + JSON envelope without is_error  → fully healthy
//   - status!=0 + JSON envelope with is_error and result mentions
//       "Credit balance is too low"              → key valid, billing empty
//   - status!=0 + JSON envelope with is_error and result mentions
//       authentication / api key                 → key invalid / not logged in
//   - status!=0 and no parseable JSON            → environment failure

import { spawnSync as realSpawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPlatformSupported, checkStateDirWritable } from "./xdg.mjs";

const DEFAULT_CLAUDE_BIN = "claude";
const PROBE_TIMEOUT_MS = 30_000;

export const _internals = {
  spawnSync: realSpawnSync,
  readSettings: () => {
    // Read ~/.claude/settings.json and return parsed object or null.
    try {
      const p = path.join(os.homedir(), ".claude", "settings.json");
      const raw = readFileSync(p, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
};

/**
 * @typedef {object} HealthState
 * @property {boolean} installed
 * @property {string=} version
 * @property {boolean} authenticated
 * @property {"env" | "helper" | "oauth" | null=} api_key_source
 * @property {boolean} platform_supported
 * @property {string[]} warnings
 * @property {number} checked_at_ms
 */

let cached = /** @type {HealthState | null} */ (null);

/**
 * Run a real health check, blocking (uses spawnSync). Safe to call during
 * broker startup.
 *
 * @param {{ cwd?: string, claudeBin?: string }} [opts]
 * @returns {HealthState}
 */
export function probeHealth(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const bin = opts.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const warnings = /** @type {string[]} */ ([]);
  const platform_supported = isPlatformSupported();

  // On unsupported platforms, short-circuit: don't attempt to spawn ps/claude
  // at all. The broker policy is that Windows returns just this one warning;
  // mixing in claude-not-installed / version-probe-failed would mislead.
  if (!platform_supported) {
    const state = {
      installed: false,
      version: undefined,
      authenticated: false,
      api_key_source: null,
      platform_supported: false,
      state_dir: { path: null, writable: false, hint: null },
      warnings: ["platform-unsupported"],
      checked_at_ms: Date.now(),
    };
    cached = state;
    return state;
  }

  // Check $STATE_DIR writability up-front. This catches misconfigured
  // machines (e.g. $HOME/.local owned by root) BEFORE any tool call fails
  // with a raw EACCES from mkdir deep in tracked-jobs.
  const stateDirProbe = checkStateDirWritable();

  // --- Step 1: claude --version ---
  let installed = false;
  let version /** @type {string|undefined} */ = undefined;
  const verRes = safeSpawn(bin, ["--version"], { cwd });
  if (verRes.ok && typeof verRes.stdout === "string") {
    installed = true;
    // stdout looks like: "2.1.105 (Claude Code)\n"
    const m = verRes.stdout.match(/([0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+)?)/);
    if (m) version = m[1];
    else warnings.push("version-unparsed");
  } else if (verRes.err === "ENOENT") {
    warnings.push("claude-not-installed");
  } else {
    warnings.push(`version-probe-failed:${verRes.err ?? "unknown"}`);
  }

  // --- Step 2: api key source ---
  // Pre-probe metadata: which auth source we *think* Claude will pick up.
  // The live probe below may overwrite this (e.g. set "oauth" if neither
  // env nor helper is configured but auth still succeeded).
  //   1. $ANTHROPIC_API_KEY (env)
  //   2. apiKeyHelper field in ~/.claude/settings.json
  //   3. (after probe) OAuth keychain → "oauth"
  //   4. nothing detected → null
  let api_key_source = /** @type {"env"|"helper"|null} */ (null);
  if (
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.length > 0
  ) {
    api_key_source = "env";
  } else {
    const settings = _internals.readSettings();
    if (
      settings &&
      typeof settings === "object" &&
      typeof settings.apiKeyHelper === "string" &&
      settings.apiKeyHelper.length > 0
    ) {
      api_key_source = "helper";
    }
  }

  // --- Step 3: live probe ---
  // Mirrors the real claude_ask flags so "health pass" ⇒ "ask should work".
  let authenticated = false;
  if (installed && platform_supported) {
    // Pass the prompt via stdin (NOT as a positional argv) — `--add-dir`
    // and `--tools` are variadic, and a trailing positional would be
    // swallowed as another value, causing Claude to error out with
    // "Input must be provided either through stdin or as a prompt argument".
    const probeRes = safeSpawn(
      bin,
      [
        "-p",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format=json",
        "--permission-mode=plan",
        "--tools",
        "Read,Grep,Glob",
        "--add-dir",
        cwd,
      ],
      { cwd, timeoutMs: PROBE_TIMEOUT_MS, input: "ok" },
    );
    // Authentication / capability classification (Claude 2.1.x behaviour):
    //   - status=0 + JSON envelope w/o is_error  → fully healthy
    //   - status=1 + JSON envelope w/ is_error=true and result contains
    //       "Credit balance is too low"          → key valid, billing empty
    //   - status=1 + JSON w/ is_error=true and result mentions
    //       authentication / api key             → key invalid
    //   - status!=0 and no parseable JSON        → environment failure
    let parsed = null;
    if (typeof probeRes.stdout === "string" && probeRes.stdout.length > 0) {
      try {
        parsed = JSON.parse(probeRes.stdout);
      } catch {
        // fall through
      }
    }
    if (probeRes.ok && (!parsed || typeof parsed !== "object")) {
      // Spawn succeeded but stdout wasn't structured JSON — surface
      // distinctly so users can tell apart "Claude died" from "Claude
      // returned garbage".
      warnings.push("probe-non-json");
    }
    if (parsed && typeof parsed === "object") {
      const isErr = parsed.is_error === true;
      const resultStr = typeof parsed.result === "string" ? parsed.result : "";
      if (!isErr && probeRes.ok) {
        authenticated = true;
        // If we authenticated successfully but neither env nor settings
        // helper is configured, the auth must have come from the OAuth
        // keychain (Claude subscription).
        if (api_key_source === null) api_key_source = "oauth";
      } else if (/credit balance is too low/i.test(resultStr)) {
        // Key authenticates (so Anthropic accepted it) but the API account
        // has no funds. We surface this distinctly so users don't waste
        // time chasing auth bugs — and still mark unauthenticated, since
        // real calls will fail.
        warnings.push("credit-exhausted");
      } else if (
        /authenticat|api.?key|invalid.*key|unauthori[sz]ed|please.*log/i.test(resultStr) ||
        (probeRes.stderr &&
          /authenticat|api.?key|invalid.*key|please.*log/i.test(probeRes.stderr))
      ) {
        warnings.push("auth-required");
      } else if (isErr) {
        warnings.push(
          `probe-error:${resultStr.slice(0, 80) || "unknown"}`,
        );
      } else {
        warnings.push("probe-non-success-result");
      }
    } else if (probeRes.err === "TIMEOUT") {
      warnings.push("probe-timeout");
    } else if (probeRes.stderr && /authenticat|api.?key/i.test(probeRes.stderr)) {
      warnings.push("auth-required");
    } else {
      warnings.push(`probe-failed:${probeRes.err ?? "unknown"}`);
    }
  }

  if (!stateDirProbe.ok) {
    warnings.push(`state-dir-not-writable:${stateDirProbe.error}`);
  }
  const state = {
    installed,
    version,
    authenticated,
    api_key_source,
    platform_supported,
    state_dir: {
      path: stateDirProbe.path,
      writable: stateDirProbe.ok,
      hint: stateDirProbe.ok ? null : stateDirProbe.hint,
    },
    warnings,
    checked_at_ms: Date.now(),
  };
  cached = state;
  return state;
}

/**
 * Return the cached state, probing if needed.
 * @param {{ refresh?: boolean, cwd?: string, claudeBin?: string }} [opts]
 * @returns {HealthState}
 */
export function getHealth(opts = {}) {
  if (opts.refresh || cached === null) return probeHealth(opts);
  return cached;
}

/**
 * Mutate cached state; visible for tests and for the broker to force a
 * specific state (e.g. for error reporting after transient failures).
 * @param {HealthState | null} state
 */
export function _setCached(state) {
  cached = state;
}

/**
 * Throw a typed failure if the cached (or freshly probed) state cannot
 * support real tool calls. Returns the state on success so callers can
 * embed it in responses.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {HealthState}
 */
export function assertHealthy(opts = {}) {
  const s = getHealth(opts);
  if (!s.platform_supported) throw new HealthError("platform-unsupported", s);
  if (!s.installed) throw new HealthError("not-installed", s);
  if (s.state_dir && s.state_dir.writable === false) {
    throw new HealthError("state-dir-not-writable", s);
  }
  if (!s.authenticated) throw new HealthError("auth-required", s);
  return s;
}

/**
 * Error thrown by assertHealthy(). Callers turn it into MCP tool errors.
 */
export class HealthError extends Error {
  /** @param {string} reason @param {HealthState} state */
  constructor(reason, state) {
    super(`health check failed: ${reason}`);
    this.name = "HealthError";
    this.reason = reason;
    this.state = state;
  }
}

// --- Internals ---

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 */
function safeSpawn(cmd, args, opts = {}) {
  try {
    const res = _internals.spawnSync(cmd, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      windowsHide: true,
      input: opts.input,
    });
    // Timeout on Node 22 surfaces as error.code === "ETIMEDOUT" plus a
    // non-null res.signal (usually "SIGTERM"). Check that first so we
    // classify timeouts distinctly from generic spawn errors.
    if (
      (res.error && res.error.code === "ETIMEDOUT") ||
      (opts.timeoutMs && typeof res.signal === "string" && res.signal.length > 0)
    ) {
      return {
        ok: false,
        err: "TIMEOUT",
        stdout: res.stdout ?? null,
        stderr: res.stderr ?? null,
      };
    }
    if (res.error) {
      return {
        ok: false,
        err: res.error.code ?? res.error.message ?? "spawn-error",
        stdout: null,
        stderr: null,
      };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        err: `exit:${res.status}`,
        stdout: res.stdout ?? null,
        stderr: res.stderr ?? null,
      };
    }
    return {
      ok: true,
      err: null,
      stdout: res.stdout ?? null,
      stderr: res.stderr ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      err: err && err.code ? err.code : String(err),
      stdout: null,
      stderr: null,
    };
  }
}
