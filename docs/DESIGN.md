# cc-plugin-codex 设计文档

> Version: v8b | Status: Ready for implementation | Reviewed: 11 rounds, 0 Critical
>
> 本文档由 11 轮跨模型设计评审迭代而来，详细记录了架构决策、协议契约、并发模型、状态机、因果矩阵、验证基线等所有实施级约束。实施期间遇冲突以本文档为准。

## Context

用户希望为 **Codex CLI** 写一个插件，让 Codex 在当前会话中能把任务**委托**给本机的 Claude Code 并拿回结果（Claude delegation bridge），实现跨 agent 协作。

这是兄弟项目 `codex-plugin-cc`（OpenAI 官方，Claude Code → Codex 方向）**对称镜像**但**非完全等同** —— 因为 Codex 缺少 slash commands 和 lifecycle hooks，我们不试图复刻"广播式常驻 broker + 跨会话后台作业"那套模型。

### 采纳 Codex 二审后的 10 个核心收敛

1. **Architecture 薄 broker + 现起子进程**：不维护 in-memory session pool；会话续写全靠 Claude 原生 `--session-id <uuid>` / `--resume`
2. **默认运行约束**：`--permission-mode=plan --strict-mcp-config --output-format=json`，按需 `--add-dir <cwd>`、`--tools "Read,Grep,Glob"`。**这是默认约束，不是安全沙箱**（README 明写）
3. **MCP 工具收敛为 6 个**：`claude_health` / `claude_ask` / `claude_review` / `claude_task` / `claude_job_get` / `claude_cancel`
4. **后台作业独立 worker 进程**：`detached: true + unref()`，pidfile + logfile 落盘
5. **`claude_review`**：`--json-schema` + `--output-format=json` 一次性同步
6. **MVP 权限分级只两级**：`plan`（默认只读） / `writes`（`acceptEdits` + `Read/Edit/Write/Grep/Glob`）。**`allow_shell` 不在 MVP**
7. **`claude_cancel` 只接受 `{job_id}`**（不支持 `session_id`）：同步调用不支持取消，文档写清
8. **认证三选一**：Claude 自身的认证链生效（OAuth keychain 走订阅 → `ANTHROPIC_API_KEY` → `apiKeyHelper`，按 Claude CLI 自己的优先级）。`claude_health` 认证不通过直接阻止后续工具调用
9. **平台：macOS / Linux (POSIX)**；不支持 Windows（README metadata 明写）
10. **所有磁盘写入原子化**：`tmp + rename`；`state.json` 从不半截读

### 已验证事实

- Claude CLI `2.1.105+` 支持全部所需 flags：`--session-id <uuid>`、`--resume`、`--json-schema`、`--permission-mode`、`--strict-mcp-config`、`--tools`、`--add-dir`、`--output-format={text,json,stream-json}`、`--no-session-persistence`
- **不使用 `--bare`**：早期方案曾考虑用 `--bare` 隔离环境，但它会同时禁掉 OAuth keychain，让订阅用户无法使用。本设计把"防递归"职责完全交给 `--strict-mcp-config`（足以阻止 Claude 自动发现并调用本插件 MCP），CLAUDE.md / hooks / auto-memory 等本机配置保留生效。
- Codex 插件系统约定：`.codex-plugin/plugin.json` + `skills/*/SKILL.md` + `agents/*.yaml` + `.mcp.json` + `assets/`（已在 `~/.codex/plugins/cache/openai-curated/build-web-apps/` 实物验证）
- Codex 侧无 hooks、无 slash commands —— 用户入口就是 MCP 工具由 Codex 模型自主发现和调用

## Architecture (v2)

```
Codex CLI
 └─ plugin: cc-plugin-codex
     ├─ .codex-plugin/plugin.json   (清单 + marketplace 元数据)
     ├─ .mcp.json                   (声明 "claude-code" stdio MCP server)
     │
     └─ MCP broker 进程 (scripts/claude-broker.mjs)
         ├─ 实现 MCP stdio 协议 (initialize / tools/list / tools/call)
         ├─ 暴露 6 个工具 (见下)
         ├─ 【无状态】每次 tool call 现起 claude -p 子进程
         ├─ 会话续写 = 透传 session_id → claude --session-id / --resume
         │
         ├─ Background worker 路径:
         │   claude_task(background=true)
         │     └─ fork detached worker (scripts/claude-worker.mjs)
         │          ├─ 起 claude -p 子进程 (setsid + unref)
         │          ├─ 定期 patchJobIfNonTerminal(output_bytes) 更新日志进度
         │          ├─ 心跳仅更新 session-lock info.json 的 heartbeat_at_ms（不涉及 state.json）
         │          ├─ 输出流重定向到 $STATE_DIR/jobs/<job-id>/output.log
         │          └─ pidfile $STATE_DIR/jobs/<job-id>/pid
         │     worker 与 broker 进程独立，broker 挂掉不影响作业
         │
         ├─ 同 session_id 串行化: lib/session-lock.mjs
         │   $STATE_DIR/sessions/<session_id>.lock/ (mkdir 用户态锁)
         │
         └─ Skills (Codex 模型按需发现):
              skills/claude-delegation-runtime/SKILL.md  (何时用 / 怎么用这 6 个工具)
              skills/claude-result-handling/SKILL.md     (结果如何消化展示)
              skills/claude-prompting/SKILL.md            (如何给 Claude 写 prompt + rescue preset)
```

### 路径总表（权威，文中其他位置一切冲突以本表为准）

