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
import {
  detectWorkspaceRoot,
  ackFlagExists,
  writeAckFlag,
} from "./lib/workspace.mjs";
import {
  createJob,
  readJobState,
  finalizeJobIfNonTerminal,
  requestCancel as requestJobCancel,
  TrackedJobError,
} from "./lib/tracked-jobs.mjs";
import { jobDir, jobsDir, sessionsDir } from "./lib/xdg.mjs";
import { readLstart, sameIdentity, isAlive } from "./lib/pid-identity.mjs";

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath as _fileURLToPath } from "node:url";
import {
  writeFileSync,
  openSync,
  closeSync,
  statSync,
  readSync,
  readdirSync,
} from "node:fs";

import { randomUUID } from "node:crypto";

const WORKER_SCRIPT_PATH = path.resolve(
  path.dirname(_fileURLToPath(import.meta.url)),
  "claude-worker.mjs",
);

// SIGTERM → SIGKILL grace window for claude_cancel(running). Matches DESIGN.md.
const CANCEL_GRACE_MS = 10_000;
const CANCEL_KILL_FOLLOWUP_MS = 12_000;
const JOB_GET_DEFAULT_LIMIT = 65_536;

// Fixed acknowledgement template — emitted verbatim on the first
// allow_writes=true request so the Codex model surfaces a consistent
// warning to the user. Matches DESIGN.md "allow_writes 硬约束".
const WRITES_ACK_TEMPLATE = [
  "⚠️ 这是当前 workspace 第一次请求 claude_task 写入权限。",
  "Claude 在 writes 模式下可以编辑 / 创建文件，且**不经 Codex approval 流程**。",
  "请先和用户确认；用户同意后，重新调用本工具并加上 writes_acknowledged: true 即可继续。",
  "确认后，本 workspace 后续 claude_task(allow_writes:true) 调用将免去再确认。",
].join("\n");

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

  // --- claude_task (Phase 4 sync + Phase 5 background) -------------------
  server.registerTool({
    name: "claude_task",
    description:
      "把编辑任务委托给 Claude。默认 plan 模式只读；allow_writes:true 切到 writes 模式。首次写入需 writes_acknowledged:true，broker 在 $STATE_DIR/ack/ 记录该 workspace 已确认。background:true 会 fork 一个独立 worker 进程，立即返回 {job_id, worker_pid, log_path}，用 claude_job_get / claude_cancel 后续管理；不传 background 则同步运行返回 {text, session_id, session_persisted, cost_usd, duration_ms, truncated, captured_bytes, total_bytes}。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1 },
        files: { type: "array", items: { type: "string" } },
        session_id: { type: "string" },
        allow_writes: { type: "boolean" },
        writes_acknowledged: { type: "boolean" },
        background: { type: "boolean" },
        timeout_sec: { type: "integer", minimum: 1, maximum: 1800 },
        add_dirs: { type: "array", items: { type: "string" } },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (typeof args?.task !== "string" || args.task.length === 0) {
        return toolErrorResult(
          "invalid-task",
          "claude_task: task must be a non-empty string",
        );
      }
      // Health gate FIRST — must precede every side effect (including
      // writing the workspace ack flag), per DESIGN.md "认证前置".
      try {
        assertHealthy();
      } catch (err) {
        if (err instanceof HealthError) return healthErrorToolResult(err);
        throw err;
      }
      const allowWrites = args.allow_writes === true;
      let permission = /** @type {"plan" | "writes"} */ ("plan");
      if (allowWrites) {
        // Writes ack gate. Per-workspace, lifelong sticky flag.
        let workspaceRoot;
        try {
          workspaceRoot = detectWorkspaceRoot(process.cwd());
        } catch (err) {
          return toolErrorResult(
            "workspace-detect-failed",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (!ackFlagExists(workspaceRoot)) {
          if (args.writes_acknowledged !== true) {
            return toolErrorResult(
              "writes-need-acknowledgement",
              WRITES_ACK_TEMPLATE,
              { workspace_root: workspaceRoot },
            );
          }
          // Caller has acknowledged → install the flag and proceed.
          try {
            writeAckFlag(workspaceRoot);
          } catch (err) {
            return toolErrorResult(
              "writes-ack-write-failed",
              err instanceof Error ? err.message : String(err),
              { workspace_root: workspaceRoot },
            );
          }
        }
        permission = "writes";
      }

      // Compose the prompt: prepend a short instruction listing the files
      // Claude should focus on, if any. The actual edit decisions stay
      // with Claude.
      const lines = [args.task];
      if (Array.isArray(args.files) && args.files.length > 0) {
        const cleanFiles = args.files.filter(
          (f) => typeof f === "string" && f.length > 0,
        );
        if (cleanFiles.length > 0) {
          lines.push("");
          lines.push("Focus files:");
          for (const f of cleanFiles) lines.push(`  - ${f}`);
        }
      }
      const prompt = lines.join("\n");

      // Background path forks an independent worker and returns the job_id
      // immediately; sync path runs through runSyncTool.
      if (args.background === true) {
        return await launchBackgroundJob({
          permission,
          prompt,
          args,
        });
      }

      return runSyncTool("claude_task", permission, null, {
        prompt,
        session_id: args.session_id,
        add_dirs: args.add_dirs,
        timeout_sec: args.timeout_sec,
      });
    },
  });

  // --- claude_job_get (Phase 5) ------------------------------------------
  server.registerTool({
    name: "claude_job_get",
    description:
      "查询后台作业状态 + 分页读取 output.log（base64 编码避免 UTF-8 边界问题）。返回 {state, exit_code, exit_signal, error, started_at_ms, ended_at_ms, output:{chunk_base64, encoding, returned_bytes, next_offset, total_bytes, eof}}。output_offset/output_limit 默认 0/65536。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", minLength: 1 },
        wait: { type: "boolean" },
        wait_timeout_sec: { type: "integer", minimum: 0, maximum: 1800 },
        output_offset: { type: "integer", minimum: 0 },
        output_limit: { type: "integer", minimum: 1, maximum: 1024 * 1024 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        assertHealthy();
      } catch (err) {
        if (err instanceof HealthError) return healthErrorToolResult(err);
        throw err;
      }
      return await readJobReport(args);
    },
  });

  // --- claude_cancel (Phase 5) -------------------------------------------
  server.registerTool({
    name: "claude_cancel",
    description:
      "取消后台作业。queued 阶段写 cancel_requested=true 让 worker 收尾；running 阶段对 claude process group 发 SIGTERM (10s 后 SIGKILL)。终态返回 {cancelled:false, reason:'already-done'}。前台调用不支持取消（同步工具有 timeout_sec 兜底）。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", minLength: 1 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        assertHealthy();
      } catch (err) {
        if (err instanceof HealthError) return healthErrorToolResult(err);
        throw err;
      }
      return await cancelJob(args.job_id);
    },
  });

  return server;
}

