# Vitest 测试基础

基于 `tests/agent-hooks.test.ts` 总结的 vitest 核心概念。

## 测试结构

```typescript
import { describe, it, expect, vi } from 'vitest'

describe('分组描述', () => {       // 测试套件，可以嵌套
  it('单个用例描述', async () => {  // 测试用例，支持 async
    // ...
  })
})
```

## Mock 函数: vi.fn()

`vi.fn()` 创建一个"间谍函数"，自动记录调用信息。

```typescript
const spy = vi.fn((x) => x + 1)

spy(1)
spy(2)

expect(spy).toHaveBeenCalledTimes(2)          // 调用次数
expect(spy.mock.calls[0]![0]).toBe(1)         // 第一次调用的第一个参数
expect(spy.mock.calls[1]![0]).toBe(2)         // 第二次调用的第一个参数
```

| 方法 | 用途 |
|------|------|
| `toHaveBeenCalledTimes(n)` | 断言调用 n 次 |
| `toHaveBeenCalledOnce()` | 等价于 `toHaveBeenCalledTimes(1)` |
| `not.toHaveBeenCalled()` | 断言没有被调用 |
| `mock.calls[i]![j]` | 第 i 次调用的第 j 个参数 |

## 自定义 Mock (不依赖 vitest)

不一定要用 `vi.mock()`，可以用**依赖注入**直接替换实现：

```typescript
function mockAdapter(responseText: string) {
  const calls: LLMMessage[][] = []
  const adapter: LLMAdapter = {
    async chat(messages) {
      calls.push([...messages])      // 记录每次调用
      return {
        content: [{ type: 'text', text: responseText }],  // 固定返回
        usage: { input_tokens: 10, output_tokens: 20 },
      }
    },
  }
  return { adapter, calls }          // 返回 calls 供测试断言
}

// 使用
const { adapter, calls } = mockAdapter('hello')
// calls[0] 就是 LLM 收到的消息数组
```

## 常用断言

```typescript
expect(value).toBe(true)                  // 严格相等 (===)
expect(value).toContain('部分匹配')       // 字符串包含
expect(value).toBeDefined()               // 不是 undefined
expect(array).toHaveLength(0)             // 数组长度
expect(array).toEqual(['a', 'b'])         // 数组/对象深度相等
expect(array.some(e => e.type === 'x')).toBe(true)  // 数组条件
```

## 异步测试

全都用 `async/await`：

```typescript
it('async test', async () => {
  const result = await someAsyncFunction()
  expect(result).toBe('ok')
})
```

## 测试中的类型绕过

某些私有字段通过 `as any` 访问：

```typescript
;(agent as any).runner = runner          // 设置私有字段
expect((textBlock as any).text).toBe('') // 绕过类型窄化
```

## 文件里没出现但常用的

```typescript
// 模拟定时器
vi.useFakeTimers()

// 模拟整个模块
vi.mock('../src/llm/adapter')

// 每个测试前重置 spy
beforeEach(() => { vi.clearAllMocks() })

// Mock 返回值
const fn = vi.fn().mockReturnValue(42)

// Mock 异步返回值
const fn = vi.fn().mockResolvedValue({ data: 'ok' })
```