| 类别 | 绝对路径 | 谁写 | Claude 进程可见性 |
|------|----------|------|-------------------|
| **内部 state 根** `$STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/cc-plugin-codex/` | broker + worker | **永远不暴露给 Claude**（broker 拒绝把它放进 `--add-dir`） |
| session 锁 | `$STATE_DIR/sessions/<session_id>.lock/` | broker / worker | 不可见 |
| 后台作业根 | `$STATE_DIR/jobs/<job_id>/` | worker | 不可见 |
| 作业状态 | `$STATE_DIR/jobs/<job_id>/state.json` | worker（tmp+rename 原子写） | 不可见 |
| 作业日志 | `$STATE_DIR/jobs/<job_id>/output.log` | worker | 不可见 |
| health 缓存（进程内） | 无盘文件 | broker | 不可见 |
| **workspace ack flag** | `<workspace_root>/.cc-plugin-codex/allow_writes_acknowledged.flag` | broker | 仅用户显式 `add_dirs` 包含 workspace_root 时 Claude 可见；内部不存放任何其他数据 |
| 用户开放目录 | `add_dirs[]`（调用方传入） | Claude | 可读写（按权限级别） |

**注**：`workspace_root` 通过 `realpath(git rev-parse --show-toplevel 2>/dev/null || cwd)` 归一化；符号链接/嵌套 submodule 都以 realpath 为准，避免重复 ack。workspace 子目录用 `.cc-plugin-codex/`（仅存 ack flag，不存其他任何状态）。

### 后台作业状态机

```
          claude_task(background=true)
                    │
                    ▼
              ┌──────────┐
              │ queued   │  (state.json 创建，worker fork 中)
              └────┬─────┘
                   │ worker 拿 session 锁 + spawn claude
                   ▼
              ┌──────────┐
              │ running  │  (claude pid / lstart_raw 写入)
              └────┬─────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
  exit 0     exit !=0    claude_cancel
       │           │           │
       ▼           ▼           ▼
  succeeded    failed     cancelled
```

`state.json` 字段集 + 按状态可空性（所有字段都存在，按状态允许 `null`）：

| 字段 | 类型 | queued | running | succeeded | failed | cancelled |
|------|------|--------|---------|-----------|--------|-----------|
| `job_id` | string | ✓ | ✓ | ✓ | ✓ | ✓ |
| `state` | enum | ✓ | ✓ | ✓ | ✓ | ✓ |
| `session_id` | string\|null | 可 null | ✓ | ✓ | 可 null | 可 null |
| `session_persisted` | bool | ✓ | ✓ | ✓ | ✓ | ✓ |
| `worker_pid` / `worker_lstart_raw` | num/string | ✓ | ✓ | ✓（终态后仍留存用于审计，不再做 identity 校验） | ✓ | ✓ |
| `claude_pid` / `claude_lstart_raw` | num/string | null | ✓ | ✓ | 可 null（未 spawn 成功） | 可 null（queued 时取消） |
| `cancel_requested` | bool | ✓ | ✓ | ✓ | ✓ | ✓ |
| `created_at_ms` / `started_at_ms` / `ended_at_ms` | num/null | 起 null | started ✓ ended null | 全 ✓ | 全 ✓ | 全 ✓ |
| `exit_code` | num\|null | null | null | num | num\|null | num\|null（running 阶段取消时子进程被信号杀死 → null；queued 阶段取消 → null；正常 exit 记录数值） |
| `exit_signal` | string\|null | null | null | null | string\|null | string\|null（running 阶段取消通常为 `"SIGTERM"` 或 `"SIGKILL"`；queued 阶段取消为 null） |
| `error` | string\|null | null | null | null | string（`"timeout"\|"spawn-failed"\|"orphaned"\|...`） | null |
| `output_bytes` | num | ✓ | ✓ 实时 | ✓ 终值 | ✓ | ✓ |

**终态硬规则**：`state ∈ {succeeded, failed, cancelled}` 后，**仅允许**补写 `output_bytes`（日志 tail）和 `ended_at_ms` 的最后一次写入；**禁止**改 `state`、`exit_code`、`error`。

**统一 helper 契约**：`tracked-jobs.mjs` 提供**唯一四个**写入 API（全部走 per-job mutex 串行化），worker / cancel handler / orphan sweeper **禁止**绕过直接写 state.json：

- `createJob({job_id, ...initialFields})`：**首次创建** queued 状态的 state.json。实现：先 `fs.mkdir($STATE_DIR/jobs/<job_id>)`（`EEXIST` → 错误 `"duplicate-job"`），然后用 `fs.writeFile(state.json.tmp, ...)` + `fs.rename` 落地初始版本。这是**唯一允许不持锁写**的 API（因为首次创建不存在并发）
- `finalizeJobIfNonTerminal(job_id, {state, exit_code?, exit_signal?, error?, ended_at_ms})`：**持 per-job mutex** 执行 RMW。进入终态，读到已终态 → no-op 返回 false；非终态 → 写终态返回 true
- `patchJobIfNonTerminal(job_id, patch)`：**持 per-job mutex** 执行 RMW，用途**二合一**：
  - **非终态状态迁移**：`queued → running` 时 `patch` 可包含 `{state: "running", started_at_ms, claude_pid, claude_lstart_raw}`（只允许向非终态迁移；若 `patch.state` 为终态值必须走 `finalizeJobIfNonTerminal`）
  - **running 阶段补字段**：`output_bytes` 等动态字段
  - 读到终态 → no-op；读到非终态 → 按 patch 合并写入
- `requestCancel(job_id)`：**持 per-job mutex**，原子写入 `cancel_requested: true`；**终态下 no-op**（与终态硬规则一致：已是终态，cancel 已无意义，直接返回 `{cancelled: false, reason: "already-done"}`）

