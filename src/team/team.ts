/**
 * @fileoverview Team — the central coordination object for a named group of agents.
 *
 * A {@link Team} owns the agent roster, the inter-agent {@link MessageBus},
 * the {@link TaskQueue}, and (optionally) a {@link SharedMemory} instance.
 * It also exposes a typed event bus so orchestrators can react to lifecycle
 * events without polling.
 */

import type {
  AgentConfig,
  MemoryStore,
  OrchestratorEvent,
  Task,
  TaskStatus,
  TeamConfig,
} from '../types.js'
import { SharedMemory } from '../memory/shared.js'
import { MessageBus } from './messaging.js'
import type { Message } from './messaging.js'
import { TaskQueue } from '../task/queue.js'
import { createTask } from '../task/task.js'

export type { Message }

// ---------------------------------------------------------------------------
// Internal event bus
// ---------------------------------------------------------------------------

/**
 * @fileoverview 极简同步事件发射器
 * 轻量级事件总线实现，支持事件订阅、触发和取消订阅，是组件间通信的核心工具
 */
type EventHandler = (data: unknown) => void;

class EventBus {
  /**
   * 事件监听器存储容器
   * 结构：Map<事件名称, Map<唯一标识, 事件处理函数>>
   * 外层key：事件名（字符串）
   * 内层key：Symbol生成的唯一ID（用于精准取消订阅）
   * 内层value：事件回调函数
   */
  private readonly listeners = new Map<string, Map<symbol, EventHandler>>();

  /**
   * 订阅事件
   * @param event 要订阅的事件名称
   * @param handler 事件触发时执行的回调函数
   * @returns 取消订阅的函数，调用后可移除当前事件监听
   */
  on(event: string, handler: EventHandler): () => void {
    // 获取当前事件对应的监听器Map
    let map = this.listeners.get(event);
    
    // 如果该事件从未被订阅过，创建新的Map并存入容器
    if (!map) {
      map = new Map();
      this.listeners.set(event, map);
    }

    // 生成唯一Symbol ID，用于标识当前监听器（避免重复、方便精准删除）
    const id = Symbol();
    // 将监听器存入对应事件的Map中
    map.set(id, handler);

    // 返回取消订阅的闭包函数
    return () => {
      map!.delete(id);
    };
  }

  /**
   * 触发事件（同步执行所有订阅的回调）
   * @param event 要触发的事件名称
   * @param data 传递给事件回调函数的数据
   */
  emit(event: string, data: unknown): void {
    // 获取当前事件的所有监听器
    const map = this.listeners.get(event);
    
    // 无监听器则直接返回，不执行任何操作
    if (!map) return;

    // 遍历执行该事件的所有监听器函数，并传入数据
    for (const handler of map.values()) {
      handler(data);
    }
  }
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/**
 * 协调一组具名的智能体（Agent），提供共享消息、任务队列、可选的共享内存
 * 这是整个多智能体系统的核心调度类
 *
 * @example
 * ```ts
 * const team = new Team({
 *   name: 'research-team',
 *   agents: [researcherConfig, writerConfig],
 *   sharedMemory: true,
 *   maxConcurrency: 2,
 * })
 *
 * team.on('task:complete', (data) => {
 *   const event = data as OrchestratorEvent
 *   console.log(`Task done: ${event.task}`)
 * })
 *
 * const task = team.addTask({
 *   title: 'Research topic',
 *   description: 'Gather background on quantum computing',
 *   status: 'pending',
 *   assignee: 'researcher',
 * })
 * ```
 */
export class Team {
  // 团队名称（只读）
  readonly name: string
  // 团队完整配置（只读）
  readonly config: TeamConfig

  // 智能代理映射表：key=代理名称，value=代理配置，用于快速查找
  private readonly agentMap: ReadonlyMap<string, AgentConfig>
  // 消息总线：负责代理之间收发消息
  private readonly bus: MessageBus
  // 任务队列：负责管理、调度所有任务
  private readonly queue: TaskQueue
  // 共享内存：可选，用于代理之间共享数据
  private readonly memory: SharedMemory | undefined
  // 事件总线：用于对外发送团队生命周期事件（任务完成、消息发送等）
  private readonly events: EventBus

  // 构造函数：初始化团队所有核心组件
  constructor(config: TeamConfig) {
    this.config = config
    this.name = config.name

    // 将代理列表转为 Map，按名称索引，实现 O(1) 快速查找
    this.agentMap = new Map(config.agents.map((a) => [a.name, a]))
    // 初始化消息总线
    this.bus = new MessageBus()
    // 初始化任务队列
    this.queue = new TaskQueue()

    /**
     * 初始化共享内存（逻辑说明）
     * 1. 如果传入了 sharedMemoryStore，优先使用自定义存储
     * 2. 如果 sharedMemory=true 且没有自定义存储 → 使用默认内存存储
     * 3. 否则 → 不启用共享内存
     * 使用 !== undefined 是为了让错误配置（null/0/''）能快速报错，不静默忽略
     */
    this.memory = config.sharedMemoryStore !== undefined
      ? new SharedMemory(config.sharedMemoryStore)
      : config.sharedMemory
        ? new SharedMemory()
        : undefined

    // 初始化团队事件总线（就是我们刚才看的 EventBus）
    this.events = new EventBus()

    // ------------------------------
    // 队列事件桥接：把任务队列的事件转发到团队事件总线
    // 外部只需要监听 team.on() 就能收到所有事件
    // ------------------------------

    // 任务准备就绪 → 转发为 team 的 task:ready 事件
    this.queue.on('task:ready', (task) => {
      const event: OrchestratorEvent = {
        type: 'task_start',
        task: task.id,
        data: task,
      }
      this.events.emit('task:ready', event)
    })

    // 任务完成 → 转发为 team 的 task:complete 事件
    this.queue.on('task:complete', (task) => {
      const event: OrchestratorEvent = {
        type: 'task_complete',
        task: task.id,
        data: task,
      }
      this.events.emit('task:complete', event)
    })

    // 任务失败 → 转发为 team 的 task:failed 事件
    this.queue.on('task:failed', (task) => {
      const event: OrchestratorEvent = {
        type: 'error',
        task: task.id,
        data: task,
      }
      this.events.emit('task:failed', event)
    })

    // 所有任务全部完成 → 转发 all:complete 事件
    this.queue.on('all:complete', () => {
      this.events.emit('all:complete', undefined)
    })
  }

