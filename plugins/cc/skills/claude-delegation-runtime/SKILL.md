---
name: claude-delegation-runtime
description: Use when delegating tasks to local Claude Code from inside Codex. Defines when to call which of the six claude_* tools, the two-level permission model, the writes-acknowledgement protocol, and session continuity rules. Trigger on phrases like "ask Claude", "have Claude review", "delegate to Claude", or any time the user wants a second-opinion / focused-edit task that another instance of the Claude Code CLI is well-positioned to handle.
---

# Claude Code 委托运行时

通过这个插件你可以把任务委托给本机的 Claude Code CLI，并取回结构化结果。共暴露 6 个工具：

| 工具 | 适用场景 |
|------|---------|
| `claude_health` | 任何工具报错前先调一次（或 `refresh: true` 强制重探）。检查安装、认证、平台兼容性。 |
| `claude_ask` | **只读** 提问、解释、推理。默认 plan 模式，仅开 `Read/Grep/Glob`。 |
| `claude_review` | 请 Claude 对一组目标做**结构化审查**（输出严格遵循 review schema）。审查指令可选。 |
| `claude_task` | 委托一个**编辑任务**。默认 plan 模式只读出方案；`allow_writes: true` 切到 writes 模式实际改文件。`background: true` 异步跑，立即返回 `job_id`。 |
| `claude_job_get` | 查询后台作业状态 + 分页读取 `output.log`（`base64` 编码，靠 `output_offset/output_limit` 切片）。`wait: true` 阻塞到终态**或** `wait_timeout_sec`（默认 60s）到期，返回当前快照。 |
| `claude_cancel` | 取消后台作业。前台同步调用不可取消，但有 `timeout_sec` 兜底。 |

## 调用决策（按顺序判定）

1. **请求是只读问题（"为什么…"、"找出…"、"解释…"）** → `claude_ask`
2. **请求是审查 / 评估 / 找问题（"审一下"、"有没有 bug"、"安全问题"）** → `claude_review`
3. **请求是修改文件（"重命名"、"重构"、"添加测试"）** → `claude_task`
4. **任务可能跑很久（>1 分钟）或想并行做别的事** → 同上 `claude_task` 但加 `background: true`
5. **后台作业进度查询 / 查最终结果** → `claude_job_get`
6. **撤销已提交的后台作业** → `claude_cancel`

## 权限模型（两级）

| 级别 | 何时用 | flags |
|------|-------|-------|
| `plan`（默认） | `claude_ask` / `claude_review` / `claude_task` 默认 | `--permission-mode=plan --tools "Read,Grep,Glob"` |
| `writes` | `claude_task` 且 `allow_writes: true` | `--permission-mode=acceptEdits --tools "Read,Edit,Write,Grep,Glob"` |

**MVP 不支持 shell 工具**（Bash 会让默认约束失去意义）。

## 每工具入参速查

| 工具 | 必填 | 可选（注意点） |
|------|------|---------------|
| `claude_health` | — | `refresh: bool` |
| `claude_ask` | `prompt` | `session_id`, `model`, **`add_dirs`**, `timeout_sec` |
| `claude_review` | `target` (string\|string[]) | `instructions`, `session_id`, `timeout_sec` —— **不支持 `add_dirs` 或 `model`**，broker 会显式忽略 |
| `claude_task` | `task` | `files`, `session_id`, `allow_writes`, `writes_acknowledged`, `background`, `timeout_sec`, **`add_dirs`** |
| `claude_job_get` | `job_id` | `wait`, `wait_timeout_sec`, `output_offset`, `output_limit` |
| `claude_cancel` | `job_id` | — |

## ⚠️ allow_writes 首次调用：必须发出固定提醒

当某个 workspace **首次** 调用 `claude_task(allow_writes: true)` 时，broker 会返回：

```
{
  "error": "writes-need-acknowledgement",
  "hint": "..."
}
```

收到这个错误后，你 **必须先把以下内容逐字（含表情符号和换行）作为响应发给用户**，等用户明确同意，再重新调用本工具并附加 `writes_acknowledged: true`：

```
⚠️ 这是当前 workspace 第一次请求 claude_task 写入权限。
Claude 在 writes 模式下可以编辑 / 创建文件，且**不经 Codex approval 流程**。
请先和用户确认；用户同意后，重新调用本工具并加上 writes_acknowledged: true 即可继续。
确认后，本 workspace 后续 claude_task(allow_writes:true) 调用将免去再确认。
```

确认后 broker 会在 `$STATE_DIR/ack/` 下落 flag，本 workspace 之后的 `allow_writes:true` 调用免去再问。

**绝不允许**：未经用户同意自行加上 `writes_acknowledged: true`、改写或省略上述提醒文本。

## 会话续写（session_id）

