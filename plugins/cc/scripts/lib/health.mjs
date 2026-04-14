// Health probe for the local Claude Code CLI.
//
// Contract (docs/DESIGN.md):
//   - Probe on broker startup; cache result in-process.
//   - Probe Claude using the same flags as real claude_ask calls, so that a
//     successful probe is a strong predicate for real calls working.
//   - Report: installed / version / authenticated / bare_compatible /
//     api_key_source / platform_supported / warnings[] / checked_at_ms.
//   - Non-claude_health tools MUST gate on assertHealthy().
//   - claude_health({ refresh: true }) triggers a reprobe. No TTL.
//
// Runtime model:
//   - `claude --version` → installed + version.
//   - `claude -p <ask-flags> "ok"` → authenticated + bare_compatible.
//   - API-key source is derived from env (ANTHROPIC_API_KEY / apiKeyHelper).
//     apiKeyHelper lives in ~/.claude/settings.json; we treat it as a soft
//     signal and only read $ANTHROPIC_API_KEY from env directly.

import { spawnSync as realSpawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPlatformSupported } from "./xdg.mjs";

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
 * @property {boolean} bare_compatible
 * @property {"env" | "helper" | null=} api_key_source
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
      bare_compatible: false,
      api_key_source: null,
      platform_supported: false,
      warnings: ["platform-unsupported"],
      checked_at_ms: Date.now(),
    };
    cached = state;
    return state;
  }

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
  // Precedence matches how `claude --bare` resolves auth:
  //   1. $ANTHROPIC_API_KEY (env)
  //   2. apiKeyHelper field in ~/.claude/settings.json
  //   Anything else (OAuth / keychain) is intentionally unsupported in bare mode.
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

  // --- Step 3: live bare-mode probe ---
  // Mirrors the real claude_ask flags so "health pass" ⇒ "ask should work".
  let authenticated = false;
  let bare_compatible = false;
  if (installed && platform_supported) {
    const probeRes = safeSpawn(
      bin,
      [
        "-p",
        "--bare",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format=json",
        "--permission-mode=plan",
        "--tools",
        "Read,Grep,Glob",
        "--add-dir",
        cwd,
        "ok",
      ],
      { cwd, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (probeRes.ok && typeof probeRes.stdout === "string") {
      // Expect a JSON envelope with a `result` field; we don't parse its
      // contents — any well-formed JSON response is enough to confirm
      // "Claude started, authenticated, and produced output".
      try {
        const parsed = JSON.parse(probeRes.stdout);
        if (parsed && typeof parsed === "object") {
          authenticated = true;
          bare_compatible = true;
        } else {
          warnings.push("probe-non-json-response");
        }
      } catch {
        warnings.push("probe-json-parse-failed");
      }
    } else if (probeRes.err === "TIMEOUT") {
      warnings.push("probe-timeout");
    } else if (probeRes.stderr && /authenticat|api.?key/i.test(probeRes.stderr)) {
      warnings.push("auth-required");
    } else {
      warnings.push(`probe-failed:${probeRes.err ?? "unknown"}`);
    }
  }

  const state = {
    installed,
    version,
    authenticated,
    bare_compatible,
    api_key_source,
    platform_supported,
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
