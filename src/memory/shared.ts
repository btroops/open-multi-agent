/**
 * @fileoverview 协作智能体团队的共享内存层
 *
 * 每个智能体都在自己的命名空间下写入数据（格式：<智能体名称>/<键名>），
 * 保证数据条目可追溯归属；同时任意智能体都可以读取所有条目。
 * {@link SharedMemory.getSummary} 方法会生成人类可读的摘要，
 * 适合注入到智能体的上下文窗口中使用。
 */

import type { MemoryEntry, MemoryStore } from '../types.js'
import { InMemoryStore } from './store.js'

// ---------------------------------------------------------------------------
// 运行时类型校验：验证对象是否实现了 MemoryStore 接口
// ---------------------------------------------------------------------------

// 定义 MemoryStore 必须实现的核心方法列表
const STORE_METHODS = ['get', 'set', 'list', 'delete', 'clear'] as const

/**
 * 校验传入值是否结构上实现了 {@link MemoryStore} 接口
 *
 * 用于防御无效的 sharedMemoryStore 传入 SharedMemory（例如：
 * 从 JSON 反序列化的普通对象，无法在运行时满足接口要求）
 */
function isMemoryStore(v: unknown): v is MemoryStore {
  // 排除 null 和非对象类型
  if (v === null || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  // 校验所有必需方法都存在且为函数类型
  return STORE_METHODS.every((method) => typeof obj[method] === 'function')
}

// ---------------------------------------------------------------------------
// 共享内存核心类：为智能体团队提供命名空间隔离的共享存储
// ---------------------------------------------------------------------------

/**
 * 智能体团队的命名空间式共享内存
 *
 * 写入操作会自动添加命名空间 <智能体名称>/<键名>，
 * 确保不同智能体的数据不会冲突，且可追溯来源。
 * 读取操作支持命名空间，也支持直接使用完整键名，让跨智能体读取更简单。
 *
 * @example
 * ```ts
 * const mem = new SharedMemory()
 *
 * await mem.write('researcher', 'findings', 'TypeScript 5.5 支持常量类型参数')
 * await mem.write('coder', 'plan', '使用常量类型参数实现功能 X')
 *
 * const entry = await mem.read('researcher/findings')
 * const all = await mem.listByAgent('researcher')
 * const summary = await mem.getSummary()
 * ```
 */
export class SharedMemory {
  // 底层存储实例，实现 MemoryStore 接口
  private readonly store: MemoryStore

  /**
   * 单调递增的回合计数器，用于判断条目是否过期（expiresAtTurn）
   * 通过 {@link advanceTurn} 手动递增，不绑定具体时间单位
   * 调度器会在 runTeam/runTasks 中每个任务完成后调用一次
   */
  private turnCount = 0

  /**
   * 构造函数：初始化共享内存
   * @param store - 可选的自定义存储实现，默认使用内存存储 InMemoryStore
   *                自定义存储接收的是已命名空间化的键名，无需关心命名规则
   *                不支持 setWithExpiry 的存储会自动降级为普通 set
   *
   * @throws {TypeError} 当传入的 store 未实现 MemoryStore 接口时抛出错误
   */
  constructor(store?: MemoryStore) {
    // 校验传入的存储实例是否合法
    if (store !== undefined && !isMemoryStore(store)) {
      throw new TypeError(
        'SharedMemory: `store` 必须实现 MemoryStore 接口 ' +
        `(必需方法: ${STORE_METHODS.join(', ')}).`,
      )
    }
    // 使用传入的存储或默认内存存储
    this.store = store ?? new InMemoryStore()
  }

  // ---------------------------------------------------------------------------
  // 回合计数器管理：控制带过期时间的数据生命周期
  // ---------------------------------------------------------------------------

  /**
   * 将回合计数器 +1
   * 之前通过 writeExpiring 写入的条目，当计数器达到 写入时计数 + ttlTurns 时会过期
   *
   * 由调度器在 runTeam 和 runTasks 中每个任务完成后调用
   * 单独的 runAgent（单智能体）不会递增计数器
   */
  advanceTurn(): void {
    this.turnCount++
  }

  /** 获取当前回合数，用于测试和监控 */
  getTurnCount(): number {
    return this.turnCount
  }

  // ---------------------------------------------------------------------------
  // 数据写入方法：普通写入 + 带过期时间写入
  // ---------------------------------------------------------------------------

  /**
   * 写入永久有效的数据（命名空间：<智能体名称>/<键名>）
   *
   * 元数据会自动合并 { agent: 智能体名称 }，方便遍历数据时识别来源
   *
   * @param agentName - 写入数据的智能体名称（作为命名空间前缀）
   * @param key       - 智能体命名空间内的逻辑键名
   * @param value     - 要存储的字符串值（对象需提前序列化）
   * @param metadata  - 可选的附加元数据
   */
  async write(
    agentName: string,
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // 生成带命名空间的键名
    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    // 写入存储，自动添加智能体来源元数据
    await this.store.set(namespacedKey, value, {
      ...metadata,
      agent: agentName,
    })
  }

  /**
   * 写入带回合过期时间的数据，功能同 write，但会自动过期
   *
   * 不支持 setWithExpiry 的存储会自动降级为普通 write，数据永久有效
   *
   * @param ttlTurns - 数据有效回合数，必须是 ≥1 的整数
   *
   * @throws {RangeError} ttlTurns 不是整数或小于 1 时抛出错误
   *
   * @remarks
   * 并行执行任务时，回合计数器按【完成的任务】递增，而非【调用的任务】
   * 可能导致过期时间比预期更早，需要严格顺序的场景请使用普通 write + 手动删除
   */
  async writeExpiring(
    agentName: string,
    key: string,
    value: string,
    ttlTurns: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // 校验过期回合数合法性
    if (!Number.isInteger(ttlTurns) || ttlTurns < 1) {
      throw new RangeError(
        `SharedMemory.writeExpiring: ttlTurns 必须是 ≥ 1 的整数 (传入值: ${ttlTurns}). ` +
        '永久有效数据请使用 write() 方法。',
      )
    }

    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    const fullMetadata = { ...metadata, agent: agentName }

    // 如果存储支持过期写入，则使用过期写入
    if (typeof this.store.setWithExpiry === 'function') {
      const expiresAtTurn = this.turnCount + ttlTurns
      await this.store.setWithExpiry(namespacedKey, value, expiresAtTurn, fullMetadata)
    } else {
      // 降级：不支持过期则直接永久写入
      await this.store.set(namespacedKey, value, fullMetadata)
    }
  }

  // ---------------------------------------------------------------------------
  // 数据读取方法
  // ---------------------------------------------------------------------------

  /**
   * 通过完整键名（<智能体名称>/<键名>）读取数据
   *
   * 键不存在 或 数据已过期 → 返回 null
   * 过期数据仅会被过滤，不会从底层存储删除（删除逻辑由存储自身实现，如 Redis TTL）
   * 因此并发读取是安全的，不会覆盖新写入的数据
   */
  async read(key: string): Promise<MemoryEntry | null> {
    const entry = await this.store.get(key)
    // 无数据直接返回 null
    if (entry === null) return null
    // 数据已过期返回 null
    if (this.isExpired(entry)) return null
    // 返回有效数据
    return entry
  }

  // ---------------------------------------------------------------------------
  // 数据列表查询
  // ---------------------------------------------------------------------------

  /** 获取存储中所有未过期的数据条目（无视智能体） */
  async listAll(): Promise<MemoryEntry[]> {
    return this.filterExpired(await this.store.list())
  }

  /**
   * 获取指定智能体写入的所有未过期数据
   * 匹配规则：键名以 <智能体名称>/ 开头
   */
  async listByAgent(agentName: string): Promise<MemoryEntry[]> {
    const prefix = SharedMemory.namespaceKey(agentName, '')
    const allEntries = await this.store.list()
    // 先过滤过期数据
    const liveEntries = this.filterExpired(allEntries)
    // 再过滤指定智能体的数据
    return liveEntries.filter((entry) => entry.key.startsWith(prefix))
  }

  // ---------------------------------------------------------------------------
  // 生成人类可读的共享内存摘要（用于智能体上下文）
  // ---------------------------------------------------------------------------

  /**
   * 生成所有数据的人类可读摘要（Markdown 格式）
   * 按智能体分组，适合注入到智能体的系统提示词中
   * 存储为空时返回空字符串
   *
   * @example
   * ```
   * ## 团队共享内存
   *
   * ### researcher
   * - findings: TypeScript 5.5 支持常量类型参数
   *
   * ### coder
   * - plan: 使用常量类型参数实现功能 X
   * ```
   */
  async getSummary(filter?: { taskIds?: string[] }): Promise<string> {
    // 1. 获取所有数据并过滤过期条目
    let allEntries = await this.store.list()
    allEntries = this.filterExpired(allEntries)

    // 2. 可选：按任务ID过滤数据（用于任务结果筛选）
    if (filter?.taskIds && filter.taskIds.length > 0) {
      const taskIdSet = new Set(filter.taskIds)
      allEntries = allEntries.filter((entry) => {
        const slashIndex = entry.key.indexOf('/')
        const localKey = slashIndex === -1 ? entry.key : entry.key.slice(slashIndex + 1)
        // 只匹配 task:xxx:result 格式的键
        if (!localKey.startsWith('task:') || !localKey.endsWith(':result')) return false
        // 提取任务ID并校验是否在过滤列表中
        const taskId = localKey.slice('task:'.length, localKey.length - ':result'.length)
        return taskIdSet.has(taskId)
      })
    }

    // 无数据直接返回空
    if (allEntries.length === 0) return ''

    // 3. 按智能体名称分组数据
    const entriesByAgent = new Map<string, Array<{ localKey: string; value: string }>>()
    for (const entry of allEntries) {
      const slashIndex = entry.key.indexOf('/')
      // 解析智能体名称和本地键名
      const agent = slashIndex === -1 ? '_unknown' : entry.key.slice(0, slashIndex)
      const localKey = slashIndex === -1 ? entry.key : entry.key.slice(slashIndex + 1)

      // 添加到对应分组
      let group = entriesByAgent.get(agent)
      if (!group) {
        group = []
        entriesByAgent.set(agent, group)
      }
      group.push({ localKey, value: entry.value })
    }

    // 4. 构建 Markdown 格式摘要
    const summaryLines: string[] = ['## 团队共享内存', '']
    for (const [agent, entries] of entriesByAgent) {
      summaryLines.push(`### ${agent}`)
      for (const { localKey, value } of entries) {
        // 长文本截断，避免上下文窗口溢出
        const displayValue = value.length > 200 ? `${value.slice(0, 197)}…` : value
        summaryLines.push(`- ${localKey}: ${displayValue}`)
      }
      summaryLines.push('')
    }

    // 拼接并返回最终摘要
    return summaryLines.join('\n').trimEnd()
  }

  // ---------------------------------------------------------------------------
  // 底层存储访问：暴露存储实例给外部使用
  // ---------------------------------------------------------------------------

  /**
   * 返回底层存储实例，让外部可以直接使用原始的键值接口
   * 避免通过括号语法访问私有属性，保证类型安全
   */
  getStore(): MemoryStore {
    return this.store
  }

  // ---------------------------------------------------------------------------
  // 私有工具方法
  // ---------------------------------------------------------------------------

  /**
   * 静态工具：生成命名空间键名
   * 格式：智能体名称/键名
   */
  private static namespaceKey(agentName: string, key: string): string {
    return `${agentName}/${key}`
  }

  /**
   * 判断数据条目是否已过期
   * 条件：设置了 expiresAtTurn 且当前回合数 ≥ 过期回合数
   */
  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAtTurn !== undefined && this.turnCount >= entry.expiresAtTurn
  }

  /**
   * 过滤数组中所有已过期的数据条目
   * 注意：不会从底层存储删除数据（防止并发写入冲突）
   * 存储的主动清理由自身实现（Redis 过期、Postgres 定时任务等）
   */
  private filterExpired(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter((entry) => !this.isExpired(entry))
  }
}