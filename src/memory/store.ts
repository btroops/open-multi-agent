/**
 * @fileoverview MemoryStore 接口的内存实现（InMemoryStore）
 *
 * 所有数据都存储在原生的 Map 对象中，**不会持久化到磁盘**。
 * 这是 SharedMemory 类默认使用的存储引擎，适用于：
 * 1. 单元测试 / 集成测试
 * 2. 单进程、单机运行的场景
 *
 * 生产环境可以替换为 Redis、SQLite、PostgreSQL 等实现，
 * 只需要实现相同的 MemoryStore 接口即可，上层代码无需修改。
 */

import type { MemoryEntry, MemoryStore } from '../types.js'

// ---------------------------------------------------------------------------
// InMemoryStore 核心类实现
// ---------------------------------------------------------------------------

/**
 * 底层同步执行、对外暴露异步接口的键值存储
 *
 * 设计目的：
 * 虽然本实现是内存同步操作，但对外提供 async/await 异步接口，
 * 这样未来替换成 Redis/DB 等真正的异步后端时，**调用方代码完全不用修改**，
 * 保证了存储层的可替换性、架构灵活性。
 *
 * 数据规范：
 * - 所有键都当作不透明字符串处理（不解析、不修改）
 * - 所有值都必须是字符串；结构化数据必须由调用方提前序列化（如 JSON.stringify）
 *
 * @example
 * ```ts
 * const store = new InMemoryStore()
 * await store.set('config', JSON.stringify({ model: 'claude-opus-4-6' }))
 * const entry = await store.get('config')
 * ```
 */
export class InMemoryStore implements MemoryStore {
  /**
   * 底层真正存储数据的容器
   * 使用 JS 原生 Map：
   * key = 字符串键（如 agent1/key1）
   * value = MemoryEntry 完整数据对象（包含值、元数据、创建时间、过期回合等）
   * private 保证外部无法直接操作，只能通过类方法访问，保证数据安全
   */
  private readonly data = new Map<string, MemoryEntry>()

  // ---------------------------------------------------------------------------
  // 实现 MemoryStore 标准接口（必须实现的 5 个核心方法）
  // ---------------------------------------------------------------------------

  /**
   * 根据键获取一条数据
   * @param key - 要查询的完整键名
   * @returns 存在则返回 MemoryEntry 对象，不存在返回 null
   */
  async get(key: string): Promise<MemoryEntry | null> {
    // 从 Map 中获取，不存在则返回 null
    return this.data.get(key) ?? null
  }

  /**
   * 设置/更新一条数据（无过期时间）
   * 行为：键不存在则新增，存在则覆盖 value/metadata，但保留原始 createdAt
   *
   * @param key - 键名
   * @param value - 要存储的字符串值
   * @param metadata - 可选元数据（对象）
   */
  async set(
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // 先查询是否已存在该键，用于保留创建时间
    const existing = this.data.get(key)

    // 构建要存入的 MemoryEntry 对象
    const entry: MemoryEntry = {
      key,                  // 键名
      value,                // 数据值
      // 有元数据则复制一份新对象，没有则设为 undefined（节省空间）
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      // 关键设计：已存在则保留创建时间，不存在则新建时间
      createdAt: existing?.createdAt ?? new Date(),
    }

    // 写入 Map 覆盖/新增
    this.data.set(key, entry)
  }

  /**
   * 设置/更新一条**带回合过期**的数据
   * 与 set 方法逻辑几乎一致，只是多了 expiresAtTurn 过期回合字段
   *
   * @param key - 键名
   * @param value - 数据值
   * @param expiresAtTurn - 过期回合数（到该回合自动失效）
   * @param metadata - 可选元数据
   */
  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // 查询是否已存在，保留创建时间
    const existing = this.data.get(key)

    // 构建带过期回合的条目
    const entry: MemoryEntry = {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn, // 唯一区别：记录过期回合
    }

    this.data.set(key, entry)
  }

  /**
   * 获取存储中**所有**数据条目
   * @returns 按插入顺序排列的条目数组（Map 特性）
   * 注意：返回的是快照，瞬间状态，不自动过滤过期数据
   * 过期过滤由上层 SharedMemory 负责
   */
  async list(): Promise<MemoryEntry[]> {
    // Map.values() 转成数组返回
    return Array.from(this.data.values())
  }

  /**
   * 删除指定键的数据
   * @param key - 要删除的键
   * 行为：键不存在也不会报错，静默忽略
   */
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  /**
   * 清空整个存储（删除所有数据）
   * 常用于测试重置、会话清空等场景
   */
  async clear(): Promise<void> {
    this.data.clear()
  }

  // ---------------------------------------------------------------------------
  // 扩展方法：不属于标准 MemoryStore 接口，是内存存储的增强功能
  // ---------------------------------------------------------------------------

  /**
   * 简单搜索功能：根据关键词模糊查询
   * 匹配规则（不区分大小写）：
   * 1. 键名包含关键词
   * 2. 数据值包含关键词
   * 满足任一即返回
   *
   * 性能：线性全量扫描，适合小数据量
   * 大数据量需要加索引或使用专业数据库
   *
   * @param query - 搜索关键词
   * @returns 匹配的条目数组
   *
   * @example
   * ```ts
   * // 查找所有包含 "research" 的数据
   * const hits = await store.search('research')
   * ```
   */
  async search(query: string): Promise<MemoryEntry[]> {
    // 空查询 = 返回全部数据
    if (query.length === 0) {
      return this.list()
    }

    // 统一转小写，实现不区分大小写匹配
    const lowerQuery = query.toLowerCase()

    // 过滤出键或值包含关键词的条目
    return Array.from(this.data.values()).filter(
      (entry) =>
        entry.key.toLowerCase().includes(lowerQuery) ||
        entry.value.toLowerCase().includes(lowerQuery),
    )
  }

  // ---------------------------------------------------------------------------
  // 便捷工具方法：不属于 MemoryStore 接口，方便使用
  // ---------------------------------------------------------------------------

  /**
   * 获取当前存储的条目数量
   * getter 属性，使用方式：store.size
   */
  get size(): number {
    return this.data.size
  }

  /**
   * 判断某个键是否存在（不读取值，效率更高）
   * @param key - 要检查的键
   * @returns 存在返回 true，不存在 false
   */
  has(key: string): boolean {
    return this.data.has(key)
  }
}