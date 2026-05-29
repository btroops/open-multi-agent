# 团队与通信层

日期: 2026-05-29

基于 `src/team/team.ts`、`src/team/messaging.ts`、`src/memory/shared.ts`、`src/memory/store.ts` 总结。

## 架构关系

三个同层模块：

```
Team
 ├── MessageBus    (messaging.ts) — Agent 之间的即时通信
 ├── SharedMemory  (memory/)      — Agent 之间的持久化数据共享
 └── TaskQueue     (task/queue)   — 任务调度（编排层使用）
      └── EventBus (team.ts 内部) — 队列事件 → 对外通知
```

## Team 类

`team.ts` 是团队的核心协调对象，持有四样东西：

- **agentMap** — 团队成员名录（O(1) 查找）
- **MessageBus** — Agent 间消息总线
- **TaskQueue** — 任务队列（依赖感知的 DAG 调度器）
- **SharedMemory**（可选）— 共享内存

### SharedMemory 解析

```typescript
this.memory = config.sharedMemoryStore !== undefined
  ? new SharedMemory(config.sharedMemoryStore)  // 自定义存储
  : config.sharedMemory
    ? new SharedMemory()                         // 默认 InMemoryStore
    : undefined                                  // 不启用
```

优先级：`sharedMemoryStore` > `sharedMemory: true` > 不启用。

### 事件桥接

`Team` 内部有一个 `EventBus`，把 `TaskQueue` 的事件桥接到外部：

| 队列事件 | 转为 OrchestratorEvent | 外部可订阅 |
|---------|----------------------|-----------|
| `task:ready` | `task_start` | `team.on('task:ready', ...)` |
| `task:complete` | `task_complete` | `team.on('task:complete', ...)` |
| `task:failed` | `error` | `team.on('task:failed', ...)` |
| `all:complete` | 无 data | `team.on('all:complete', ...)` |

### 事件桥接的用意

`Team` 不直接暴露 `TaskQueue` 引用，而是通过 `EventBus` 转发。原因：
1. **封装** — 外部只能订阅事件，不能直接操作队列
2. **转换** — 内部事件格式转成统一的 `OrchestratorEvent`
3. **扩展** — `emit()` 方法可自定义事件（如 `phase:research:complete`）

## MessageBus — 消息总线

`messaging.ts`，232 行。

### 消息结构

```typescript
interface Message {
  id: string          // UUID
  from: string        // 发送者
  to: string          // 接收者，'*' 表示广播
  content: string
  timestamp: Date
}
```

### 两种通信模式

**点对点**（`send`）：
```typescript
bus.send('coordinator', 'researcher', '开始任务 A')
```

**广播**（`broadcast`）：
```typescript
bus.broadcast('coordinator', '全体注意')
// to === '*'，除自己外的所有人都能收到
```

### 已读/未读追踪

```typescript
readState = Map<string, Set<string>>  // agentName → 已读 messageId 集合

getUnread(agentName)  // 所有未读消息
markRead(agentName, ids)  // 标记已读
```

消息永不清除，只通过 `readState` 区分已读/未读。

### 订阅机制

```typescript
const off = bus.subscribe('researcher', (msg) => {
  console.log(`researcher 收到: ${msg.content}`)
})
off()  // 取消订阅
```

订阅回调在消息 persist 后**同步触发**（同一微任务内）。

## SharedMemory — 共享内存

`shared.ts`，334 行。

### 命名空间设计

写入自动加 namespace：`<agentName>/<key>`

```typescript
await mem.write('researcher', 'findings', 'TypeScript 5.5 ships const type params')
// 实际 key: 'researcher/findings'
```

两 Agent 即使写了相同 key 也不会冲突，且可溯源。

### 两种写入方式

| 方法 | 说明 |
|------|------|
| `write(agentName, key, value)` | 永久存储 |
| `writeExpiring(agentName, key, value, ttlTurns)` | 按 turn 数过期 |

### Turn 机制

不是 wall-clock 时间，而是**逻辑时钟**：

```typescript
advanceTurn()  // turnCount++

// 写入时：
expiresAtTurn = this.turnCount + ttlTurns

// 读取时：
isExpired: entry.expiresAtTurn !== undefined && turnCount >= entry.expiresAtTurn
```

orchestrator 每完成一个任务调一次 `advanceTurn()`。因为 Agent 执行时间不确定，wall-clock 过期不可靠。按 turn 过期意味着"等 N 个任务完成后这个数据就失效了"，语义明确。

疑问：`runTasks` / `runTeam` 多个并行任务时，turn 按**每个完成的任务**递增。如果任务 A 写了一个 TTL 条目，任务 B 先完成导致 turn 递增，A 的条目可能比预期提前过期。

### 降级策略

```typescript
if (typeof this.store.setWithExpiry === 'function') {
  // 支持 TTL
} else {
  // custom store 不支持 TTL，降级为普通的 set
}
```

### 运行时形状校验

构造函数中做 `isMemoryStore()` 校验，而不是等到第一次调用时才发现接口不匹配：

```typescript
const STORE_METHODS = ['get', 'set', 'list', 'delete', 'clear'] as const

function isMemoryStore(v: unknown): v is MemoryStore {
  return STORE_METHODS.every((m) => typeof (v as any)[m] === 'function')
}
```

### getSummary()

生成 markdown 摘要，适合注入到 Agent 的 system prompt 或 user turn：

```
## Shared Team Memory

### researcher
- findings: TypeScript 5.5 ships const type params

### coder
- plan: Implement feature X using const type params
```

支持 `filter.taskIds` 只返回指定任务的结果。长 value 截断到 200 字符。

### 过期条目不删除

`filterExpired` 只做读取时过滤，不在底层删除。原因：分布式环境下读写有竞态——读到过期条目的同时，另一个进程可能刚写了一个新值到同一个 key。由后端自己处理（Redis 原生 EXPIRE、Postgres cron）。

## InMemoryStore — 默认存储实现

`store.ts`，148 行。

```typescript
class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>()
}
```

### 设计细节

- `async` 接口（虽然内部是同步的）——为了可替换性，换成 Redis 后端也不需要改调用方
- `createdAt` 保留原则：更新已有 key 时不覆盖 `createdAt`

```typescript
async set(key, value, metadata) {
  const existing = this.data.get(key)
  entry.createdAt = existing?.createdAt ?? new Date()  // 保留首次创建时间
}
```

- `search(query)` 线性扫描，适合小规模数据

## 关键设计决策

### MessageBus vs SharedMemory

| | MessageBus | SharedMemory |
|---|---|---|
| 生命周期 | 进程内，随 team 销毁 | 可对接外部存储 |
| 通信方式 | push（订阅者即时收到） | pull（Agent 需要主动读） |
| 读后是否删除 | 否，但可标记已读 | 永不过期（除非 TTL） |
| 用途 | 临时通知、协调信号 | 任务结果、共享知识 |

### 两个事件系统

1. `EventBus`（team 内部）— 队列事件 → `OrchestratorEvent`，供编排层订阅
2. `MessageBus`（team 对外）— Agent 间的消息传递，供 Agent 订阅

两者不互通。
