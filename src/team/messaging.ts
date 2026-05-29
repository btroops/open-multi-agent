/**
 * @fileoverview 智能体间消息总线。
 *
 * 提供轻量级的发布/订阅系统，使智能体之间可以交换带类型的消息，
 * 而无需直接持有对方的引用。所有消息都会保留在内存中用于回放和审计；
 * 每个接收者的已读状态都会被单独跟踪。
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 消息类型定义
// ---------------------------------------------------------------------------

/** 智能体之间交换的单条消息（也可广播给所有智能体）。 */
export interface Message {
  /** 消息的唯一 UUID 标识。 */
  readonly id: string
  /** 发送方智能体名称。 */
  readonly from: string
  /**
   * 接收方智能体名称，若为广播消息则值为 '*'，
   * 表示发送给除发送者外的所有智能体。
   */
  readonly to: string
  /** 消息内容。 */
  readonly content: string
  /** 消息发送时间。 */
  readonly timestamp: Date
}

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/** 判断一条消息是否是发送给指定智能体的。 */
function isAddressedTo(message: Message, agentName: string): boolean {
  if (message.to === '*') {
    // 广播消息会发送给除发送者以外的所有人
    return message.from !== agentName
  }
  // 点对点消息直接判断接收方是否匹配
  return message.to === agentName
}

// ---------------------------------------------------------------------------
// 消息总线核心类
// ---------------------------------------------------------------------------

/**
 * 用于智能体间通信的内存型消息总线。
 *
 * 智能体可以发送点对点消息或广播消息。
 * 当有新消息发送给订阅者时，订阅者会**同步**收到通知。
 *
 * @example
 * ```ts
 * const bus = new MessageBus()
 *
 * // 订阅消息
 * const unsubscribe = bus.subscribe('worker', (msg) => {
 *   console.log(`worker 收到：${msg.content}`)
 * })
 *
 * // 发送消息
 * bus.send('coordinator', 'worker', '开始任务 A')
 * bus.broadcast('coordinator', '所有智能体待命')
 *
 * // 取消订阅
 * unsubscribe()
 * ```
 */
export class MessageBus {
  /** 保存所有发送过的消息，按插入顺序排列。 */
  private readonly messages: Message[] = []

  /**
   * 跟踪每个智能体的已读消息 ID。
   * 结构：Map<智能体名称, 已读消息ID集合>
   * 不在集合中的消息视为未读。
   */
  private readonly readState = new Map<string, Set<string>>()

  /**
   * 活跃的消息订阅者。
   * 结构：Map<智能体名称, Map<唯一标识, 回调函数>>
   * 用于支持一个智能体多个订阅、安全取消订阅。
   */
  private readonly subscribers = new Map<
    string,
    Map<symbol, (message: Message) => void>
  >()

  // ---------------------------------------------------------------------------
  // 写入操作（发送消息）
  // ---------------------------------------------------------------------------

  /**
   * 发送点对点消息
   * @returns 生成并持久化后的完整消息对象
   */
  send(from: string, to: string, content: string): Message {
    const message: Message = {
      id: randomUUID(),        // 生成唯一ID
      from,                    // 发送方
      to,                      // 接收方
      content,                 // 内容
      timestamp: new Date(),   // 发送时间
    }
    this.persist(message)      // 保存消息并通知订阅者
    return message
  }

  /**
   * 发送广播消息（发送给所有人）
   * @returns 生成的广播消息
   */
  broadcast(from: string, content: string): Message {
    return this.send(from, '*', content)
  }

  // ---------------------------------------------------------------------------
  // 读取操作（获取消息）
  // ---------------------------------------------------------------------------

  /**
   * 获取某个智能体的**未读消息**（包含点对点 + 广播）
   */
  getUnread(agentName: string): Message[] {
    const read = this.readState.get(agentName) ?? new Set<string>()
    return this.messages.filter(
      (m) => isAddressedTo(m, agentName) && !read.has(m.id),
    )
  }

  /**
   * 获取发送给某个智能体的**所有消息**（已读 + 未读）
   */
  getAll(agentName: string): Message[] {
    return this.messages.filter((m) => isAddressedTo(m, agentName))
  }

  /**
   * 将一批消息标记为已读
   * 无效ID会被自动忽略，不会报错
   */
  markRead(agentName: string, messageIds: string[]): void {
    if (messageIds.length === 0) return
    let read = this.readState.get(agentName)
    if (!read) {
      read = new Set<string>()
      this.readState.set(agentName, read)
    }
    for (const id of messageIds) {
      read.add(id)
    }
  }

  /**
   * 获取两个智能体之间的**完整对话记录**，按时间排序
   */
  getConversation(agent1: string, agent2: string): Message[] {
    return this.messages.filter(
      (m) =>
        (m.from === agent1 && m.to === agent2) ||
        (m.from === agent2 && m.to === agent1)
    )
  }

  // ---------------------------------------------------------------------------
  // 订阅管理
  // ---------------------------------------------------------------------------

  /**
   * 订阅发送给指定智能体的新消息
   * @returns 取消订阅的函数
   */
  subscribe(
    agentName: string,
    callback: (message: Message) => void
  ): () => void {
    let agentSubs = this.subscribers.get(agentName)
    if (!agentSubs) {
      agentSubs = new Map()
      this.subscribers.set(agentName, agentSubs)
    }
    const id = Symbol() // 生成唯一订阅ID
    agentSubs.set(id, callback)
    // 返回取消订阅方法
    return () => {
      agentSubs!.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // 私有工具方法
  // ---------------------------------------------------------------------------

  /** 持久化消息 + 通知订阅者 */
  private persist(message: Message): void {
    this.messages.push(message)
    this.notifySubscribers(message)
  }

  /**
   * 根据消息类型通知对应订阅者
   * - 点对点：只通知接收方
   * - 广播：通知除发送方外的所有人
   */
  private notifySubscribers(message: Message): void {
    // 点对点消息
    if (message.to !== '*') {
      this.fireCallbacks(message.to, message)
      return
    }

    // 广播消息
    for (const [agentName, subs] of this.subscribers) {
      if (agentName !== message.from && subs.size > 0) {
        this.fireCallbacks(agentName, message)
      }
    }
  }

  /** 触发某个智能体的所有订阅回调 */
  private fireCallbacks(agentName: string, message: Message): void {
    const subs = this.subscribers.get(agentName)
    if (!subs) return
    for (const callback of subs.values()) {
      callback(message)
    }
  }
}