// ─── Phase 5 helpers ───────────────────────────────────────────────────

/**
 * Fork a detached worker for claude_task(background:true). Returns an MCP
 * tool result with {job_id, worker_pid, log_path} on success.
 */
async function launchBackgroundJob({ permission, prompt, args }) {
  const job_id = randomUUID();
  const cwd = process.cwd();
  let claudeArgv;
  try {
    claudeArgv = buildClaudeFlags({
      permission,
      cwd,
      add_dirs: args.add_dirs,
      session_id: args.session_id,
      useResume: true,
      schema: undefined,
    });
  } catch (err) {
    if (err instanceof PermissionError) {
      return toolErrorResult(err.reason, err.message);
    }
    throw err;
  }

  const sessionId =
    typeof args.session_id === "string" && args.session_id.length > 0
      ? args.session_id
      : null;
  const dir = jobDir(job_id);

  // CRASH-SAFE LAUNCH (spawn-first):
  //
  //   1. spawn detached worker → worker.pid known
  //   2. readLstart(worker.pid) → fail-fast if null
  //   3. createJob(worker_pid, worker_lstart) → state.json now reflects
  //      the actual worker identity. sweepOrphanedJobs can never produce
  //      a false-positive orphan against this job, since worker_pid is
  //      always the real worker pid.
  //   4. writeFileSync(spec.json) → worker's spec-poll resolves and it
  //      proceeds. If this step fails, finalize the just-created job so
  //      we don't leave a queued zombie.
  //   5. return job_id
  //
  // Failure modes:
  //   - broker crashes between 1 and 3: state.json never created;
  //     leaked worker polls spec/state, times out, exits silently. Job
  //     is invisible to the user — acceptable, broker can't even reply.
  //   - broker crashes between 3 and 4: state.json exists but spec.json
  //     never appears. Worker times out reading spec, finalises
  //     spawn-failed.
  //   - broker crashes after 4: normal flow.

  let worker;
  try {
    worker = nodeSpawn(
      process.execPath,
      [WORKER_SCRIPT_PATH, job_id],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
      },
    );
    if (typeof worker.unref === "function") worker.unref();
  } catch (err) {
    return toolErrorResult(
      "worker-spawn-failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  const workerLstart = readLstart(worker.pid);
  if (workerLstart === null || workerLstart.length === 0) {
    try { worker.kill("SIGKILL"); } catch {}
    return toolErrorResult(
      "worker-lstart-unreadable",
      `cannot read process start time for worker pid ${worker.pid}`,
    );
  }

  try {
    createJob({
      job_id,
      session_id: sessionId,
      session_persisted: sessionId !== null,
      worker_pid: worker.pid,
      worker_lstart_raw: workerLstart,
    });
  } catch (err) {
    try { worker.kill("SIGKILL"); } catch {}
    if (err instanceof TrackedJobError) {
      return toolErrorResult(err.reason, err.message);
    }
    throw err;
  }

  try {
    writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({
        argv: claudeArgv,
        prompt,
        cwd,
        session_id: sessionId,
      }),
    );
  } catch (err) {
    // Spec write failed. Kill the worker (it'll either time out reading
    // spec or never see the file at all) AND finalize the job so we
    // don't leave a queued zombie that nothing will sweep.
    try { worker.kill("SIGKILL"); } catch {}
    await finalizeJobIfNonTerminal(job_id, {
      state: "failed",
      error: "spawn-failed",
      ended_at_ms: Date.now(),
    }).catch(() => {});
    return toolErrorResult(
      "spec-write-failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            job_id,
            worker_pid: worker.pid,
            log_path: path.join(dir, "output.log"),
          },
          null,
          2,
        ),
      },
    ],
    isError: false,
  };
}