- **跨调用记忆**：在一组逻辑相关的调用里传相同的 `session_id`（任意 UUID 即可，自己生成），Claude 会续写上下文。
- **首次调用即用 `session_id`**：broker 第一次见这个 id 时，Claude CLI 的 `--resume <uuid>` 会失败，broker 自动 fallback 到 `--session-id <uuid>` 创建新会话——你不用关心。
- **不传 `session_id`**：本次为 one-shot，Claude 端**不持久化**任何会话；返回里 `session_persisted: false`、`session_id: null`。
- **同 `session_id` 严格串行**：broker 用文件锁保证。并发提交的同 session 调用会排队等待。
- **不同 `session_id` 并发独立**。

## 后台作业生命周期（claude_task background: true）

```
queued → running → succeeded | failed | cancelled
```

- 提交后立刻返回 `{job_id, worker_pid, log_path}`，**不阻塞**。
- 后台 worker 是 detached 进程，broker 挂掉也跑得完。
- 用 `claude_job_get(job_id, wait: true)` 阻塞等终态；不传 `wait` 则只取一次快照。
- 用 `claude_cancel(job_id)` 取消：queued 直接收尾、running 向 Claude process group 发 SIGTERM（10s 后 SIGKILL）。

## 错误码速查（碰到任一时怎么办）

| 错误 | 含义 | 应对 |
|------|------|------|
| `auth-required` | Claude 未登录 | 提示用户跑 `claude /login`，或设 `ANTHROPIC_API_KEY` |
| `not-installed` | 没装 Claude CLI | 给安装指引：https://docs.claude.com/en/docs/claude-code |
| `platform-unsupported` | 不是 macOS/Linux | 不支持 Windows，告知用户 |
| `writes-need-acknowledgement` | 见上节，**必须**先发固定模板让用户确认 |
| `timeout` | 同步调用超时 | 看 `phase` 字段：`lock-wait` 表示锁排队；`run` 表示 Claude 跑超时，可加大 `timeout_sec` 重试。注意：`background:true` 后台作业 **不会** 返回这个错误（worker 当前不消费 `timeout_sec`） |
| `claude-nonzero-exit` | Claude 自己 exit !=0 | `stderr` 字段有详情；常见：API quota 用尽、prompt 被拒 |
| `claude-output-malformed` | Claude 没吐合法 JSON envelope | 通常是 Claude 本身崩了；用 `refresh: true` 跑 health 看是否环境问题 |
| `claude-review-schema-mismatch` | review 输出违反 schema | 重试一次；如果反复出现说明 prompt 有歧义 |
| `invalid-prompt` / `invalid-task` / `invalid-target` | 必填字段空或类型错 | 检查工具入参；查上面的"每工具入参速查" |
| `invalid-add-dirs` | `add_dirs` 不是数组 / 含非字符串 / 含相对路径 | 只传**绝对路径**字符串数组 |
| `forbidden-add-dir` | `add_dirs` 落入 `$STATE_DIR` 子树（broker 内部状态） | 换路径；不要试图让 Claude 看到 `~/.local/state/cc-plugin-codex` |
| `invalid-permission` / `invalid-cwd` / `invalid-schema` | broker 内部参数构造错（理论不该发生） | 写 issue |
| `workspace-detect-failed` | git/cwd 都解析失败 | 检查当前目录是否合法 |
| `writes-ack-write-failed` | 在 `$STATE_DIR/ack/` 写 flag 失败 | 检查磁盘空间 / 权限 |
| `worker-spawn-failed` / `worker-lstart-unreadable` / `spec-write-failed` | `claude_task(background:true)` 启动 worker 失败 | 通常是 fs 权限或资源问题；告诉用户重试或排查 broker 日志 |
| `session-busy` | 同 session 锁正忙、立即返回（仅当 `timeoutMs=0`） | 稍等重试 |
| `lock-io-error` / `lstart-unreadable` | 锁内部 IO 异常 | 一般稍等重试即可；多次出现写 issue |
| `duplicate-job` | 同 `job_id` 已存在（极罕见，UUID 碰撞） | 重新提交 |
| `missing-job` | 用了陈旧 job_id 句柄 | 重新提交 |
| `invalid-args` / `invalid-error` / `invalid-running-transition` | tracked-jobs helper 内部校验拒绝 | broker 实现 bug，写 issue |
| `job-not-found` | `job_id` 不存在或已过期清理 | 提示用户重新提交 |
| `pid-stale` | cancel 时进程身份已变（PID reuse） | 多半该作业已自己结束；用 `claude_job_get` 确认 |

## 不要做的事

- 不要为单次"试试看"提交 `background: true`——后台作业有持久化开销，only when truly long-running or parallelisable
- 不要在 `claude_review` 里覆盖 schema（broker 会拒绝；`claude_review` 用固定 schema 保证下游可预测）
- 不要把内部目录（`$STATE_DIR`，通常 `~/.local/state/cc-plugin-codex/`）放进 `add_dirs`——broker 会拒绝
- 不要假设 cancel 一定 12s 内完成——尤其 worker 已死但 Claude 还活着的极端情况，可能依赖 SIGKILL；用 `claude_job_get` 确认终态
