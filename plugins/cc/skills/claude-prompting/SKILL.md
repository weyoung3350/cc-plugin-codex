---
name: claude-prompting
description: Use when composing the prompt body for any cc-plugin-codex tool call (claude_ask / claude_review / claude_task). Covers prompt structure for second-opinion delegation, the rescue preset for stuck-debugging hand-off, and how to package context Claude can act on. Trigger when you're about to invoke a claude_* tool and need to write what to ask.
---

# 给 Claude 写 prompt 的要点

你是 Codex 模型，正要把一段任务委托给本机的 Claude Code CLI。Claude 不在你的对话上下文里，**它只能看到你 prompt 里写的东西**（以及 `add_dirs` 允许它读的文件）。

## 通用原则

1. **明确目标**：第一句话讲清楚 Claude 应该做什么（"找出导致 X 的根因"、"重命名 Y 到 Z 并修所有引用"、"评审 src/auth/ 的安全风险"）。
2. **画清边界**：Claude 默认在 cwd 范围内操作；如果你想让它读 cwd 外的文件，**`claude_ask` / `claude_task` 接受 `add_dirs: [...]`**（绝对路径数组）让 broker 透传给 Claude。注意：`claude_review` **不接受** `add_dirs` —— 想审 cwd 外的文件就先 cd 过去再调用，或换 `claude_ask` 走只读路径。
3. **附上你已经知道的东西**：你在 Codex 这边读到的文件路径、symbol、错误堆栈、已尝试的方案——直接 inline 进 prompt。Claude 重新发现这些会浪费 token。
4. **指定输出形式**：「只回答 X，不要解释」、「列出 N 个候选方案各 1 句」、「按 markdown 格式返回」——明确点 Claude 才不会写大段叙述。
5. **避免诱导**：不要在 prompt 里替 Claude 下结论（"我觉得是 X 的问题，对吧？"）——会带偏它的独立判断。委托给它就是要拿 fresh 视角。

## claude_ask 模板

```
背景：<1-3 句必要上下文>

你需要回答：<具体问题>

参考文件：
- src/foo.ts（特别是 fooBar 函数）
- src/bar.ts

输出：<期望格式，比如「一句话答案 + 1-2 行依据」>
```

## claude_review 模板

```
请审查以下目标。

审查重点：<例如：N+1 查询 / 输入校验 / 错误处理 / 命名规范>。
忽略：<例如：风格 / 注释 / 已有 TODO>。

每个 finding 必须落在具体文件和行号上；severity 严格按事实判断（critical = 会上线出事，low = 风格瑕疵）；confidence 反映你是否真读过相关代码。
```

`target` 字段传文件路径或 glob，**不要**写到 prompt 里。

## claude_task 模板（编辑任务）

```
任务：<动词开头，一句话>

约束：
- 不要修改 <某些文件 / 某些 API>
- 保持 <某种风格 / 兼容性>

完成判据：
- <具体的、可验证的成功条件>
- <运行什么命令应该绿>
```

`files: [...]` 传焦点文件清单；broker 会自动拼到 prompt 末尾的 `Focus files:` 段。

## Rescue preset：把"卡住的调试"委托给 Claude

当 Codex 这边推进遇到瓶颈（同一个错误反复修不掉、对某段不熟悉的代码不敢动、用户已经说"你卡了"）时，把上下文打包给 Claude 拿 fresh 视角：

```
背景：我（Codex）在尝试 <你在做的任务>，目前卡在 <具体症状>。
已经尝试：
- <尝试 1>，结果 <结果>
- <尝试 2>，结果 <结果>

相关文件：
- <文件 1>:<行号>
- <文件 2>:<行号>

完整错误堆栈 / 关键日志：
```
<原样粘贴，不要省略>
```

请你独立诊断：
1. 最可能的根因是什么？
2. 我之前的尝试为什么没修好？
3. 推荐的下一步具体动作是什么？

注意：请独立判断，不要复用我已经做过的方案；如果你认为根因和我猜的不一样，直接说。
```

调用：

```
claude_ask({
  prompt: <上面的模板>,
  session_id: <可选，如果想让 Claude 多轮帮忙>,
  add_dirs: <如果文件不在 cwd 下>,
  timeout_sec: 600,  # rescue 通常需要更多时间
})
```

## 使用 session_id 续写

适合多轮对话的场景：
- 让 Claude 先**理解一个大模块**，再问具体问题
- 一个长 review 拆成多次按子目录请求
- 先 `claude_ask` 探查，再 `claude_task` 让它改

```
const sess = crypto.randomUUID();
claude_ask({ session_id: sess, prompt: "请先读一遍 src/auth/，告诉我大致结构。" })
// Claude 答完
claude_ask({ session_id: sess, prompt: "现在重点看 LoginService 的 token 续期逻辑，有没有竞态？" })
```

不传 `session_id` 时本次完全无状态——更便宜，但不能续写。

## 不要做的事

- 不要把 prompt 里塞 base64 / 二进制 / 大堆 JSON 数据当上下文（用 `add_dirs` 让 Claude 自己 Read）
- 不要在 prompt 里要求 Claude 调用具体工具（"用 Bash 跑 X"）——让它自己决定；Bash 在我们的 plan 模式下也不可用
- 不要让 prompt 超过 ~2000 tokens——超过这个量级说明该用 `add_dirs` 让 Claude 直接 Read 文件
- 不要复用 session_id 跨**不相关**任务——会浪费 Claude 的 context window，结果质量也降