**Per-job mutex 实现**（关键正确性保障）：
- 锁体：目录 `$STATE_DIR/jobs/<job_id>/.write.lock/`，`fs.mkdir(path, {recursive: false})` 原子创建（`EEXIST` = 占用）
- 锁内容：`info.json` 存 `{owner_pid, owner_lstart_raw, acquired_at_ms}`（沿用 session-lock.mjs 同套 stale reclaim：`sameIdentity` 失败才强制回收）
- 锁粒度**短暂**（RMW 通常 <10ms），不设等锁超时，指数退避重试即可（2ms→10ms→50ms→250ms 上限 500ms）
- 释放：`fs.rm -r`

**为什么需要 mutex**：纯 `fs.rename` 只保证**单次写入**原子，不保证 read-modify-write 的**串行化**；两个并发 RMW 读到同版本 → 各自写回 → 后者覆盖前者（lost update）。典型场景：`patchJobIfNonTerminal(output_bytes)` 和 `finalizeJobIfNonTerminal(cancelled + exit_signal)` 竞争，cancelled 会被旧 running 覆盖。Per-job mutex 串行化消除此竞态。

**禁止**使用 `flock` 或任何 native 依赖；mutex 实现与 session-lock 完全同构（mkdir + pid/lstart 双因子）。`claude_cancel` / `worker child.on('exit')` / `orphan sweep` 都**只**通过这四个 API 改 state.json。

### 终态落盘因果矩阵（实现强制约束）

| 触发路径 | `state` | `exit_code` | `exit_signal` | `error` |
|---------|---------|-------------|---------------|---------|
| Claude 正常 exit(code=0) | `succeeded` | 0 | null | null |
| Claude 非零 exit(code!=0) | `failed` | num | null | `"non-zero-exit"` |
| Claude 被信号杀死（SIGTERM/SIGKILL 等） | `cancelled` 或 `failed` | null | string（如 `"SIGTERM"`） | null（cancelled）/`"killed"`（failed） |
| worker 在 running 阶段超时主动 SIGTERM Claude | `failed` | null | `"SIGTERM"` / `"SIGKILL"` | `"timeout"` |
| worker 在 **queued/lock-wait** 阶段超时（Claude 未 spawn） | `failed` | null | null | `"timeout"` |
| `claude_cancel` running 路径 | `cancelled` | null\*\* | string（`"SIGTERM"` 通常，超时后升 `"SIGKILL"`） | null |
| `claude_cancel` queued 路径 | `cancelled` | null | null | null |
| Claude 未 spawn 成功（认证失败、binary 不在） | `failed` | null | null | `"spawn-failed"` |
| orphan sweep 命中 | `failed` | null | null | `"orphaned"` |

\*\* `child.on('exit', (code, signal) => ...)` 回调里：若 `signal !== null` 则 `exit_code = null, exit_signal = signal`；若 `signal === null` 则 `exit_code = code, exit_signal = null`。两者**永远不同时非 null**。

所有终态写入**必须**通过 `finalizeJobIfNonTerminal()`，`exit_code` 和 `exit_signal` 按上表填写；**禁止**丢 `exit_signal`。

### 进程存活模型

| 场景 | 子进程宿主 | broker 挂掉后果 |
|------|-----------|-----------------|
| 同步调用（ask/review/task sync） | broker 的短命子进程；broker **持有** session 锁 | 调用失败返回；锁通过进程退出自然释放或下次 stale reclaim |
| 后台作业（task background） | 独立 detached worker；**worker 持有** session 锁直到 Claude 退出 | 无影响；锁随 worker 进程存续或 stale reclaim |
| 会话续写 | 无状态，靠 Claude 原生 session 持久化 | 无影响；同一 session_id 下次调用自动 resume |

**后台 session 串行协议**：`claude_task(background=true, session_id=X)` 时，worker fork 后立刻进入 **`queued` 状态**写 `state.json`；worker 进入**等锁循环**（同步路径相同的指数退避），每次 poll 都检查 `cancel_requested`（见 queued 取消协议）。成功获 `<X>.lock` 后转 `running` 并 spawn Claude。**失败路径只有三条**：① `timeout_sec` 超时 → `state=failed, error="timeout"`；② `cancel_requested=true` → `state=cancelled`；③ spawn 本身失败（Claude 不存在/认证失败）→ `state=failed, error="spawn-failed"`。争锁失败本身**不算失败**，持续等待即可。锁在 worker 正常结束或 stale reclaim 时释放。

### session_id 创建/续写协议（无状态 broker 如何判定 "已知"）

broker **不维护** seen-session 索引。协议：**总是先 `--resume <uuid>`，失败 fallback 到 `--session-id <uuid>`**。

- 调用方传 `session_id: <uuid>` → broker 第一次执行 `claude -p --resume <uuid> ...`
- Claude CLI 对不存在的 session 以非零 exit + 特定 stderr（`"no session with id"` 或 `exit code 1` 结合 stderr 模式匹配）退出
- `claude-run.mjs` 捕捉到此错误模式 → **同锁内**立即以 `--session-id <uuid>`（新建）重试一次；成功返回
- 重试不进入等锁队列，不释放 session 锁，单次 fallback
- 若重试仍失败（非 session 不存在的其他错误）→ 透传错误给调用方
- 调用方不传 `session_id` → one-shot 路径，强制 `--no-session-persistence`，返回 `session_persisted: false`

这样**唯一失败面**是 Claude CLI stderr 格式变更；`fake-claude-fixture` 必须覆盖 resume-then-create 路径，并在 Claude CLI 版本升级时作为回归基线。

### queued 状态的取消协议

`claude_cancel(job_id)` 路径分支：