/**
 * Read job state + paginated output for claude_job_get. If wait:true,
 * polls until the job reaches a terminal state OR wait_timeout_sec.
 */
async function readJobReport(args) {
  const wait = args.wait === true;
  const waitTimeoutMs =
    typeof args.wait_timeout_sec === "number"
      ? args.wait_timeout_sec * 1000
      : 60_000;
  const offset = Number.isInteger(args.output_offset)
    ? args.output_offset
    : 0;
  const limit = Number.isInteger(args.output_limit)
    ? args.output_limit
    : JOB_GET_DEFAULT_LIMIT;

  const start = Date.now();
  let state = readJobState(args.job_id);
  if (!state) {
    return toolErrorResult("job-not-found", `no job with id ${args.job_id}`);
  }
  while (
    wait &&
    !["succeeded", "failed", "cancelled"].includes(state.state) &&
    Date.now() - start < waitTimeoutMs
  ) {
    await new Promise((r) => setTimeout(r, 200));
    const next = readJobState(args.job_id);
    if (next) state = next;
  }

  const logPath = path.join(jobDir(args.job_id), "output.log");
  let totalBytes = 0;
  try {
    totalBytes = statSync(logPath).size;
  } catch {}
  const sliceStart = Math.max(0, Math.min(offset, totalBytes));
  const sliceLen = Math.max(0, Math.min(limit, totalBytes - sliceStart));
  let chunkBase64 = "";
  let returnedBytes = 0;
  if (sliceLen > 0) {
    let fd = null;
    try {
      fd = openSync(logPath, "r");
      const buf = Buffer.allocUnsafe(sliceLen);
      const n = readSync(fd, buf, 0, sliceLen, sliceStart);
      returnedBytes = n;
      chunkBase64 = buf.subarray(0, n).toString("base64");
    } catch {
      // fall through — empty slice
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }
  const nextOffset = sliceStart + returnedBytes;
  const eof =
    ["succeeded", "failed", "cancelled"].includes(state.state) &&
    nextOffset >= totalBytes;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            state: state.state,
            exit_code: state.exit_code,
            exit_signal: state.exit_signal,
            error: state.error,
            cost_usd: null,
            started_at_ms: state.started_at_ms,
            ended_at_ms: state.ended_at_ms,
            cancel_requested: state.cancel_requested,
            output: {
              chunk_base64: chunkBase64,
              encoding: "base64",
              returned_bytes: returnedBytes,
              next_offset: nextOffset,
              total_bytes: totalBytes,
              eof,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: false,
  };
}

/**
 * Cancel a job. queued → flip cancel_requested, worker observes;
 * running → SIGTERM the claude process group, 10s grace, then SIGKILL;
 * terminal → no-op with reason "already-done".
 */
async function cancelJob(job_id) {
  const cur = readJobState(job_id);
  if (!cur) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { cancelled: false, reason: "not-found" },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  }
  if (["succeeded", "failed", "cancelled"].includes(cur.state)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { cancelled: false, reason: "already-done" },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  }
  // Always set the flag so the worker observes it (especially for queued).
  await requestJobCancel(job_id);

  // Re-read state AFTER setting the flag — it may have raced into a
  // terminal state, in which case we must report already-done rather
  // than continuing to signal.
  const post = readJobState(job_id);
  if (post && ["succeeded", "failed", "cancelled"].includes(post.state)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { cancelled: false, reason: "already-done" },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  }

  // Running: also signal the Claude process group, with identity check.
  if (
    post &&
    post.state === "running" &&
    post.claude_pid &&
    post.claude_lstart_raw
  ) {
    if (!sameIdentity(post.claude_pid, post.claude_lstart_raw)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { cancelled: false, reason: "pid-stale" },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }
    const targetPid = post.claude_pid;
    const targetLstart = post.claude_lstart_raw;
    try {
      // Negative pid → process group.
      process.kill(-targetPid, "SIGTERM");
    } catch {}
    // Schedule a follow-up SIGKILL — but RE-VALIDATE identity before
    // signalling. Within the grace window the original Claude may have
    // exited and its pid been reused by an unrelated process; SIGKILL
    // without re-checking would tear that down.
    setTimeout(() => {
      if (sameIdentity(targetPid, targetLstart)) {
        try {
          process.kill(-targetPid, "SIGKILL");
        } catch {}
      }
    }, CANCEL_GRACE_MS).unref?.();
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            cancelled: true,
            phase: (post ?? cur).state,
          },
          null,
          2,
        ),
      },
    ],
    isError: false,
  };
}

