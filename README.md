# cc-plugin-codex

让 **Codex CLI** 直接与 **Claude Code** 交互的插件 —— Codex 里的模型可以主动把任务委托给本机 Claude Code，拿回结果用于审查、补洞、续写等场景。

这是 OpenAI 官方 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)（Claude Code → Codex 方向）的**对称镜像**版本，方向反过来：Codex → Claude Code。

## 当前状态

🏗 **Phase 1 完成**：MCP 握手 + `claude_health` 可用；其余工具为 stub，按设计分阶段落地。

- 经过 11 轮跨模型设计评审，零 Critical 落地方案：[需求文档](./docs/REQUIREMENTS.md) · [设计文档 v8b](./docs/DESIGN.md)
- 每个实现任务都走 **实现 → Codex 评审 → 修 Critical → 复核** 循环
- 单元测试 74/74 通过；本地 MCP 冒烟已验证 Codex ↔ broker 握手
- 后续阶段：Phase 2（同步 ask/review）、Phase 3（session 串行）、Phase 4（task 权限分级）、Phase 5（后台作业）、Phase 6（skills）、Phase 7（marketplace/文档）、Phase 8（回归 fixture）

## 设计亮点

- **架构**：薄 broker + 每次调用现起 `claude -p` 子进程；零 native 依赖
- **会话续写**：完全依赖 Claude 原生 `--session-id` / `--resume`，跨 `codex exec` 可续
- **认证**：自动适配 Claude 自身的认证链（订阅 OAuth / `ANTHROPIC_API_KEY` / `apiKeyHelper`）；订阅用户 `claude /login` 后开箱即用
- **递归防御**：默认 `--strict-mcp-config --permission-mode=plan --tools "Read,Grep,Glob"`，阻止 Claude 子进程再发现并调用本插件 MCP（**非安全沙箱**：CLAUDE.md / hooks / auto-memory 仍生效）
- **并发**：同 `session_id` 串行（mkdir 用户态锁 + pid/lstart 双因子 stale reclaim）
- **后台作业**：独立 detached worker；per-job mutex 消除 lost update；完整因果矩阵约束终态写入
- **平台**：macOS / Linux（POSIX）；不支持 Windows

## MCP 工具（Codex 模型可见）

| 工具 | 用途 |
|------|------|
| `claude_health` | 探测 Claude 安装 / 认证 / `--bare` 兼容性 |
| `claude_ask` | 自由提问（默认只读） |
| `claude_review` | 结构化代码审查（`--json-schema` 输出） |
| `claude_task` | 委托编辑任务（`plan` / `writes` 两级权限） |
| `claude_job_get` | 查询后台作业状态 / 分页读日志 |
| `claude_cancel` | 取消后台作业 |

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
