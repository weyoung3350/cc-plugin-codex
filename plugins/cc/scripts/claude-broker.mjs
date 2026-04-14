#!/usr/bin/env node
// MCP broker that bridges Codex ↔ local Claude Code CLI.
//
// Phase 1 scope:
//   - MCP stdio handshake (initialize / tools/list).
//   - claude_health tool (live + cached; supports { refresh: true }).
//   - All other design-time tools (claude_ask / claude_review / claude_task /
//     claude_job_get / claude_cancel) are registered as stubs that return
//     `not-implemented` until their respective phases land.
//
// Gate: every non-claude_health tool calls assertHealthy() first. The broker
// does one health probe on startup and caches it in-process; the
// claude_health tool is the only path that can reprobe (via `refresh`).

import { fileURLToPath } from "node:url";
import path from "node:path";

import { createMcpServer } from "./lib/mcp-server.mjs";
import {
  probeHealth,
  getHealth,
  assertHealthy,
  HealthError,
} from "./lib/health.mjs";
import { buildClaudeFlags, PermissionError } from "./lib/permission.mjs";
import { runClaude, parseClaudeJson } from "./lib/claude-run.mjs";
import {
  REVIEW_SCHEMA,
  formatReviewPrompt,
  validateReviewOutput,
  ReviewValidationError,
} from "./lib/review-schema.mjs";
import {
  acquire as acquireSessionLock,
  release as releaseSessionLock,
  SessionLockError,
} from "./lib/session-lock.mjs";

import { randomUUID } from "node:crypto";

const SERVER_NAME = "cc-plugin-codex";
const SERVER_VERSION = "0.0.1";

/** Short, stable human-readable health summary for Codex model consumption. */
function summariseHealth(s) {
  const parts = [
    `installed=${s.installed}`,
    `version=${s.version ?? "unknown"}`,
    `authenticated=${s.authenticated}`,
    `api_key_source=${s.api_key_source ?? "none"}`,
    `platform_supported=${s.platform_supported}`,
  ];
  if (Array.isArray(s.warnings) && s.warnings.length > 0) {
    parts.push(`warnings=[${s.warnings.join(",")}]`);
  }
  return parts.join(" ");
}

/** Wrap any tool error into the standard MCP content envelope. */
function toolErrorResult(error, hint, extras = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error, hint, ...extras }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Shared runtime for claude_ask and claude_review.
 *
 * @param {string} toolName
 * @param {"plan"|"writes"} permission
 * @param {object|null} schema   If non-null, inject --json-schema + validate
 *                               the JSON result against review schema.
 * @param {object} args
 * @returns {Promise<object>}
 */
async function runSyncTool(toolName, permission, schema, args) {
  // 1. Health gate (cached).
  try {
    assertHealthy();
  } catch (err) {
    if (err instanceof HealthError) return healthErrorToolResult(err);
    throw err;
  }

  // 1b. Session serialisation. We only acquire a lock when the caller
  // supplied a session_id — one-shot calls are independent and skip
  // entirely. Lock-wait time IS counted in the caller's timeout_sec.
  const callerSessionId =
    typeof args.session_id === "string" && args.session_id.length > 0
      ? args.session_id
      : null;
  /** @type {import("./lib/session-lock.mjs").LockHandle | null} */
  let lock = null;
  const totalTimeoutMs =
    typeof args.timeout_sec === "number"
      ? Math.max(1, Math.floor(args.timeout_sec)) * 1000
      : undefined;
  const lockStartMs = Date.now();
  if (callerSessionId !== null) {
    try {
      lock = await acquireSessionLock(callerSessionId, {
        timeoutMs: totalTimeoutMs ?? Infinity,
        requestId: `${toolName}-${randomUUID()}`,
      });
    } catch (err) {
      if (err instanceof SessionLockError) {
        // Map each lock failure mode to a distinct tool error so callers
        // (and humans tailing logs) can tell apart "queue overrun" from
        // "fs broken" from "ps unavailable on this system".
        const errorCode = (() => {
          switch (err.reason) {
            case "timeout":
              return "timeout";
            case "would-block":
              return "session-busy";
            case "lstart-unreadable":
              return "lstart-unreadable";
            case "io-error":
            default:
              return "lock-io-error";
          }
        })();
        return toolErrorResult(errorCode, err.message, {
          phase: "lock-wait",
          duration_ms: Date.now() - lockStartMs,
          lock_reason: err.reason,
        });
      }
      throw err;
    }
  }

  try {
    return await runSyncToolBody(
      toolName,
      permission,
      schema,
      args,
      callerSessionId,
      totalTimeoutMs,
      lockStartMs,
    );
  } finally {
    if (lock) releaseSessionLock(lock);
  }
}

