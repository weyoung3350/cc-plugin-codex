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

const SERVER_NAME = "cc-plugin-codex";
const SERVER_VERSION = "0.0.1";

/** Short, stable human-readable health summary for Codex model consumption. */
function summariseHealth(s) {
  const parts = [
    `installed=${s.installed}`,
    `version=${s.version ?? "unknown"}`,
    `authenticated=${s.authenticated}`,
    `bare_compatible=${s.bare_compatible}`,
    `api_key_source=${s.api_key_source ?? "none"}`,
    `platform_supported=${s.platform_supported}`,
  ];
  if (Array.isArray(s.warnings) && s.warnings.length > 0) {
    parts.push(`warnings=[${s.warnings.join(",")}]`);
  }
  return parts.join(" ");
}

/** Wrap a HealthError into the standard MCP tool error envelope. */
function healthErrorToolResult(err) {
  const reason = err instanceof HealthError ? err.reason : "unknown";
  const hint =
    {
      "not-installed":
        "Install Claude Code CLI >= 2.1.105: https://docs.claude.com/en/docs/claude-code",
      "auth-required":
        "Set ANTHROPIC_API_KEY, or configure apiKeyHelper in ~/.claude/settings.json. OAuth keychain is not supported under --bare.",
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
      "探测本机 Claude Code 安装与认证状态，返回安装情况、认证情况、--bare 模式兼容性等诊断。传 { refresh: true } 强制重新探测（否则返回缓存结果）。",
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

  // --- stubs for upcoming phases -------------------------------------------
  const stubTools = [
    {
      name: "claude_ask",
      description:
        "向 Claude Code 提问。默认只读（plan）模式。完整实现将在 Phase 2 落地；当前为占位。",
    },
    {
      name: "claude_review",
      description:
        "委托 Claude 做结构化代码审查（输出受 --json-schema 约束）。完整实现将在 Phase 2 落地；当前为占位。",
    },
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
