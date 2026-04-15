# CHANGELOG

## 0.0.1 — 初版

### 新增

- **6 个 MCP 工具**：
  - `claude_health` — 探测 Claude 安装/认证/平台兼容性
  - `claude_ask` — 同步只读提问
  - `claude_review` — 结构化审查（固定 JSON schema）
  - `claude_task` — 编辑任务，支持 plan/writes 两级权限 + 同步/后台模式
  - `claude_job_get` — 后台作业状态查询 + 分页日志（base64）
  - `claude_cancel` — 后台作业取消（SIGTERM → 10s grace → SIGKILL）
- **会话续写**：依赖 Claude 原生 `--session-id` / `--resume`；同 `session_id` broker 严格串行（mkdir 用户态锁）
- **后台作业**：detached worker，broker 挂掉不影响；per-job mutex 消除 lost update；终态因果矩阵约束
- **认证支持**：Claude 订阅 OAuth keychain（推荐）、`ANTHROPIC_API_KEY`、`apiKeyHelper` 自动适配
- **递归防御**：`--strict-mcp-config` 阻止 Claude 子进程发现并调用本插件 MCP
- **3 个 SKILL.md**：claude-delegation-runtime / claude-result-handling / claude-prompting，引导 Codex 模型正确调用

### 已知限制

- 仅支持 macOS / Linux（POSIX）
- `claude_review` 不支持 `add_dirs` / `model`（设计约束）
- 后台作业不消费 `timeout_sec`（worker 无内置超时）
- `--bare` 已主动移除以支持订阅 OAuth；CLAUDE.md / hooks / auto-memory 会被 Claude 子进程加载

### 测试

- 232 个测试全绿
- 真实端到端冒烟通过（订阅 OAuth + Credit-exhausted 诊断 + 跨 broker 进程 session 续写）