/** Body of a synchronous tool call once the session lock is held. */
async function runSyncToolBody(
  toolName,
  permission,
  schema,
  args,
  callerSessionId,
  totalTimeoutMs,
  lockStartMs,
) {
  // 2. Build argv.
  let flags;
  try {
    flags = buildClaudeFlags({
      permission,
      cwd: process.cwd(),
      add_dirs: args.add_dirs,
      session_id: args.session_id,
      useResume: true, // resume-first protocol
      schema: schema ?? undefined,
    });
  } catch (err) {
    if (err instanceof PermissionError) {
      return toolErrorResult(err.reason, err.message);
    }
    throw err;
  }

  if (typeof args.model === "string" && args.model.length > 0) {
    flags.push("--model", args.model);
  }

  // 3. Run claude. Subtract the time we already spent waiting for the
  // session lock from the run-phase budget so the caller's total
  // timeout_sec is honoured end-to-end. If lock-wait already consumed the
  // entire budget, fail fast WITHOUT spawning Claude — otherwise we'd
  // overshoot the caller's deadline.
  let runTimeoutMs = totalTimeoutMs;
  const lockWaitMs = Date.now() - lockStartMs;
  if (typeof runTimeoutMs === "number") {
    runTimeoutMs = runTimeoutMs - lockWaitMs;
    if (runTimeoutMs <= 0) {
      return toolErrorResult(
        "timeout",
        "timeout_sec exhausted by session lock-wait; not spawning",
        {
          phase: "lock-wait",
          duration_ms: lockWaitMs,
          lock_reason: "budget-exhausted",
        },
      );
    }
  }
  const prompt = typeof args.prompt === "string" ? args.prompt : "";

  const run = await runClaude({
    flags,
    prompt,
    cwd: process.cwd(),
    timeoutMs: runTimeoutMs,
  });

  // 4. Classify outcome.
  if (run.error === "timeout") {
    return toolErrorResult("timeout", "claude run exceeded timeout", {
      phase: "run",
      partial_text: run.text,
      captured_bytes: run.captured_bytes,
      duration_ms: run.duration_ms,
    });
  }
  if (run.error === "nonzero") {
    return toolErrorResult("claude-nonzero-exit", "claude exited with an error", {
      exit_code: run.exit_code,
      exit_signal: run.exit_signal,
      stderr: run.stderr,
      resume_retried: run.resume_retried,
    });
  }

  // 5. Parse Claude's JSON envelope.
  const parsed = parseClaudeJson(run.text);
  if (parsed.result === null) {
    return toolErrorResult(
      "claude-output-malformed",
      "Claude's JSON envelope is missing .result",
      { raw: run.text.slice(0, 4096) },
    );
  }

  // session_id contract (DESIGN.md):
  //   - caller passed session_id → echo it back, session_persisted=true
  //   - caller did NOT pass → force null + persisted=false, even if Claude
  //     happened to emit a session_id under --no-session-persistence
  // (callerSessionId is computed once at the top of runSyncTool and
  // threaded through; do not re-derive it here.)
  const commonMeta = {
    session_id: callerSessionId,
    session_persisted: callerSessionId !== null,
    cost_usd: parsed.total_cost_usd,
    duration_ms: run.duration_ms,
    truncated: run.truncated,
    captured_bytes: run.captured_bytes,
    total_bytes: run.total_bytes,
  };

  // 6. Optional: schema-backed tools extract+validate the structured result.
  if (schema !== null) {
    let reviewObj;
    try {
      reviewObj = JSON.parse(parsed.result);
    } catch {
      // Unify with the non-schema malformed path: any "Claude returned text
      // that isn't structured" fault uses the same error code.
      return toolErrorResult(
        "claude-output-malformed",
        "Claude's --json-schema result did not parse as JSON",
        { raw: parsed.result.slice(0, 4096), ...commonMeta },
      );
    }
    try {
      validateReviewOutput(reviewObj);
    } catch (err) {
      if (err instanceof ReviewValidationError) {
        return toolErrorResult(
          "claude-review-schema-mismatch",
          err.message,
          { field: err.field, detail: err.detail, ...commonMeta },
        );
      }
      throw err;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...reviewObj, ...commonMeta }, null, 2),
        },
      ],
      isError: false,
    };
  }

  // 7. Non-schema tools just return text.
  return {
    content: [
      { type: "text", text: parsed.result },
      { type: "text", text: JSON.stringify(commonMeta, null, 2) },
    ],
    isError: false,
  };
}

