# Agent 核心架构讨论

日期: 2026-05-27

## 阅读文件

- `examples/basics/single-agent.ts` — 展示了三种使用模式
- `src/agent/agent.ts` — Agent 类的核心实现

## 核心观点

`agent.ts` 是整个 open-multi-agent 框架的核心抽象，`single-agent.ts` 只是其使用方式的演示。

## Agent 类关键设计

### 1. Runner 懒初始化

`getRunner()` 在第一次 `run`/`prompt`/`stream` 调用时才创建 adapter。这意味着：

- `new Agent(...)` 不会触发任何网络请求
- provider SDK 通过动态 `import()` 按需加载，未使用的 SDK 不会被加载

```typescript
private async getRunner(): Promise<AgentRunner> {
    if (this.runner !== null) return this.runner
    // adapter 是异步创建的（可能涉及动态 import）
    const adapter = await createAdapter(provider, ...)
    this.runner = new AgentRunner(adapter, ...)
    return this.runner
}
```

### 2. 三种执行语义

| 方法 | 会话历史 | 适用场景 |
|------|---------|---------|
| `run()` | 每次都新建，不保留历史 | 一次性查询 |
| `prompt()` | 追加到 `messageHistory`，多轮累积 | 多轮对话 |
| `stream()` | 同 `run()`，但 yield `StreamEvent` | 流式输出 |

### 3. Hook 系统

- `beforeRun` — 在运行前拦截并修改 prompt，用于注入上下文
- `afterRun` — 在运行后处理结果
- orchestrator 层利用 hook 注入团队上下文（如 `revealCoordinator`）

### 4. Structured Output 重试逻辑

当配置了 `outputSchema`：

1. 第一遍运行后尝试 JSON 解析和 Zod 校验
2. 失败时将 `原始 messages + assistant 回复 + 错误信息` 拼接后重试一次
3. 如果重试仍失败，`structured` 字段为 `undefined`，但 `success` 仍为 `true`

### 5. AbortSignal 合并

`timeoutMs` 和外部传入的 `abortSignal` 通过 `mergeAbortSignals()` 组合，任一触发都会取消执行。

### 架构分层

Agent 本身不处理团队协作——它提供干净的接口供 orchestrator 编排：

```
OpenMultiAgent  (高层 API)
  └─ runAgent()  → Agent.run()          单 Agent
  └─ runTeam()   → Agent + 编排逻辑     多 Agent 自动编排
  └─ runTasks()  → Agent + 任务 DAG     显式任务管线
```

Agent 内部：

```
Agent
  └─ AgentRunner      对话循环（send → tool-use → append → loop）
      └─ LLMAdapter   LLM 接口抽象（各 provider 实现）
```

## executeRun 与 beforeRun Hook

### run() 方法

`run()` 非常薄，只做两件事：

```typescript
async run(prompt: string, runOptions?: Partial<RunOptions>): Promise<AgentRunResult> {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]
    return this.executeRun(messages, runOptions)
}
```

1. 把 prompt 包成 `LLMMessage` 数组
2. 调 `executeRun`

核心全在 `executeRun`。

### executeRun 流程拆解

1. **`beforeRun` hook** — 执行前拦截，可修改 prompt
2. **`runner.run()`** — 实际的 LLM 对话循环
3. **预算检查** — `budgetExceeded` 则提前返回
4. **Structured output 校验** — 配了 `outputSchema` 时做 JSON 解析 + Zod 校验 + 一次重试
5. **`afterRun` hook** — 结果后处理
6. **错误兜底** — 异常被 catch 转成 `AgentRunResult` 返回（不向外抛）

### beforeRun Hook 实现

涉及三个方法协作：

**触发逻辑** (agent.ts:324-328):

```typescript
if (this.config.beforeRun) {
    const hookCtx = this.buildBeforeRunHookContext(messages)
    const modified = await this.config.beforeRun(hookCtx)
    this.applyHookContext(messages, modified, hookCtx.prompt)
}
```

**`buildBeforeRunHookContext`** — 从消息列表中找到最后一条 `role: 'user'` 的消息，提取 text 内容作为 `prompt`；同时把 config（去掉 hook 函数自身避免循环引用）作为 `agent` 信息传递：

