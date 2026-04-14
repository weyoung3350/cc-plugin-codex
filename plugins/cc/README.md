# cc-plugin-codex

让 **Codex CLI** 直接调用本机 **Claude Code CLI** 的 MCP 桥接插件。Codex 模型可以把任务委托给 Claude，拿回结构化结果。

> **⚠️ 这不是安全沙箱**。默认约束（`--strict-mcp-config --permission-mode=plan`）仅阻止常见误操作和插件递归互调；用户传 `add_dirs` 或 `allow_writes:true` 后 Claude 在允许范围内可自由读写。**`claude_task(allow_writes:true)` 下 Claude 的文件修改不经 Codex approval 流程**。详见下方"安全边界"。
>
> **平台**：macOS / Linux 仅。不支持 Windows。

## 前置

- Node.js ≥ 18.18
- Claude Code CLI ≥ 2.1.107
- 任一认证：
  - `claude /login`（订阅 OAuth keychain，**推荐**）
  - 或环境变量 `ANTHROPIC_API_KEY`
  - 或 `~/.claude/settings.json` 配 `apiKeyHelper`

## 安装（本地）

```bash
codex mcp add claude-code -- node /path/to/cc-plugin-codex/plugins/cc/scripts/claude-broker.mjs
```

之后在 Codex 任意会话里都可以让模型用本插件。

## 6 个工具

| 工具 | 同步/异步 | 用途 |
|------|----------|------|
| `claude_health` | 同步 | 检查 Claude 安装/认证/平台兼容性 |
| `claude_ask` | 同步 | 只读提问（plan 模式：Read/Grep/Glob） |
| `claude_review` | 同步 | 结构化代码审查（固定 JSON schema） |
| `claude_task` | 同步/后台 | 编辑任务（plan/writes 两级权限），`background:true` 起 detached worker |
| `claude_job_get` | 同步 | 查后台作业状态 + 分页读 output.log（base64） |
| `claude_cancel` | 同步 | 取消后台作业（SIGTERM → 10s grace → SIGKILL） |

详细 inputSchema / 调用决策 / 错误码速查见 [`skills/claude-delegation-runtime/SKILL.md`](./skills/claude-delegation-runtime/SKILL.md)。

## 安全边界（必读）

| 项 | 默认 | 危险时机 |
|---|---|---|
| Claude 工具集 | `Read,Grep,Glob`（plan）/ `Read,Edit,Write,Grep,Glob`（writes） | `claude_task(allow_writes:true)` 切到 writes 后**绕过** Codex approval |
| MCP 递归 | `--strict-mcp-config` 阻止 Claude 自动发现本插件 MCP | 用户若手动给 Claude 注册 MCP 仍可能互调 |
| 内部状态 | 存于 `$STATE_DIR=$XDG_STATE_HOME/cc-plugin-codex/`（默认 `~/.local/state/cc-plugin-codex/`）；broker 拒绝 add_dirs 落入此树 | 仅在用户主动改 `XDG_STATE_HOME` 把它指到 workspace 内部时有风险 |
| `allow_writes` 首次 ACK | broker 强约束：首次必须传 `writes_acknowledged:true` 且 SKILL 引导模型先向用户确认 | ACK 后整个 workspace（per `git rev-parse --show-toplevel`）后续 writes 调用免确认；ACK 状态存于 `$STATE_DIR/ack/<sha256(workspace_root)[:16]>.json` |
| Claude 子进程环境 | 继承 broker env，**包括** Claude 自己的 hooks / CLAUDE.md / auto-memory（`--bare` 已被移除以支持订阅 OAuth） | 用户的 `~/.claude/CLAUDE.md` 等会被加载；如不希望，跑前 `unset` 相关 env |

## 错误诊断

`claude_health({refresh:true})` 是任何工具报错的第一查询点。常见诊断：

| `warnings` | 含义 | 修复 |
|---|---|---|
| `["claude-not-installed"]` | 没装 Claude CLI | https://docs.claude.com/en/docs/claude-code |
| `["auth-required"]` | key 无效或未登录 | `claude /login` 或检查 `ANTHROPIC_API_KEY` |
| `["credit-exhausted"]` | API key 有效但账户余额 0 | https://console.anthropic.com/settings/billing 充值 |
| `["platform-unsupported"]` | Windows | 不支持，仅 macOS/Linux |
| `["probe-timeout"]` | Claude 30s 内无响应 | 网络/上游问题，重试或 `claude /doctor` |

完整错误码表见 [`skills/claude-delegation-runtime/SKILL.md`](./skills/claude-delegation-runtime/SKILL.md#错误码速查碰到任一时怎么办)。

## 卸载

```bash
codex mcp remove claude-code
rm -rf ~/.local/state/cc-plugin-codex
```

## License

Apache-2.0