1. 读 `state.json` → **原子写** `cancel_requested: true`（终态硬规则仍适用，终态下 no-op 返回 `{cancelled: false, reason: "already-done"}`）
2. 根据 `state` 分派：
   - `queued`（worker 在等锁）：worker 的等锁循环每次 poll 都检查 `cancel_requested`，看到 true 立即写 `state = cancelled`（含 ended_at_ms）并退出；**不发任何信号**；`claude_cancel` 返回 `{cancelled: true}`
   - `running`（claude 已 spawn）：对 `claude_pid` 做 `sameIdentity`，通过则 `process.kill(-claude_pid, 'SIGTERM')`，10s 后 `SIGKILL`；worker 监听 `child.on('exit', ...)`（Node 层抽象，不手工处理 SIGCHLD），写 `state = cancelled`
   - 终态：no-op，返回 `{cancelled: false, reason: "already-done"}`
3. worker 在**拿锁后、spawn claude 前**也做一次 `cancel_requested` 检查，发现已请求直接写终态退出（避免竞态：cancel 恰好发生在等锁末尾 → spawn 之前）

### 取消信号契约

后台作业的进程结构：`worker（Node）→ claude 子进程（作为 process group leader）`。

**必须约定**：
- worker 用 `spawn(..., { detached: true })` 启动 claude 子进程，使其**自成 process group**（`setsid`）
- state.json 同时记录 `worker_pid/worker_lstart_raw` **与** `claude_pid/claude_lstart_raw`
- `running` 状态的取消执行路径（见上文 queued 协议处理 queued 分支）：
  1. 读 state.json 取 `{claude_pid, claude_lstart_raw}`
  2. `sameIdentity(claude_pid, claude_lstart_raw)` 校验，失败 → `{cancelled: false, reason: "pid-stale"}`
  3. 成功则向 claude process group 发 SIGTERM：`process.kill(-claude_pid, 'SIGTERM')`
  4. 10s 后仍存活 → `process.kill(-claude_pid, 'SIGKILL')`
  5. worker 的 `child.on('exit', (code, signal) => ...)` 回调通过 `finalizeJobIfNonTerminal(..., {state: "cancelled", exit_code: null, exit_signal: signal, ended_at_ms})` 收尾（因果矩阵：信号杀死 → `code=null, signal=非null`；mutex + 终态硬规则保证并发安全）
- **不向 worker 发信号**，只向 claude process group 发；worker 自然通过 `child.on('exit')` 收尾
- 保证 `≤12s` 终止契约不依赖 worker 转发

### 并发模型

**锁实现：纯 Node 用户态锁**（不用 `flock` 系统调用，零 native 依赖）。

- **锁体**：目录 `<state_dir>/sessions/<session_id>.lock/`（`fs.mkdir(path, {recursive: false})` 原子创建；`EEXIST` = 获锁失败）
- **锁内容**：`info.json` 存 `{owner_pid, owner_lstart_raw, acquired_at_ms, request_id, heartbeat_at_ms}`
- **Heartbeat**：持锁进程每 5s 用 `tmp + rename` 更新 `heartbeat_at_ms`
- **Stale 回收 — 严格双因子（heartbeat 只诊断不触发）**：获锁失败时读 `info.json`，**仅以下两条任一成立才回收**：
  1. `kill(owner_pid, 0)` 返回 ESRCH（进程不存在）
  2. `kill(0)` 成功但 `ps -o lstart= -p <pid>`（`LC_ALL=C` 强制）与 `owner_lstart_raw` 字符串不等（pid reuse）
- **heartbeat 超时不触发回收**：避免 sleep / SIGSTOP / GC / 长 Claude 子进程等合法阻塞被误判为死锁；`heartbeat_at_ms > 30s` 未更新时仅写一条 broker stderr warning，不影响锁归属
- **等待**：非 stale → 指数退避轮询（10ms→50ms→250ms→1s，上限 2s）；由调用方的 `timeout_sec` 决定放弃时机
- **释放**：持锁进程正常结束时 `fs.rm -r` 锁目录；SIGTERM/SIGKILL 退出靠 stale 回收
- **不同 `session_id` 可并发**
- **无 `session_id` 的 one-shot（硬规则）**：`claude_ask/review/task` 调用时未传 `session_id` → broker **强制**追加 `--no-session-persistence` 到 claude 命令行；响应体 `session_id: null, session_persisted: false`；Claude 侧不会留下任何 session 记录
- **不承诺队列深度/busy 返回**

**为什么不用 flock/proper-lockfile/fs-ext**：Node core 无 flock API；macOS 命令行 `flock` 默认缺失；后两者是 native 依赖，会打破零依赖目标。

### PID identity 共享契约

`lib/pid-identity.mjs` 对外提供 `readLstart(pid): string | null` 和 `sameIdentity(pid, lstart_raw): boolean`。实现：

```js
spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } })
```

**一律只存和比对 `lstart_raw` 字符串**，不 parse 成 `start_ms`（避开 locale/时区问题）。所有访问外部 pid 的路径都必须先过 `sameIdentity` 校验：

- `session-lock.mjs` stale reclaim
- `tracked-jobs.mjs` orphan sweep
- `claude_cancel(job_id)` 发信号前
- `claude_job_get` 读取 `state.json` 如需判断 `running` 时

**任何 signal 调用（SIGTERM/SIGKILL）前不做 identity 校验即视为实现缺陷**。失败路径返回 `{cancelled: false, reason: "pid-stale"}`，**不发信号**。

### 权限边界（MVP 两级，非安全沙箱）