  // ---------------------------------------------------------------------------
  // 代理管理（Agent Roster）
  // ---------------------------------------------------------------------------

  /** 获取所有代理配置（返回浅拷贝，按注册顺序） */
  getAgents(): AgentConfig[] {
    return Array.from(this.agentMap.values())
  }

  /**
   * 根据名称查找代理
   * @returns 找到返回代理配置，找不到返回 undefined
   */
  getAgent(name: string): AgentConfig | undefined {
    return this.agentMap.get(name)
  }

  // ---------------------------------------------------------------------------
  // 消息通信（Messaging）
  // ---------------------------------------------------------------------------

  /**
   * 发送点对点消息：从某个代理发给另一个代理
   * 消息会持久化在总线中，并同步通知订阅者
   */
  sendMessage(from: string, to: string, content: string): void {
    const message = this.bus.send(from, to, content)
    // 发送后触发 message 事件
    const event: OrchestratorEvent = {
      type: 'message',
      agent: from,
      data: message,
    }
    this.events.emit('message', event)
  }

  /**
   * 获取某个代理的所有消息（已读/未读都包含）
   * 按时间顺序返回
   */
  getMessages(agentName: string): Message[] {
    return this.bus.getAll(agentName)
  }

  /**
   * 广播消息：从一个代理发给团队内所有其他代理
   * 消息接收方会标记为 *
   */
  broadcast(from: string, content: string): void {
    const message = this.bus.broadcast(from, content)
    // 广播后触发 broadcast 事件
    const event: OrchestratorEvent = {
        type: 'message',
        agent: from,
        data: message,
    }
    this.events.emit('broadcast', event)
  }

  // ---------------------------------------------------------------------------
  // 任务管理（Task Management）
  // ---------------------------------------------------------------------------

  /**
   * 添加新任务到队列
   * 自动生成 id、创建时间、更新时间
   * @returns 保存后的完整任务对象
   */
  addTask(
    task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>,
  ): Task {
    // 创建基础任务（自动生成系统字段）
    const created = createTask({
      title: task.title,
      description: task.description,
      assignee: task.assignee,
      dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
    })

    // 如果用户指定了非默认状态（如 blocked），保留用户状态
    const finalTask: Task =
      task.status !== 'pending'
        ? { ...created, status: task.status as TaskStatus, result: task.result }
        : created

    // 加入任务队列
    this.queue.add(finalTask)
    return finalTask
  }

  /** 获取队列中所有任务的快照（任何状态都返回） */
  getTasks(): Task[] {
    return this.queue.list()
  }

  /** 获取分配给某个代理的所有任务 */
  getTasksByAssignee(agentName: string): Task[] {
    return this.queue.list().filter((t) => t.assignee === agentName)
  }

  /**
   * 更新任务（支持部分字段更新）
   * @throws 找不到任务时抛出错误
   */
  updateTask(taskId: string, update: Partial<Task>): Task {
    // 只提取队列允许修改的字段
    const { status, result, assignee } = update
    return this.queue.update(taskId, {
      ...(status !== undefined && { status }),
      ...(result !== undefined && { result }),
      ...(assignee !== undefined && { assignee }),
    })
  }

  /**
   * 获取分配给某个代理的下一个可执行任务（会处理依赖关系）
   * 优先找明确分配给该代理的任务
   * 找不到 → 找任意未分配的待执行任务
   * @returns 没有则返回 undefined
   */
  getNextTask(agentName: string): Task | undefined {
    // 优先：明确分配给当前代理的任务
    const assigned = this.queue.next(agentName)
    if (assigned) return assigned

    // 兜底：任何未分配的待执行任务
    return this.queue.nextAvailable()
  }

  // ---------------------------------------------------------------------------
  // 共享内存（Memory）
  // ---------------------------------------------------------------------------

  /**
   * 获取团队共享内存存储对象
   * @returns 共享内存接口，未启用则返回 undefined
   */
  getSharedMemory(): MemoryStore | undefined {
    return this.memory?.getStore()
  }

  /**
   * 获取原始 SharedMemory 实例（内部使用）
   * 需要命名空间 / 摘要功能时使用
   * @internal
   */
  getSharedMemoryInstance(): SharedMemory | undefined {
    return this.memory
  }

  // ---------------------------------------------------------------------------
  // 事件监听（Events）
  // ---------------------------------------------------------------------------

  /**
   * 订阅团队事件（核心对外API）
   *
   * 内置事件列表：
   * - `task:ready`    任务准备就绪
   * - `task:complete` 任务完成
   * - `task:failed`   任务失败
   * - `all:complete`  所有任务结束
   * - `message`       点对点消息
   * - `broadcast`     广播消息
   *
   * @returns 取消订阅的函数
   */
  on(event: string, handler: (data: unknown) => void): () => void {
    return this.events.on(event, handler)
  }

  /**
   * 手动触发自定义事件
   * 外部可以用它来扩展业务生命周期事件，无需修改 Team 类
   */
  emit(event: string, data: unknown): void {
    this.events.emit(event, data)
  }
}