```typescript
private buildBeforeRunHookContext(messages: LLMMessage[]): BeforeRunHookContext {
    let prompt = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        prompt = messages[i]!.content
          .filter((b): b is TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
        break
      }
    }
    const { beforeRun, afterRun, ...agentInfo } = this.config
    return { prompt, agent: agentInfo as AgentConfig }
}
```

**`applyHookContext`** — 如果 `beforeRun` 修改了 `ctx.prompt`，用它替换最后一条 user message 的 text blocks（保留 image 等非 text block）：

```typescript
private applyHookContext(messages: LLMMessage[], ctx: BeforeRunHookContext, originalPrompt: string): void {
    if (ctx.prompt === originalPrompt) return
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        const nonTextBlocks = messages[i]!.content.filter(b => b.type !== 'text')
        messages[i] = {
          role: 'user',
          content: [{ type: 'text', text: ctx.prompt }, ...nonTextBlocks],
        }
        break
      }
    }
}
```

### 设计要点

关键设计：`applyHookContext` **不是原地修改**消息对象的 content 数组，而是**替换整个数组元素** (`messages[i] = ...`)。原因在于 `prompt()` 传进来的是 `[...this.messageHistory]` 的浅拷贝——只有替换元素才能不污染原始 history。

典型用途：orchestrator 的 `revealCoordinator`，在工作开始前把团队上下文注入到 agent 的 prompt 里。

## 设计模式与编程实践

agent.ts（670 行）中体现的 17 个设计模式和编程实践：

### 一、创建型模式

#### 1. 延迟初始化 (Lazy Initialization)

```typescript
private async getRunner(): Promise<AgentRunner> {
    if (this.runner !== null) return this.runner
    const adapter = await createAdapter(provider, ...)
    this.runner = new AgentRunner(adapter, ...)
    return this.runner
}
```

`AgentRunner` 和 `LLMAdapter` 直到第一次 `run`/`prompt`/`stream` 才创建。`new Agent()` 不触发网络请求，不加载 provider SDK。

#### 2. 工厂方法 (Factory Method)

```typescript
this.config.adapter ?? (await createAdapter(provider, this.config.apiKey, ...))
```

`createAdapter()` 根据 provider 字符串动态 `import()` 对应模块。调用者不需要知道具体返回的是 `AnthropicAdapter` 还是 `OpenAIAdapter`。

### 二、结构型模式

#### 3. 依赖注入 (Dependency Injection)

```typescript
constructor(
    config: AgentConfig,
    toolRegistry: ToolRegistry,    // 注入
    toolExecutor: ToolExecutor,    // 注入
)
```

`Agent` 不自己创建 `ToolRegistry` 和 `ToolExecutor`，由外部注入。动机：多 Agent 共享同一个注册表。

#### 4. 适配器模式 (Adapter)

两层适配：
- **LLMAdapter** — 统一 `chat()` / `stream()` 接口，屏蔽各 provider 的 API 差异
- **buildBeforeRunHookContext** — 把内部 `LLMMessage[]` 格式翻译成 hook 需要的 `{ prompt, agent }` 简单接口

#### 5. 装饰器模式 (Decorator)

`Agent` 在 `AgentRunner` 之上叠加多层行为而不修改它：
- 状态管理（`transitionTo`）
- 持久化历史（`messageHistory`）
- Hook 系统（`beforeRun`/`afterRun`）
- Structured output 校验 + 重试
- Trace 埋点

### 三、行为型模式

#### 6. 策略模式 (Strategy)

```typescript
contextStrategy?: { type: 'sliding-window' | 'compact' | 'summarize', ... }
loopDetection?: LoopDetectionConfig
```

上下文压缩策略和循环检测策略通过配置注入，运行时切换不同实现。

#### 7. 模板方法模式 (Template Method)

`executeRun` 定义固定执行骨架，子步骤通过回调/配置定制：

```
beforeRun hook → runner.run → budget check → structured output → afterRun → emitTrace → return
```