| 级别 | 触发 | flags |
|------|------|-------|
| `plan`（默认） | `claude_ask` / `claude_review` / `claude_task` 默认 | `--permission-mode=plan --tools "Read,Grep,Glob" --bare --strict-mcp-config` |
| `writes` | `claude_task` 且 `allow_writes: true` | `--permission-mode=acceptEdits --tools "Read,Edit,Write,Grep,Glob"` |

- 所有级别都追加 `--add-dir <cwd>`（cwd 来自 tool 调用参数，缺省为 broker 启动 cwd）
- **明确声明不是安全沙箱**：用户传 `add_dirs` 可扩大访问面。`$STATE_DIR` 在 `$HOME/.local/state/` 下，**broker 启动时拒绝任何 `add_dirs` 项落入 `$STATE_DIR` 子树**（realpath 前缀比对），防止 Claude 触达内部状态
- **`allow_shell` / `--tools "default"` 不在 MVP**（Bash 工具会让边界彻底失去意义，后续版本再评估）

## MCP 工具规范（6 个）

| 工具 | 输入 | 返回 | Claude 调用形态 |
|------|------|------|-----------------|
| `claude_health` | `{refresh?: bool}` | `{installed, version?, authenticated, api_key_source: "oauth"\|"env"\|"helper"\|null, platform_supported, warnings[], checked_at_ms}` | `claude --version` + `claude -p --strict-mcp-config --no-session-persistence --output-format=json --permission-mode=plan --tools "Read,Grep,Glob" --add-dir <cwd>`（prompt "ok" 经 stdin 而非 argv，避免被 `--add-dir`/`--tools` variadic 吞掉；与正式 `claude_ask` 同 flags 避免漂移） |
| `claude_ask` | `{prompt, session_id?, model?, add_dirs?: string[], timeout_sec?: int}` | `{text, session_id, session_persisted, cost_usd?, duration_ms, truncated: bool, captured_bytes, total_bytes?}` | `claude -p --output-format=json --bare --permission-mode=plan --strict-mcp-config --tools "Read,Grep,Glob" --add-dir <cwd> [每个 add_dirs 追加 --add-dir] <session 分支> <prompt>`。**session 分支唯一协议**（见「session_id 创建/续写协议」小节）：有 `session_id` → 先 `--resume <uuid>`，失败（按 fixture stderr 模式）**同锁内单次 fallback** 到 `--session-id <uuid>`；未传 → **强制** `--no-session-persistence` |
| `claude_review` | `{target, instructions?, session_id?, timeout_sec?: int}` | review schema 结构体 + `{truncated, captured_bytes, session_id, session_persisted}` | 同 `claude_ask` flags + `--json-schema '<review-output.schema>'`（固定 schema） |
| `claude_task` | `{task, files?, session_id?, allow_writes?: bool, writes_acknowledged?: bool, background?: bool, timeout_sec?: int}` | 同步: `{text, session_id, session_persisted, cost_usd?, truncated, captured_bytes}`；后台: `{job_id, worker_pid, log_path}` | 同 `claude_ask` flags；`allow_writes=true` 切 writes 级；后台 fork detached worker（worker 持锁 + claude 作为 process group leader） |
| `claude_job_get` | `{job_id, wait?: bool, wait_timeout_sec?: int, output_offset?: int, output_limit?: int}` | `{state, exit_code: num\|null, exit_signal: string\|null, cost_usd?, started_at_ms, ended_at_ms?, error?: string\|null, output: {chunk_base64: string, encoding: "base64", returned_bytes: int, next_offset: int, total_bytes: int, eof: bool}}` | 纯读 `state.json` + `output.log` **字节切片 base64 返回**（规避 UTF-8 边界） |
| `claude_cancel` | `{job_id}` | `{cancelled: bool, reason?: "pid-stale"\|"already-done"\|"not-found", exit_code?: num\|null, exit_signal?: string\|null}` | 见「queued 取消协议」+「取消信号契约」。`running` 路径：读 `{claude_pid, lstart_raw}` → `sameIdentity` 校验 → SIGTERM → 10s → SIGKILL；identity 失败返回 `reason: "pid-stale"` 不发信号 |

**工具设计约定**：

- **统一超时与预算拆解**：
  - **同步工具**：`timeout_sec` 默认 300s，拆三阶段：
    1. 等锁阶段：`timeout_sec` 的 0~N 秒；超时 → `{error: "timeout", phase: "lock-wait"}`
    2. Claude 运行阶段：剩余预算传子进程；`claude-run.mjs` 定时器 SIGTERM
    3. 清理阶段：SIGTERM 后固定 10s 宽限 → SIGKILL；此 10s **不计**入 `timeout_sec`
  - **后台工具**（`claude_task(background=true)`）：`timeout_sec` 语义是 **worker 运行总预算**（从 worker 拿锁 + 运行 claude + 清理，整体上限）；broker 侧"提交作业" <1s 不计入。worker 自己维护定时器；超时 SIGTERM claude process group，`child.on('exit', (code, signal) => finalizeJobIfNonTerminal(..., {state: "failed", exit_code: null, exit_signal: signal, error: "timeout"}))`（见因果矩阵）
  - 超时响应统一 `{error: "timeout", phase, partial_text?, captured_bytes}`（同步）或 `state: "failed", error: "timeout"`（后台）
