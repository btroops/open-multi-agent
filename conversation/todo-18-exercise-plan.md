# TODO(#18) 练习：让 prompt() 支持 RunOptions

日期: 2026-05-28

状态: ✅ 已完成

## 背景

三个执行方法中，`run()` 和 `stream()` 都支持传 `RunOptions`，只有 `prompt()` 不行：

```typescript
async run(prompt: string, runOptions?: Partial<RunOptions>)       // 有
async *stream(prompt: string, runOptions?: Partial<RunOptions>)   // 有
async prompt(message: string)                                      // 没有
```

## 修改内容

### src/agent/agent.ts

`prompt()` 方法两处改动：

1. 签名加 `runOptions` 参数：

```typescript
// before
async prompt(message: string): Promise<AgentRunResult>

// after
async prompt(message: string, runOptions?: Partial<RunOptions>): Promise<AgentRunResult>
```

2. 将 `runOptions` 传给 `executeRun`：

```typescript
// before
const result = await this.executeRun([...this.messageHistory])

// after
const result = await this.executeRun([...this.messageHistory], runOptions)
```

### tests/agent-hooks.test.ts

新增测试用例 `prompt() with RunOptions hooks`（第 474-498 行）：

- 创建 `onToolCall`、`onToolResult`、`onMessage` spy
- 调用 `agent.prompt('test', { onToolCall, onToolResult, onMessage })`
- 验证回调被正确触发

## 关键问题与收获

**问题：`prompt()` 传 `runOptions` 给 `executeRun` 后，`onMessage` 会被调用几次？**

结论：**1 次**。原因是 `prompt()` 在调用 `executeRun` 前已经手动 push 了 user message：

```typescript
this.messageHistory.push(userMessage)
const result = await this.executeRun([...this.messageHistory], runOptions)
```

`executeRun` 内部的 `internalOnMessage` 只会在**本轮 LLM 调用生成的消息**上触发，不会回头触发已被推送的 user message。所以只有 assistant 的回复会触发 `onMessage`。

## 测试结果

```
Test Files  57 passed (57)
Tests  845 passed (845)
```

新增 1 个测试用例（844 → 845），无回归。

## 验证的设计要点

- `onMessage` 不会重复触发——`internalOnMessage` 只对 `runner.run()` 输出的消息生效
- 手动维护的 `messageHistory` 不受 `onMessage` 影响——两者走不同的路径
- `executeRun` 的参数透传无需特殊处理，`prompt()` 只需把 `runOptions` 原样递过去