`executeStream` 使用相同骨架，只把 `runner.run` 换成 `runner.stream`。

#### 8. Hook / 回调模式

```typescript
beforeRun?: (ctx: BeforeRunHookContext) => Promise<BeforeRunHookContext>
afterRun?: (result: AgentRunResult) => Promise<AgentRunResult>
onMessage?: (msg: LLMMessage) => void  // 通过 RunOptions 传入
```

不修改 `Agent` 类、不继承，就能在关键节点插入自定义逻辑。

### 四、架构设计原则

#### 9. 单一职责

清晰的职责分离：
- **`Agent`** — 历史管理、状态、hook、structured output
- **`AgentRunner`** — LLM 对话循环
- **`LLMAdapter`** — provider 通信协议
- **`ToolRegistry` / `ToolExecutor`** — 工具注册与执行

#### 10. 接口隔离 (Interface Segregation)

三层各有独立接口，互不污染：
- `AgentConfig` — 用户配置入口
- `RunnerOptions` — Runner 配置（从 AgentConfig 映射）
- `RunOptions` — 每次调用的运行时选项（abortSignal, onMessage）

#### 11. 组合优于继承

`Agent` **组合** `AgentRunner` 而不是继承它，不暴露 Runner 的内部方法。

#### 12. 错误边界 (Error Boundary)

> Never throw — always return a result.

```typescript
} catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    this.transitionToError(error)
    return { success: false, output: error.message, ... }  // 永远返回结果
}
```

无论什么异常都被转成 `AgentRunResult` 返回，调用者不需要 try/catch。

#### 13. 防御性拷贝 (Defensive Copy)

```typescript
getState(): AgentState {
    return { ...this.state, messages: [...this.state.messages] }
}
getHistory(): LLMMessage[] {
    return [...this.messageHistory]
}
```

外部拿到副本，修改不会污染内部状态。

### 五、可观测性

#### 14. Trace 埋点

```typescript
private emitAgentTrace(options, startMs, result): void {
    if (!options?.onTrace) return  // 没人监听就零开销
    emitTrace(options.onTrace, {
        type: 'agent', runId, taskId, agent,
        turns, tokens, toolCalls,
        startMs, endMs, durationMs,
    })
}
```

条件触发、无侵入。不传 `onTrace` 就完全跳过。`runId` 未提供时自动生成。

### 六、编码细节

#### 15. 空对象模式 (Null Object)

```typescript
const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
```

避免到处写 `{ input_tokens: 0, output_tokens: 0 }`，且作为共享常量不会被修改，安全。

#### 16. 资源合并模式

```typescript
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal
```

`timeoutMs` 和调用者的 `abortSignal` 各自独立，任一触发都取消。调用者不需要额外工作。

#### 17. 分层结果映射

```typescript
private toAgentRunResult(result: RunResult, success, structured?): AgentRunResult {
    return {
        success, output, messages, tokenUsage, toolCalls, structured,
        ...(result.loopDetected ? { loopDetected: true } : {}),
        ...(result.budgetExceeded ? { budgetExceeded: true } : {}),
    }
}
```

条件展开——只有出现的字段才加入结果，客户端不需要检查 undefined。

### 总结

| 问题 | 方案 |
|------|------|
| provider SDK 按需加载 | 延迟初始化 + 工厂 |
| 多 Agent 共享工具注册表 | 依赖注入 |
| 扩展执行流程（不修改类） | Hook 回调 |
| 不同 provider 统一调用 | 适配器 |
| 编排与执行分离 | 单一职责 + 组合 |
| LLM 调用永远不抛异常 | 错误边界 |
| 每次调用独立取消 | 资源合并 |
| 配置与运行参数分离 | 接口隔离 |

## runner.ts — AgentRunner 对话循环引擎

文件 1301 行，是框架的核心引擎，`agent.ts` 中的 `Agent` 通过组合委托给它。

### 三层接口

- **`RunnerOptions`** — 静态配置（model, maxTurns, contextStrategy 等）
- **`RunOptions`** — 每次调用的回调（onToolCall, onMessage, onTrace, team 等）
- **`RunResult`** — 最终输出（messages, output, toolCalls, tokenUsage）