- **Health 缓存语义**：broker 进程启动时执行一次 health check，结果写入进程内 `healthState`。所有非 `claude_health` 工具入口**强校验** `healthState.installed && healthState.authenticated && healthState.platform_supported`，失败直接返回 `{error: "auth-required" | "not-installed" | "platform-unsupported", hint}`。`claude_health({refresh: true})` 可手动重探。TTL 不做自动过期（用户显式刷新）。
- **`allow_writes` 轻量硬约束（workspace 作用域）**：flag 路径 `<workspace_root>/.cc-plugin-codex/allow_writes_acknowledged.flag`（见路径总表，workspace_root 经 realpath 归一化）。首次 `claude_task(allow_writes: true)` 必须同传 `writes_acknowledged: true`；flag 不存在且 `writes_acknowledged` 缺失 → `{error: "writes-need-acknowledgement", hint: "...固定模板..."}`；确认后原子写 flag，后续免再传
- **review schema 固定**：`claude_review` 不接受调用方覆盖 schema，避免多版本兼容
- **`claude_cancel` 仅 job_id**：同步工具不可取消，但有 `timeout_sec` 兜底
- **`claude_job_get` 分页契约**：`output_offset` 默认 0，`output_limit` 默认 65536；`eof=true` 表示作业已结束且 `offset >= total_bytes`
- **`captured_bytes` / `total_bytes` / `truncated`**：一律为**字节数**（`Buffer.byteLength(str, 'utf8')`），非 JS 字符串长度；10MB 截断门槛按字节；分页 offset 也按字节切
- **one-shot 无 session_id 返回**：`claude_ask/review/task` 若调用时无 `session_id` 输入，返回体中 `session_id: null, session_persisted: false`；有输入则透传并 `session_persisted: true`

### 与 v1 的差异总结

| 项 | v1 | v2 |
|----|----|----|
| 工具数 | 7 | 6（`rescue` 下沉 skill，`status`+`result` 合并为 `job_get`） |
| session_id | 外部↔内部双向映射 | 直接用 Claude 原生 UUID |
| 后台作业 | broker 内存 Map 管 | detached worker + pidfile |
| 运行约束 | 未指定 | 默认 `--bare --strict-mcp-config --permission-mode=plan` |
| `claude_review` 输出 | broker 解析流 | `--json-schema` 一次性 |
| 健康检查 | 无 | 新增 `claude_health` |
| 权限分级 | 无 | plan / writes 两级（shell 不在 MVP） |

## 目录结构

```
cc-plugin-codex/
├── README.md                                   # 强调范围: delegation bridge, 非完全镜像, 安全边界
├── LICENSE                                     # Apache-2.0
├── NOTICE
├── package.json                                # type: module, engines node>=18.18
├── package-lock.json
├── tsconfig.app-server.json                    # JSDoc checkJs + noEmit
├── scripts/
│   └── bump-version.mjs
├── tests/
│   ├── broker.test.mjs                         # MCP 协议黑盒
│   ├── session-lock.test.mjs                   # 并发锁语义
│   ├── worker.test.mjs                         # 后台作业独立存活
│   ├── review-schema.test.mjs                  # --json-schema 路径
│   └── fake-claude-fixture.mjs                 # 模拟 claude -p，产生 json/stream-json 输出
└── plugins/
    └── cc/
        ├── .codex-plugin/
        │   └── plugin.json
        ├── .mcp.json
        ├── README.md                           # 中文，面向用户
        ├── CHANGELOG.md
        ├── LICENSE / NOTICE
        ├── agents/
        │   └── openai.yaml                     # marketplace 元数据
        ├── assets/
        │   ├── cc-plugin-codex-small.svg
        │   └── app-icon.png
        ├── schemas/
        │   └── review-output.schema.json       # 从 sibling 照搬
        ├── skills/
        │   ├── claude-delegation-runtime/
        │   │   └── SKILL.md                    # 何时调用 / 工具语义 / 权限矩阵
        │   ├── claude-result-handling/
        │   │   └── SKILL.md
        │   └── claude-prompting/
        │       └── SKILL.md                    # 含 rescue preset 模板
        └── scripts/
            ├── claude-broker.mjs               # MCP server 主入口（无状态）
            ├── claude-worker.mjs               # 后台作业独立 worker
            └── lib/
                ├── mcp-server.mjs              # stdio JSON-RPC 协议
                ├── claude-run.mjs              # 组装 claude -p 参数 + spawn（核心）+ 超时控制
                ├── permission.mjs              # 两级权限（plan / writes）→ flag 映射
                ├── session-lock.mjs            # mkdir 用户态锁 + heartbeat + stale reclaim
                ├── pid-identity.mjs            # {pid, lstart_raw} 双因子（ps -o lstart= + LC_ALL=C，只存字符串不 parse）
                ├── tracked-jobs.mjs            # jobs 目录读写（全部 tmp+rename 原子写）
                ├── health.mjs                  # health 探测 + 进程内缓存
                ├── review-schema.mjs           # 固定 schema 注入
                ├── render.mjs                  # 给 Codex 模型消化友好的摘要
                ├── args.mjs / fs.mjs / process.mjs / workspace.mjs
                └── xdg.mjs                     # $STATE_DIR 路径策略
```

## Critical Files（实现顺序）

