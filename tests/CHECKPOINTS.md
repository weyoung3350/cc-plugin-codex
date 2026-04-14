# DESIGN.md 21 个 Checkpoint 覆盖矩阵

图例：
- ✅ **自动化**：CI 跑得到，断言失败会让测试红
- 🟡 **结构化**：实现/类型层保证，但行为没有直接断言（OS、计时器、其他子进程参与）
- 🟣 **手动**：仅靠人工真实端到端验证过一次，未进入 CI

| # | Checkpoint | 状态 | 覆盖文件 / 用例 |
|---|---|---|---|
| 1 | health 分别报告 installed/authenticated/api_key_source/platform | ✅ 自动化 | `tests/health.test.mjs` 14 用例；`tests/e2e-fake-claude.test.mjs` "real claude --version" |
| 2 | 同步只读 plan 模式可问不可改（默认 flags=Read,Grep,Glob） | ✅ 自动化 | `tests/permission.test.mjs` "plan mode emits read-only tools"；`tests/broker.test.mjs` "claude_task default mode is plan" |
| 3 | 原生会话续写（同 session_id 两次调用） | ✅ 自动化（lib 层）+ 🟣 手动（真实端到端） | `tests/claude-run.test.mjs` resume fallback；`tests/e2e-fake-claude.test.mjs` --resume miss → fallback；**真实 Claude 续写**（XYZZY-2026 跨 broker 进程）只在开发机手动验证过一次 |
| 4 | 跨 codex-exec 续写 | 🟣 手动 | 与 #3 同一手动验证；CI 中无对应自动化（需真实 Claude） |
| 5 | broker 重启恢复后台 job | ✅ 自动化 | `tests/broker.test.mjs` sweepOrphanedJobs 4 用例；`tests/tracked-jobs.test.mjs` createJob/readJobState |
| 6 | broker 挂后 worker 跑完 | 🟡 结构化 | broker 代码 spawn detached + unref；`tests/broker.test.mjs` "claude_task(background:true) returns job_id and forks a worker" 验证 worker 真起且终态（依赖 fixture）；"broker 真挂"未自动化（要 SIGKILL 测试自己） |
| 7 | claude_review 输出严格符合 schema | ✅ 自动化 | `tests/review-schema.test.mjs` 17 用例；`tests/broker.test.mjs` schema-mismatch 用例；`tests/e2e-fake-claude.test.mjs` review-valid + invalid-verdict（端到端） |
| 8 | 同 session 串行 | ✅ 自动化 | `tests/broker.test.mjs` "same session_id calls run serialised" (maxInflight=1)；`tests/session-lock.test.mjs` 串行阻塞 |
| 9 | 长任务不打穿串行 (heartbeat 不触发回收) | ✅ 自动化 | `tests/session-lock.test.mjs` "ps unknown state does NOT reclaim live lock"；`tests/tracked-jobs.test.mjs` mutex unknown 同样保护 |
| 10 | 持锁进程崩溃秒级释放 | ✅ 自动化 | `tests/session-lock.test.mjs` "stale reclaim: dead owner pid → second acquire wins quickly" |
| 11 | 跨 session 并发 | ✅ 自动化 | `tests/broker.test.mjs` "different session_ids run concurrently" (maxInflight>=2) |
| 12 | claude_task 默认 plan 不写盘 | ✅ 自动化 | `tests/broker.test.mjs` "claude_task default mode is plan (read-only flags)" |
| 13 | allow_writes=true 文件变更落盘 | ✅ 自动化 | `tests/broker.test.mjs` "claude_task allow_writes + writes_acknowledged installs flag and proceeds" |
| 14 | 前台 cancel 不支持 | ✅ 自动化 | `claude_cancel` schema 仅接 `job_id`（broker 实现）；`tests/broker.test.mjs` "claude_cancel on unknown job returns not-found" |
| 15 | cancel ≤12s 进程终止 | 🟡 结构化 | broker 代码 CANCEL_GRACE_MS=10s + setTimeout SIGKILL（含 sameIdentity 二次校验）；fakeRunChild 在 mock 下立即响应 SIGTERM；**真实 12s 边界**由 OS 保证，未直接计时断言 |
| 16 | 长输出分页 | ✅ 自动化 | `tests/broker.test.mjs` "claude_job_get with wait:true blocks until terminal"（base64 path + eof 字段）；切片由 `readSync(fd, buf, 0, len, offset)` 实现 |
| 17 | 孤儿清理（仅非终态） | ✅ 自动化 | `tests/broker.test.mjs` 4 个 sweepOrphanedJobs 用例 |
| 18 | 递归防御对照实验（重写后） | 🟡 结构化 | `tests/permission.test.mjs` 断言 BASE_FLAGS 含 `--strict-mcp-config`；**伪造 MCP 注册让真 Claude 来验证**未自动化（需另起 Claude 子进程） |
| 19 | 原子写：并发不读半截 JSON | ✅ 自动化 | `tests/tracked-jobs.test.mjs` "concurrent finalize + patch: terminal state preserved (no lost update)"（20 并发） |
| 20 | allow_writes 硬约束 + 固定模板存在性 | ✅ 自动化 | `tests/broker.test.mjs` writes-need-acknowledgement（hint regex 验模板）；gates-on-health-before-writing-ack-flag |
| 21 | 平台：macOS/Linux 跑通；Windows warn | ✅ 自动化 | `tests/health.test.mjs` "platform unsupported short-circuits, no spawn" + "platform-unsupported 抛错" |

## 统计

- **自动化（✅）**：16 / 21
- **结构化（🟡）**：3 / 21（#6 broker 真挂、#15 12s 边界、#18 真递归对照）
- **手动（🟣）**：1 / 21（#4 跨 codex-exec 续写）
- **混合**：1 / 21（#3 lib 层自动化 + 真实端到端手动）

## 端到端 fixture 覆盖（tests/e2e-fake-claude.test.mjs）

| 用例 | 覆盖目的 |
|------|---------|
| real spawn → fake claude → success envelope parsed | 验证完整 spawn → child_process → JSON envelope 解析链路（不再依赖 mock spawn） |
| --resume miss → broker fallback to --session-id succeeds | 验证 session 续写协议（与单元测试用 mock 互补） |
| --resume + --session-id 都失败 → propagate nonzero | 错误透传 |
| real claude --version → health.installed=true | health 探测的真实子进程链路 |
| Credit balance is too low → credit-exhausted | 真实 stderr/stdout 解析 → warning 分类 |
| 'please log in' → auth-required | 同上 |

## 测试统计

- **核心库**：219 个单元测试（mock spawn + 完整契约覆盖）
- **e2e fixture**：6 个端到端测试（真实 spawn 路径）
- **总计**：225 个测试

## 待真实回归（需要本机有 Claude + 订阅 / API key）

这些场景纯靠 fixture 无法证明，必须接入真实 Claude：

- 多轮跨进程 session 续写（已通过订阅 OAuth 手动验证一次）
- 大文件 review 的 schema 一致性
- 实际 API quota 耗尽时的 stderr 模式漂移检测
- Claude CLI 升级后 stderr 字符串变更的 regression（`SESSION_NOT_FOUND_PATTERNS` 是否仍命中）

建议作为 release 前手动 smoke 步骤；不进入 CI 默认流程。
