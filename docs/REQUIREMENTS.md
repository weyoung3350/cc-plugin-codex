# 需求文档

## 背景

- 用户同时使用 **Codex CLI**（OpenAI）和 **Claude Code CLI**（Anthropic）
- OpenAI 已官方发布 `codex-plugin-cc`，让 Claude Code 能调用 Codex（单向）
- 缺反方向能力：**Codex 主动调用 Claude Code** —— 让 Codex 模型能把合适的任务（审查、跨语言检查、复杂重构等）委托给本机 Claude Code 并拿回结果

## 目标

在 Codex CLI 里提供一个插件 `cc-plugin-codex`，满足：

1. Codex 里的模型能通过 MCP 工具**自主发现和调用** Claude Code
2. 支持同步和后台两种调用模式
3. 结果必须**真实返回给 Codex**（不是 fire-and-forget），Codex 模型能消化结果并用于后续推理
4. 支持**多轮会话续写**（同一 session 的上下文记忆）
5. 支持**跨 `codex exec` 会话**（不同进程传同一 session_id 仍能续写）
6. 默认运行为**受控子运行时**：不继承本机 Claude 插件 / MCP / CLAUDE.md / OAuth，防止环境漂移和递归互调
7. 提供**后台作业管理**：提交 / 状态查询 / 结果获取 / 取消

## 非目标（MVP 排除）

- 安全沙箱：方案只提供默认约束，**不承诺**阻止用户显式放权后 Claude 的越界访问
- Shell 工具：MVP 不暴露 Claude 的 Bash 能力，会让边界失去意义
- OAuth / keychain 认证回退：必须前置 `ANTHROPIC_API_KEY` 或 `apiKeyHelper`
- Windows 支持：POSIX-only（依赖 `ps`、`kill`、`setsid`、`rename` 原子性）
- Marketplace 分发：MVP 仅支持本地 `codex mcp add`
- UI / 可视化：纯 CLI 插件

## 用例

### U1：Codex 遇到陌生代码片段，委托 Claude 审查

```
用户在 Codex 里: "帮我看一下 src/auth/session.go 有没有安全问题"
Codex 模型: [内部] 调用 claude_review({target: "src/auth/session.go"})
Claude Code: 返回结构化审查结果（findings[]、severity、建议）
Codex 模型: 消化结果后给用户一个综合结论
```

### U2：Codex 卡在某个错误，委托 Claude 诊断

```
用户: "这段 React 代码为啥 hydration 出错？"
Codex 模型: [经过 skill 指导] 调用 claude_ask({prompt: "...", session_id: uuid1})
Claude Code: 基于 Read/Grep 给出分析
Codex 模型: 追问 claude_ask({prompt: "如果改成 useEffect 呢？", session_id: uuid1})
Claude Code: 基于第一轮上下文回答（原生 --resume 续写）
```

### U3：长任务后台委托

```
用户: "让 Claude 把整个 utils/ 目录的 any 类型都换成具体类型"
Codex 模型: 调用 claude_task({task: ..., allow_writes: true, writes_acknowledged: true, background: true})
→ 拿到 job_id
Codex 继续和用户交互其他事情
用户问进度: Codex 调用 claude_job_get({job_id}) 返回状态和日志分页
```

## 功能需求

| ID | 需求 | 优先级 |
|----|------|--------|
| F-1 | 以 Codex 插件形态（`.codex-plugin/plugin.json` + `.mcp.json`）分发 | P0 |
| F-2 | 提供 `claude_health` 工具探测安装 / 认证 / `--bare` 兼容性 | P0 |
| F-3 | 提供 `claude_ask` 同步工具（只读默认） | P0 |
| F-4 | 提供 `claude_review` 同步工具（`--json-schema` 结构化输出） | P0 |
| F-5 | 提供 `claude_task` 工具（`plan` / `writes` 两级权限，同步 + 后台） | P0 |
| F-6 | 提供 `claude_job_get` 查询后台作业（状态 + 分页日志） | P0 |
| F-7 | 提供 `claude_cancel` 取消后台作业 | P0 |
| F-8 | 同一 `session_id` 严格串行、不同 `session_id` 可并发 | P0 |
| F-9 | 跨 `codex exec` 会话续写（Claude 原生 `--session-id` / `--resume`） | P1 |
| F-10 | 后台作业 broker 挂掉不影响 worker 运行 | P1 |
| F-11 | `allow_writes=true` 首次调用 broker 硬约束 + skill 固定提醒 | P1 |
| F-12 | `ANTHROPIC_API_KEY` 前置；未认证时所有工具拒绝 | P1 |
| F-13 | 提供 3 个 SKILL.md 让 Codex 模型理解工具使用场景 | P1 |
| F-14 | 提供 `fake-claude-fixture` 用于回归测试 | P2 |

## 非功能需求

| ID | 需求 | 说明 |
|----|------|------|
| NF-1 | 零 native 依赖 | 纯 Node ESM，不引 `flock`、`proper-lockfile`、`fs-ext` 等 |
| NF-2 | 取消响应时间 ≤ 12s | 10s SIGTERM 宽限 + 2s 处理 |
| NF-3 | 同步工具默认超时 300s，可配置 | 预算拆 lock-wait / run / grace 三阶段 |
| NF-4 | 并发安全 | Per-job mutex 消除 state.json lost update |
| NF-5 | 平台 | macOS / Linux (POSIX) |
| NF-6 | 文档语言 | 面向用户文档（README / SKILL.md）中文；代码和注释英文 |

## 交付物

1. **本仓库**：源码 + 测试 + 设计文档
2. **本地分发**：`codex mcp add claude-code -- node plugins/cc/scripts/claude-broker.mjs`
3. **后续**：Marketplace 分发、CI、版本发布（不在 MVP）

## 成功判据

21 个功能检查点全部自动化通过（详见 [DESIGN.md](./DESIGN.md#功能检查点)），其中 P0 场景必须 100% 通过，P1 场景允许个别标注 known-issue。