1. `plugins/cc/.codex-plugin/plugin.json` — 插件清单
2. `plugins/cc/.mcp.json` — 声明 stdio MCP server
3. `plugins/cc/scripts/lib/mcp-server.mjs` — MCP stdio（initialize / tools/list / tools/call）
4. `plugins/cc/scripts/lib/permission.mjs` — **两级权限**（`plan` / `writes`）→ flags 映射
5. `plugins/cc/scripts/lib/pid-identity.mjs` — `readLstart(pid) / sameIdentity(pid, lstart_raw)`；`ps -o lstart= -p <pid>` 强制 `LC_ALL=C`，只存比对字符串
6. `plugins/cc/scripts/lib/claude-run.mjs` — 统一 `spawn('claude', [...])` + `timeout_sec` + 输出捕获 + 截断标记
7. `plugins/cc/scripts/lib/health.mjs` — health 探测 + 进程内缓存 + `assertHealthy()` 辅助
8. `plugins/cc/scripts/lib/session-lock.mjs` — mkdir 用户态锁（依赖 `pid-identity.mjs`）
9. `plugins/cc/scripts/lib/tracked-jobs.mjs` — jobs 读写（全部 tmp+rename 原子）
10. `plugins/cc/scripts/claude-worker.mjs` — detached worker；state.json 全部走 tracked-jobs 四个 helper；另每 5s 更新 session-lock info.json 的 heartbeat_at_ms
11. `plugins/cc/scripts/claude-broker.mjs` — 装配 6 个工具 handler，启动时跑 health，拦截 auth-required
12. `plugins/cc/skills/*/SKILL.md` ×3（中文）— `claude-delegation-runtime` 含 `allow_writes` 首次提醒的固定模板
13. `plugins/cc/agents/openai.yaml` + `plugins/cc/schemas/review-output.schema.json`
14. `plugins/cc/README.md` + 根 `README.md`（第一屏声明非安全沙箱、POSIX-only）
15. `tests/*.test.mjs` + `fake-claude-fixture.mjs`
16. 工程骨架：`package.json` / `scripts/bump-version.mjs` / `LICENSE` / `NOTICE`

## 复用兄弟项目

- `lib/args.mjs` / `lib/fs.mjs` / `lib/process.mjs` / `lib/workspace.mjs` 直接搬
- `lib/render.mjs` 参考 `renderTaskResult / renderReviewResult` 模式，改写成 Claude 输出适配
- `schemas/review-output.schema.json` 照搬
- 工程骨架（`package.json`、`tsconfig.app-server.json`、`bump-version.mjs`、`LICENSE`、`NOTICE`）照搬改名
- **不复用** `app-server-broker.mjs` 的 socket 多路复用（v2 架构无需）
- **不复用** `lib/app-server.mjs` 的 JSON-RPC 客户端（v2 没有 app-server 对端）

## Verification

### Phase 冒烟
```bash
cd /Users/dna/Documents/Develop/claude_prj/cc-plugin-codex
npm install && npm test

# 注册 MCP server 到 Codex
codex mcp add claude-code -- node plugins/cc/scripts/claude-broker.mjs
codex mcp get claude-code   # 确认 6 个工具都出现
```

### 功能检查点

1. **健康检查**：`claude_health` 分别报告 `installed / authenticated / api_key_source ∈ {oauth, env, helper, null} / platform_supported`，未认证时后续工具直接返回错误
2. **同步只读**：默认 `claude_ask` plan 模式可问不可改
3. **原生会话续写**：同一 `session_id` 两次调用记住上下文
4. **跨 codex-exec 续写**：两个独立 `codex exec` 传同一 `session_id` 仍能续
5. **broker 重启恢复**：杀 broker 重启，后台 job 状态通过 `claude_job_get` 可读
6. **独立后台作业**：`claude_task(background=true)` 启动后杀 broker，worker 跑到完成
7. **结构化审查**：`claude_review` 输出严格符合 schema
8. **同 session 串行**：并发两次 `claude_ask(session_id=X)`，第二次等第一次完才跑（无超时打穿）
9. **长任务不打穿串行**：session 锁持锁 >2 分钟，第二次调用等待不被自动释放（owner pid 探活通过）
10. **持锁进程崩溃释放**：`kill -9` 持锁进程后第二次调用应在秒级内获得锁
11. **跨 session 并行**：`session_id=X` 和 `Y` 并发正常
12. **权限默认只读**：默认 `claude_task` 不写盘
13. **显式 writes 生效**：`allow_writes=true` 文件变更落盘
14. **前台取消不支持**：`claude_cancel(无 job_id)` 拒绝；只有后台 job 可取消
15. **取消生效**：`claude_cancel(job_id)` ≤ 12s 进程终止（10s SIGTERM 宽限 + 处理）
16. **长输出分页**：`output.log` >10MB，`claude_job_get(offset, limit)` 可切片完整读回
17. **孤儿作业清理（仅非终态）**：broker 启动扫 `$STATE_DIR/jobs/*/state.json`；**仅处理 `state ∈ {queued, running}`**，终态绝不改写。规则：
    - `queued`：只校验 `worker_pid`。`sameIdentity` 失败 → 标记 `state=failed, error="orphaned"`
    - `running`：必须 `sameIdentity(worker_pid, worker_lstart_raw)` **和** `sameIdentity(claude_pid, claude_lstart_raw)` **双双失活**才算孤儿。任一仍活（例如 worker 死但 claude 还在跑）则**保持 running 不动**（由 Claude 自然结束路径或下次 cancel 处理）
    - 所有写入走 `finalizeJobIfNonTerminal()` 原子 RMW（见下文 helper）
18. **递归防御对照实验**：本插件**不再使用 `--bare`**（订阅 OAuth 兼容性需要），改用 `--strict-mcp-config` 阻止 Claude 子进程发现并调用本插件 MCP（避免 Claude→Codex→Claude 互调）。验证：在测试夹具里向 Claude 注入一个伪 `~/.claude.json` 注册一个 `cc-plugin-codex` MCP server，然后 `claude_ask("列出你能用的 MCP 工具")`；在我们的 `--strict-mcp-config` 下 **不应** 出现 `claude_*` 工具；移除 `--strict-mcp-config` 反证应出现。CLAUDE.md / hooks / auto-memory 不再做隔离声明（设计上已允许它们生效）。
19. **原子写**：并发写 `state.json` 时任何读取必须读到完整 JSON（非半截）
20. **`allow_writes` 硬约束 + 固定模板存在性**：自动化校验两点（模型行为不纳入 CI）：① `grep` `claude-delegation-runtime/SKILL.md` 存在固定提醒模板字符串；② broker ack gate：flag 不存在时 `claude_task(allow_writes=true, writes_acknowledged=undefined)` 返回 `error: "writes-need-acknowledgement"`；传 `writes_acknowledged=true` 后写 flag 成功
21. **平台**：macOS / Linux 跑通全部用例；Windows 启动时 `claude_health` 返回 `warnings: ["platform-unsupported"]`

