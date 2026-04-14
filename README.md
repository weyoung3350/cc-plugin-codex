# cc-plugin-codex

让 **Codex CLI** 直接与 **Claude Code** 交互的插件 —— Codex 里的模型可以主动把任务委托给本机 Claude Code，拿回结果用于审查、补洞、续写等场景。

这是 OpenAI 官方 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)（Claude Code → Codex 方向）的**对称镜像**版本，方向反过来：Codex → Claude Code。

## 当前状态

🚀 **Phase 1-7 完成**（功能 + 文档落地）；Phase 8（回归 fixture / CI）剩。

| Phase | 范围 | 状态 |
|-------|------|------|
| 1 | MCP server 骨架 + `claude_health` | ✅ |
| 2 | 同步 `claude_ask` / `claude_review`（含 `--json-schema`） | ✅ |
| 3 | session 串行锁（mkdir + pid/lstart 双因子 stale reclaim） | ✅ |
| 4 | `claude_task` 同步 + 两级权限 + writes ACK 硬约束 | ✅ |
| 5 | 后台 worker + `claude_job_get` + `claude_cancel` + orphan sweep | ✅ |
| 6 | 3 个 SKILL.md（delegation-runtime / result-handling / prompting） | ✅ |
| 7 | marketplace agent yaml + 用户文档 + license | ✅ |
| 8 | fake-claude-fixture + 21 checkpoint 自动化回归 | ⏳ |

- 设计：[需求文档](./docs/REQUIREMENTS.md) · [设计文档 v8b](./docs/DESIGN.md)（11 轮跨模型评审，零 Critical 落地）
- 每个实现任务都走 **实现 → Codex 评审 → 修 Critical → 复核** 循环
- **219 个单元测试全绿**；订阅 OAuth 端到端冒烟已通过

## 设计亮点

- **架构**：薄 broker + 每次调用现起 `claude -p` 子进程；零 native 依赖
- **会话续写**：完全依赖 Claude 原生 `--session-id` / `--resume`，跨 `codex exec` 可续
- **认证**：自动适配 Claude 自身的认证链（订阅 OAuth / `ANTHROPIC_API_KEY` / `apiKeyHelper`）；订阅用户 `claude /login` 后开箱即用
- **递归防御**：默认 `--strict-mcp-config --permission-mode=plan --tools "Read,Grep,Glob"`，阻止 Claude 子进程再发现并调用本插件 MCP（**非安全沙箱**：CLAUDE.md / hooks / auto-memory 仍生效）
- **并发**：同 `session_id` 串行（mkdir 用户态锁 + pid/lstart 双因子 stale reclaim）
- **后台作业**：独立 detached worker；per-job mutex 消除 lost update；完整因果矩阵约束终态写入
- **平台**：macOS / Linux（POSIX）；不支持 Windows

## MCP 工具（Codex 模型可见）

| 工具 | 同步/异步 | 用途 |
|------|----------|------|
| `claude_health` | 同步 | 探测 Claude 安装 / 认证（OAuth/env/helper）/ 平台兼容性 |
| `claude_ask` | 同步 | 自由提问（默认 plan 模式只读：Read/Grep/Glob） |
| `claude_review` | 同步 | 结构化代码审查（固定 JSON schema） |
| `claude_task` | 同步/后台 | 委托编辑任务（`plan` / `writes` 两级权限）；`background:true` 起 detached worker |
| `claude_job_get` | 同步 | 查询后台作业状态 / 分页读 output.log（base64 编码） |
| `claude_cancel` | 同步 | 取消后台作业（SIGTERM → 10s grace → SIGKILL，含 pid identity 重校验） |

详细参数 / 调用决策 / 错误码表见 [`plugins/cc/skills/claude-delegation-runtime/SKILL.md`](./plugins/cc/skills/claude-delegation-runtime/SKILL.md)。

## 安装（本地）

```bash
codex mcp add claude-code -- node /path/to/cc-plugin-codex/plugins/cc/scripts/claude-broker.mjs
```

之后任何 Codex 会话都可让模型用本插件。卸载：`codex mcp remove claude-code && rm -rf ~/.local/state/cc-plugin-codex`

## 前置

- Node.js ≥ 18.18
- Claude Code CLI ≥ 2.1.107（需支持 `--session-id` / `--json-schema` / `--strict-mcp-config`）
- 任一认证：
  - **Claude 订阅**（推荐）：本机执行过 `claude /login`，OAuth keychain 已激活
  - 或 `ANTHROPIC_API_KEY` 环境变量
  - 或 `~/.claude/settings.json` 配 `apiKeyHelper`
- Codex CLI

## License

Apache-2.0