/**
 * Main entrypoint: synchronously probe health so the first tool call sees a
 * cached result, sweep orphaned jobs, then start the MCP server on
 * stdin/stdout. On transport close the process exits with code 0.
 */
export function main() {
  const server = buildBroker();

  try {
    probeHealth();
  } catch (err) {
    process.stderr.write(
      `[cc-plugin-codex] health probe threw during startup: ${String(err)}\n`,
    );
  }

  // Sweep orphaned jobs left over from a previous broker session.
  sweepOrphanedJobs().catch((err) => {
    process.stderr.write(
      `[cc-plugin-codex] orphan sweep threw: ${String(err)}\n`,
    );
  });

  server.start({
    input: process.stdin,
    output: process.stdout,
    onClose: () => process.exit(0),
  });
}

/**
 * Tri-state owner classifier mirroring session-lock's reclaim logic. Used
 * only by sweepOrphanedJobs.
 *
 *   "alive"   → kill(0) succeeds AND lstart matches
 *   "dead"    → kill(0) ESRCH OR pid alive but lstart mismatch (PID reuse)
 *   "unknown" → pid alive but ps couldn't read lstart (transient failure)
 *
 * Sweep MUST treat "unknown" as do-not-reclaim. A momentary ps hiccup
 * during broker startup would otherwise wipe out live jobs.
 *
 * @param {number} pid
 * @param {string} expectedLstart
 * @returns {"alive"|"dead"|"unknown"}
 */