### 回归基准（fake-claude-fixture）
覆盖 `claude -p` 的以下场景：
- `--output-format=json` 正常单次返回
- `--output-format=stream-json` 多事件
- `--json-schema` 结构化输出
- **session 协议**：`session-resume-hit`（已有 session, `--resume` 成功）/ `session-resume-miss-then-create`（`--resume` 失败 → **同锁内** `--session-id` 重试成功）/ `session-resume-miss-then-create-fail`（两次都失败透传错误）；fixture 用例名必须包含这三个关键字，断言顺序严格 `--resume` 先 `--session-id` 后
- 子进程提前 kill
- stderr 错误输出（认证失败、未安装、session 不存在的 stderr 字符串模板）
- 超时 kill

## 实施阶段

1. **Phase 1 骨架 + health**：`plugin.json` + `.mcp.json` + `mcp-server.mjs` + `health.mjs`；Codex 跑通握手
2. **Phase 2 同步 ask/review**：`claude-run.mjs`（含 `timeout_sec` 和截断标记）+ `permission.mjs`（两级） + `review-schema.mjs`；`claude_ask` / `claude_review` 可用
3. **Phase 3 session 串行**：`pid-identity.mjs` + `session-lock.mjs`，同 session 串行；覆盖 stale 回收用例
4. **Phase 4 task 同步 + 两级权限**：`claude_task`（plan / writes），`writes_acknowledged` 硬约束
5. **Phase 5 后台 worker**：`claude-worker.mjs` + `tracked-jobs.mjs`（原子写） + `claude_task(background)` + `claude_job_get`（分页） + `claude_cancel(job_id)`
6. **Phase 6 skills**：3 个 SKILL.md；`claude-delegation-runtime` 含 `allow_writes` 首次固定提醒模板
7. **Phase 7 marketplace + 文档**：`agents/openai.yaml` + `assets/` + README（第一屏声明非沙箱、POSIX-only、Codex approval 被绕过）
8. **Phase 8 测试与 fixture**：fake-claude-fixture + **21 个功能检查点**全部自动化

## 风险与留意项（v8b）

### 安全/边界
- **这不是安全沙箱**：默认约束（`--strict-mcp-config --permission-mode=plan`）能阻止 MCP 递归互调和常见误操作，但用户若传大 `add_dirs` 或 `allow_writes=true`，Claude 会在允许范围内自由读写；CLAUDE.md / hooks / auto-memory 也都生效（这是订阅 OAuth 可用的必要代价）。README 第一屏用粗体声明
- **Codex approval 被绕过**：`claude_task(allow_writes=true)` 下 Claude 的文件修改不经 Codex 自身审批。SKILL.md 附**固定模板**（逐字）要求 Codex 模型首次调用时向用户显式确认
- **`allow_shell` 不在 MVP**：Bash 工具会让默认约束失去意义，后续版本单独评估
- **认证前置**：`claude_health` `authenticated=false` 时，所有其他工具直接返回 `{error: "auth-required", hint: "...登录命令..."}`。Claude 自身的认证链按 OAuth keychain → `ANTHROPIC_API_KEY` → `apiKeyHelper` 顺序生效；订阅用户运行 `claude /login` 即可。`api_key_source` 在 probe 成功且 env/helper 都没配时反推为 `"oauth"`

### 运行时
- **并发锁**：mkdir 用户态锁 + `{owner_pid, owner_lstart_raw}` 双因子 stale reclaim（`sameIdentity` 失败才强制释放）；heartbeat 仅作诊断，不触发回收；否则等 `timeout_sec` 放弃。详见「并发模型」
- **不承诺队列深度**：MVP 语义就是"锁住就等"
- **孤儿作业（仅非终态）**：broker 启动扫 `$STATE_DIR/jobs/*/state.json`，**只处理 `queued | running`**，终态作业绝不改写。`queued` 只校验 `worker_pid`；`running` 需 `worker_pid` 和 `claude_pid` **双双失活**才算孤儿；命中则标记 `state=failed, error="orphaned"`。详见检查点 17
- **原子写**：`tracked-jobs.mjs` 所有写操作 `tmp + rename`，避免读半截 JSON

### 部署
- **平台**：macOS / Linux（POSIX）。Windows 不支持；启动时 `claude_health` 返回 `platform_supported: false, warnings: ["platform-unsupported"]`
- **本地分发**：`codex mcp add claude-code -- node <abs-path-to-broker.mjs>`；marketplace 分发不在 MVP
- **文档语言**：README / SKILL.md / 工具 description 中文；代码和注释英文
- **state 目录**：默认 `$XDG_STATE_HOME/cc-plugin-codex/`（缺省 `$HOME/.local/state/cc-plugin-codex/`），**不放在** `cwd`，避免被用户加入 `add_dirs` 的 Claude 进程触达内部状态。workspace 级 `allow_writes_acknowledged.flag` 单独放 workspace_root 下（上文已定义）

### 输出处理
- **同步输出截断**：`claude_ask` 超过 10MB 返回 `{text, truncated: true}`
- **后台作业分页**：`output.log` 不截断；`claude_job_get(output_offset, output_limit)` 切片读；默认 `limit=65536` 字节