### 模块级 Helper 函数

纯函数、无状态、位于文件顶部：

| 函数 | 作用 |
|------|------|
| `extractText` | 从 ContentBlock[] 提取 text 并拼接 |
| `extractToolUseBlocks` | 提取所有 tool_use 块 |
| `groupIntoTurns` | 按"原子 turn"分组，保证 tool_use/tool_result 不被拆散 |
| `stripImageBlocksForSummary` | summary 前剥离 image base64 payload，防止膨胀 |
| `prependSyntheticPrefixToFirstUser` | 在第一条 user message 前插入框架文本 |
| `addTokenUsage` | TokenUsage 累加 |

### AgentRunner 类

#### 核心流：stream() 主循环

`run()` 是 `stream()` 的包装——消费所有事件聚合成 `RunResult`，两者共享同一循环逻辑。

主循环（while true）：

```
while (true) {
  1. 压缩已消费的 tool_result（compressConsumedToolResults）
  2. 应用上下文策略（applyContextStrategy: sliding-window/summarize/compact）
  3. adapter.chat() — 调用 LLM
  4. 构建 assistant message，yield text
  5. 检查 token budget（超过 → 标记 pendingBudgetExceeded）
  6. 提取 tool_use blocks
  7. 循环检测（LoopDetector: warn/inject/terminate/continue）
  8. 没 tool_use → break（最终输出）
  9. yield tool_use 事件
  10. 并行执行所有 tool calls（Promise.all）
  11. 归集 delegation token usage
  12. 构建 tool_result user message（注入循环警告）
  13. budget 二次检查（含 delegation 后的 budget）
  14. loop back
}
```

#### 工具三层过滤（resolveTools）

```
preset (readonly/readwrite/full)
  → allowedTools (allowlist)
    → disallowedTools (denylist)
      → AGENT_FRAMEWORK_DISALLOWED (安全底线)
```

避让检测：preset + allowedTools 同时设置时告警；allowedTools + disallowedTools 重叠时告警。

Runtime-added 自定义工具跳过 preset 和 allowlist 但仍受 denylist 约束。

#### 三种上下文策略

由 `applyContextStrategy` 分发：

| 策略 | 行为 | 成本 |
|------|------|------|
| `sliding-window` | 保留后 N turn，丢弃旧的。基于 `groupIntoTurns` 保证不拆散 tool_use/tool_result 对 | 零（纯数组操作） |
| `compact` | 规则压缩：保留 tool_use（决策），截断长 text，压缩长 tool_result，保留 error，保留 delegation 结果 | 零（纯字符串操作） |
| `summarize` | 调 LLM 总结旧 turns，替换为 digest。剥离 image 防膨胀。自带 `summarizeCache` 防重复 | LLM 调用 |
| `custom` | 通过 `contextStrategy.compress` 自定义 | 取决于实现 |

#### 循环检测（LoopDetector）

- 检测 tool_use 重复（相同工具+相同参数）和 text 重复
- 四种行为：`warn`（注入警告消息）、`inject`（类似 warn）、`terminate`（直接停止）、`continue`（忽略）
- 二次触发强制 terminate

#### 关键设计决策

1. **budget 检查分两阶段**：第一次在 assistant 消息后立即检查并标记 `pendingBudgetExceeded`，但等到 tool_result 消息追加完才 break。保证 `tool_use` 和 `tool_result` 始终配对，返回的 messages 可被 API 重放。

2. **delegation token 归集**：tool result 携带的 `metadata.tokenUsage`（来自 `delegate_to_agent`）计入 totalUsage，确保子任务 token 消耗不被漏算。

3. **`compact` 策略留白原则**：error 和 delegation 的 tool_result 永不压缩，因为前者有诊断价值，后者父 agent 可能需要在后续 turn 重新读取。

## 后续可深入的方向

- `orchestrator.ts` — runTeam 如何用 Agent 做编排
- `structured-output.ts` — JSON 解析和校验的具体实现
- `loop-detector.ts` — 滑动窗口哈希检测实现