/** Wrap a HealthError into the standard MCP tool error envelope. */
function healthErrorToolResult(err) {
  const reason = err instanceof HealthError ? err.reason : "unknown";
  const hint =
    {
      "not-installed":
        "Install Claude Code CLI >= 2.1.105: https://docs.claude.com/en/docs/claude-code",
      "auth-required":
        "Run `claude /login` to log in with your Claude subscription, OR set ANTHROPIC_API_KEY, OR configure apiKeyHelper in ~/.claude/settings.json.",
      "platform-unsupported":
        "cc-plugin-codex supports macOS and Linux only. Windows is intentionally unsupported.",
    }[reason] ?? "See claude_health for diagnostic detail.";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: reason, hint }, null, 2),
      },
    ],
    isError: true,
  };
}

export function buildBroker() {
  const server = createMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    instructions:
      "把问题、审查、聚焦的编辑任务委托给本机 Claude Code CLI。其他工具返回错误时，先调 claude_health 查看诊断。",
  });

  // --- claude_health --------------------------------------------------------
  server.registerTool({
    name: "claude_health",
    description:
      "探测本机 Claude Code 安装与认证状态，返回安装情况、认证情况（订阅 OAuth / API key / apiKeyHelper）、平台兼容性等诊断。传 { refresh: true } 强制重新探测（否则返回缓存结果）。",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Re-run the probe instead of returning cached state.",
        },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const s = getHealth({ refresh: args?.refresh === true });
      return {
        content: [
          { type: "text", text: summariseHealth(s) },
          { type: "text", text: JSON.stringify(s, null, 2) },
        ],
        isError: !s.platform_supported || !s.installed || !s.authenticated,
      };
    },
  });

  // --- claude_ask (Phase 2) -------------------------------------------------
  server.registerTool({
    name: "claude_ask",
    description:
      "向 Claude Code 提问，默认只读（plan 模式，只开 Read/Grep/Glob 工具）。可通过 session_id 续写；不传则本次不持久化 session。返回 {text, session_id, session_persisted, cost_usd, duration_ms, truncated, captured_bytes, total_bytes}。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        session_id: { type: "string" },
        model: { type: "string" },
        add_dirs: { type: "array", items: { type: "string" } },
        timeout_sec: { type: "integer", minimum: 1, maximum: 1800 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    handler: (args) => {
      // mcp-server doesn't enforce JSON-schema; do the prompt validation
      // explicitly so we get a clean error instead of feeding "" to Claude.
      if (typeof args?.prompt !== "string" || args.prompt.length === 0) {
        return toolErrorResult(
          "invalid-prompt",
          "claude_ask: prompt must be a non-empty string",
        );
      }
      return runSyncTool("claude_ask", "plan", null, args);
    },
  });

  // --- claude_review (Phase 2) ---------------------------------------------
  server.registerTool({
    name: "claude_review",
    description:
      "委托 Claude 做结构化代码审查。输出严格遵循固定 schema（--json-schema 注入 + broker 侧结构校验）。返回 schema 对象 + {session_id, session_persisted, truncated, captured_bytes, duration_ms}。",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          anyOf: [
            { type: "string", minLength: 1 },
            {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          ],
        },
        instructions: { type: "string" },
        session_id: { type: "string" },
        timeout_sec: { type: "integer", minimum: 1, maximum: 1800 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: (args) => {
      let prompt;
      try {
        prompt = formatReviewPrompt({
          target: args?.target,
          instructions: args?.instructions,
        });
      } catch (err) {
        // Only the documented validation errors are turned into invalid-target;
        // anything else propagates so we don't silently mask formatter bugs.
        if (
          err instanceof Error &&
          /^formatReviewPrompt: target/.test(err.message)
        ) {
          return toolErrorResult("invalid-target", err.message);
        }
        throw err;
      }
      // Restrict the args we pass to runSyncTool to those explicitly
      // declared in claude_review's inputSchema. This stops callers from
      // smuggling add_dirs/model/etc through claude_review (which is
      // intentionally narrower than claude_ask).
      const sanitisedArgs = {
        prompt,
        session_id: args?.session_id,
        timeout_sec: args?.timeout_sec,
      };
      return runSyncTool(
        "claude_review",
        "plan",
        REVIEW_SCHEMA,
        sanitisedArgs,
      );
    },
  });

  // --- stubs for upcoming phases -------------------------------------------
  const stubTools = [
    {
      name: "claude_task",
      description:
        "把编辑任务委托给 Claude。支持 allow_writes 开启写入权限和 background 后台执行。完整实现将在 Phase 4-5 落地；当前为占位。",
    },
    {
      name: "claude_job_get",
      description:
        "读取后台作业的状态和分页日志。完整实现将在 Phase 5 落地；当前为占位。",
    },
    {
      name: "claude_cancel",
      description:
        "通过 job_id 取消后台作业。完整实现将在 Phase 5 落地；当前为占位。",
    },
  ];

  for (const t of stubTools) {
    server.registerTool({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", additionalProperties: true },
      handler: () => {
        try {
          assertHealthy();
        } catch (err) {
          return healthErrorToolResult(err);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "not-implemented",
                  hint: `${t.name} is a Phase 1 stub; full behaviour arrives in a later phase.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      },
    });
  }

  return server;
}

/**
 * Main entrypoint: synchronously probe health so the first tool call sees a
 * cached result, then start the MCP server on stdin/stdout. On transport
 * close the process exits with code 0.
 *
 * Startup IS blocked for the duration of the probe (worst case = probe
 * timeout). We accept that to make claude_health deterministic for the
 * first tool call; if that becomes a problem we can hoist the probe into
 * a fire-and-forget that refreshes the cache in the background.
 */
export function main() {
  const server = buildBroker();

  // Populate the in-process cache. Failures become warnings in state;
  // claude_health itself must always remain callable, even when Claude
  // isn't installed, so we intentionally never abort startup here.
  try {
    probeHealth();
  } catch (err) {
    process.stderr.write(
      `[cc-plugin-codex] health probe threw during startup: ${String(err)}\n`,
    );
  }

  server.start({
    input: process.stdin,
    output: process.stdout,
    onClose: () => process.exit(0),
  });
}

/**
 * True when this module was launched directly (e.g. `node claude-broker.mjs`),
 * false when imported for tests. Uses `fileURLToPath` to survive paths with
 * spaces / non-ASCII characters that would otherwise be percent-encoded by
 * URL.pathname.
 */
export function isDirectInvocation({
  moduleUrl = import.meta.url,
  argv1 = process.argv[1],
} = {}) {
  if (!argv1) return false;
  try {
    const self = fileURLToPath(moduleUrl);
    return path.resolve(self) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) main();
