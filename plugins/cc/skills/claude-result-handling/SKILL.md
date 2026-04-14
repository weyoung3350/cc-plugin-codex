---
name: claude-result-handling
description: Use after invoking any cc-plugin-codex tool to interpret the result and present it to the user. Covers metadata vs content layout, session continuity, error-code triage, partial / truncated output, structured review payloads, and background-job pagination. Trigger whenever you've just received a response from claude_health / claude_ask / claude_review / claude_task / claude_job_get / claude_cancel.
---

# 把 Claude 的结果转成给用户看的输出

每个工具返回的 MCP `content[]` 数组结构是固定的；下面按工具说明如何阅读、提炼、转述。

## 通用结构

- 大多数工具的 `content` 第一项是**主体内容**（Claude 的回答 / 结构化对象），第二项是 metadata JSON。
- `isError: true` 时第一项就是错误 JSON（含 `error` / `hint` / 上下文字段）。
- 不要把 metadata 原样转给用户；提炼有用字段（如 `cost_usd`、`duration_ms`、`session_id`）做轻量摘要。

## claude_health

返回示例：
```
content[0]: "installed=true version=2.1.107 authenticated=true api_key_source=oauth platform_supported=true"
content[1]: { ...full state JSON... }
```

- `isError: true` 当 `installed/authenticated/platform_supported` 任一为 false 时
- `api_key_source` 取值：`oauth` / `env` / `helper` / `null`
- `warnings: ["credit-exhausted"]` → key 有效但账户没钱；引导用户去 https://console.anthropic.com 充值
- `warnings: ["platform-unsupported"]` → 当前在 Windows，无法继续

向用户转述时通常一句话：「Claude 2.1.107，已通过订阅认证」即可，除非有 warnings。

## claude_ask / claude_task（同步）

```
content[0]: "Claude 的回答文本"
content[1]: { session_id, session_persisted, cost_usd, duration_ms, truncated, captured_bytes, total_bytes }
```

- 直接把 `content[0]` 作为用户答案
- 如果 `truncated: true`：在末尾加「（输出超过 10MB 已截断）」
- 如果 `cost_usd > 0.1`：可考虑提一句成本
- 如果 `session_persisted: true`：保留这个 `session_id` 给后续相关调用（你来管理 session_id 的生命周期）

## claude_review

```
content[0]: { verdict, summary, findings[], next_steps[], session_id, session_persisted, ... }
isError: false
```

`verdict` 是 `"approve"` 或 `"needs-attention"`。

转述模板：

```
Claude 审查结论：<verdict>
摘要：<summary>

发现 <findings.length> 个问题：
1. [<severity>] <title>（<file>:<line_start>-<line_end>，置信度 <confidence>）
   <body>
   建议：<recommendation>
2. ...

后续动作：
- <next_steps[0]>
- ...
```

`severity` 优先级：`critical > high > medium > low`。Critical 必须高亮（红色 / 加粗）。

## claude_task（background: true）

```
content[0]: { job_id, worker_pid, log_path }
isError: false
```

提交后立刻告诉用户：
> 已提交后台作业 `<job_id>`，可以继续做别的；要查进度跟我说一声。

记下 `job_id`，用户问起就调 `claude_job_get`。

## claude_job_get

```
content[0]: {
  state,                    # queued | running | succeeded | failed | cancelled
  exit_code, exit_signal,   # 互斥：信号杀死时 exit_code=null/exit_signal="SIGTERM" 等
  error,                    # 可选：non-zero-exit / killed / timeout / spawn-failed / orphaned
  started_at_ms,
  ended_at_ms,
  cancel_requested,
  output: {
    chunk_base64,           # 这段输出，base64 编码
    encoding: "base64",
    returned_bytes,         # chunk_base64 解码后字节数
    next_offset,            # 下一次切片从这里开始
    total_bytes,            # 整个 output.log 的字节数
    eof,                    # true 表示作业已结束且 next_offset >= total_bytes
  }
}
```

阅读：

1. **状态判断**：`state` 决定继续等还是收尾
2. **解码输出**：`Buffer.from(output.chunk_base64, 'base64').toString('utf8')`
3. **分页继续读**：如果 `eof: false`，下次调用传 `output_offset: next_offset` 续读
4. **wait:true 的语义**：阻塞到终态**或** `wait_timeout_sec`（默认 60s）到期，先到为准。所以 `state` 仍可能是 `queued/running`——这是正常的中间快照，不是错误。如果用户希望"阻塞到完成"，自己加一层循环。
5. **失败诊断**：
   - `error: "non-zero-exit"` + `exit_code: 1` → 看输出末尾 stderr
   - `error: "timeout"` → 任务自身超时；建议用户拆任务
   - `error: "killed"` → 被外部信号杀（不是 cancel；可能是 OOM）
   - `error: "spawn-failed"` → broker 没成功起 Claude（认证 / binary 问题）
   - `error: "orphaned"` → broker 启动 sweep 时发现 worker 和 claude 都死了

转述模板（常见情况）：

```
作业 <job_id> 已完成（<state>，耗时 <ended_at_ms - started_at_ms>ms）。
最后输出：
<解码后的 output 末尾 N 行>
```

## claude_cancel

```
content[0]: {
  cancelled: true|false,
  reason?: "already-done" | "not-found" | "pid-stale",
  phase?: "queued" | "running",
}
```

- `cancelled: true` → 取消请求已发送，**但不一定立刻完成**；用 `claude_job_get(job_id, wait: true)` 确认终态
- `cancelled: false, reason: "already-done"` → 作业已先一步进入终态；告知用户「无需取消」
- `cancelled: false, reason: "not-found"` → `job_id` 不存在或已被清理
- `cancelled: false, reason: "pid-stale"` → Claude 进程身份变了（极少见，PID reuse），通常意味着作业其实已结束；用 `claude_job_get` 确认

## 通用失败 hint 处理

无论哪个工具，`isError: true` 时 `content[0]` 是 JSON 含 `error` + `hint`。**直接把 hint 转给用户**——它已经按场景写过了，不要替换或省略。

## 不要做的事

- 不要把 base64 chunk 直接展示给用户（要先解码）
- 不要"假定"作业完成——一定靠 `state` 字段判断
- 不要把 metadata 当主答案展示；用户关心的是 `content[0]` 的内容
- 不要为了"完整性"把整个 state JSON 贴出来——它有十几个字段，多数对用户无意义
