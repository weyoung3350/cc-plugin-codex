# cc-plugin-codex

让 **Codex CLI** 直接与 **Claude Code** 交互的插件 —— Codex 里的模型可以主动把任务委托给本机 Claude Code，拿回结果用于审查、补洞、续写等场景。

这是 OpenAI 官方 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)（Claude Code → Codex 方向）的**对称镜像**版本，方向反过来：Codex → Claude Code。

## 当前状态

🚧 **设计阶段**，尚未开始实现。

经过 11 轮跨模型设计评审，已产出可直接实施的零 Critical 技术方案，详见：

- [需求文档](./docs/REQUIREMENTS.md)
- [设计文档（v8b）](./docs/DESIGN.md)

## 设计亮点

- **架构**：薄 broker + 每次调用现起 `claude -p` 子进程；零 native 依赖
- **会话续写**：完全依赖 Claude 原生 `--session-id` / `--resume`，跨 `codex exec` 可续
- **安全边界**：默认 `--bare --permission-mode=plan --strict-mcp-config --tools "Read,Grep,Glob"`，受控子运行时（**非安全沙箱**）
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
- Claude Code CLI ≥ 2.1.105（需支持 `--bare` / `--session-id` / `--json-schema` / `--strict-mcp-config`）
- `ANTHROPIC_API_KEY` 或 `apiKeyHelper`（`--bare` 下不能用 OAuth keychain）
- Codex CLI

## License

Apache-2.0