function classifyOwnerForSweep(pid, expectedLstart) {
  if (!isAlive(pid)) return "dead";
  const cur = readLstart(pid);
  if (cur === null) return "unknown";
  return cur === expectedLstart ? "alive" : "dead";
}

/**
 * Walk $STATE_DIR/jobs and finalise any non-terminal jobs whose worker /
 * Claude processes are gone. Per DESIGN.md "孤儿作业（仅非终态）":
 *
 *   - queued: only check worker_pid identity; failure → orphaned.
 *   - running: BOTH worker_pid AND claude_pid must look dead before we
 *     mark it orphan. If either is still alive, leave it alone — the
 *     normal exit path will close it out.
 *   - terminal states are NEVER touched.
 *
 * All writes go through finalizeJobIfNonTerminal, so we can never
 * accidentally overwrite a state that became terminal in between.
 */
export async function sweepOrphanedJobs() {
  let entries;
  try {
    entries = readdirSync(jobsDir(), { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return; // nothing yet
    throw err;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const job_id = ent.name;
    const cur = readJobState(job_id);
    if (!cur) continue; // corrupt or missing state.json — leave alone
    if (cur.state !== "queued" && cur.state !== "running") continue;

    // Tri-state classifier. ps may transiently fail; treat that as
    // "unknown" — never reclaim. Only definitively-dead (kill -0 ESRCH)
    // OR pid-reused (lstart mismatch) counts as "dead" for sweep.
    const workerStatus = classifyOwnerForSweep(
      cur.worker_pid,
      cur.worker_lstart_raw,
    );
    const claudeStatus =
      cur.claude_pid && cur.claude_lstart_raw
        ? classifyOwnerForSweep(cur.claude_pid, cur.claude_lstart_raw)
        : "absent";

    let orphaned = false;
    if (cur.state === "queued") {
      // queued has no claude pid yet; orphan iff worker is definitely dead.
      orphaned = workerStatus === "dead";
    } else {
      // running: both must be dead OR absent. "unknown" for either side
      // means we can't safely conclude they're gone.
      const workerDeadOrAbsent =
        workerStatus === "dead" || workerStatus === "absent";
      const claudeDeadOrAbsent =
        claudeStatus === "dead" || claudeStatus === "absent";
      orphaned = workerDeadOrAbsent && claudeDeadOrAbsent;
    }

    if (orphaned) {
      await finalizeJobIfNonTerminal(job_id, {
        state: "failed",
        error: "orphaned",
        ended_at_ms: Date.now(),
      }).catch((err) => {
        process.stderr.write(
          `[cc-plugin-codex] failed to mark ${job_id} orphaned: ${String(err)}\n`,
        );
      });
    }
  }
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
