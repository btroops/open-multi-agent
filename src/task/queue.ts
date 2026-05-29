/**
 * @fileoverview 感知依赖关系的任务队列（核心状态管理类）
 *
 * {@link TaskQueue} 持有并管理所有任务的**可变生命周期**。
 * 核心特性：
 * 1. 完成一个任务会**自动解锁**其所有下游依赖任务
 * 2. 全程**事件驱动**，无需轮询状态，编排器可实时响应
 * 3. 自动处理任务阻塞、就绪、完成、失败、跳过的全生命周期
 */

import type { Task, TaskStatus } from '../types.js'
import { isTaskReady } from './task.js'

// ---------------------------------------------------------------------------
// 事件类型定义（任务队列触发的所有事件）
// ---------------------------------------------------------------------------

/** 任务队列对外发射的事件名称类型 */
export type TaskQueueEvent =
  | 'task:ready'      // 任务就绪 → 可以执行
  | 'task:complete'   // 任务完成
  | 'task:failed'     // 任务失败
  | 'task:skipped'    // 任务跳过
  | 'all:complete'    // 所有任务结束（完成/失败/跳过）

/** 任务相关事件处理器（携带任务参数） */
type TaskHandler = (task: Task) => void
/** 全局完成事件处理器（无参数） */
type AllCompleteHandler = () => void

/** 动态匹配事件对应的处理器类型（类型安全） */
type HandlerFor<E extends TaskQueueEvent> = E extends 'all:complete'
  ? AllCompleteHandler
  : TaskHandler

// ---------------------------------------------------------------------------
// 任务队列核心类（可变状态 + 事件驱动 + 依赖解析）
// ---------------------------------------------------------------------------

/**
 * 支持拓扑依赖解析的**可变、事件驱动**任务队列
 *
 * 任务状态流转规则：
 * 1. 任务初始为 pending（待执行）
 * 2. 存在未完成依赖 → 自动转为 blocked（已阻塞）
 * 3. 依赖全部完成 → 自动转回 pending，并触发 task:ready 事件
 *
 * 调用方通过 next/nextAvailable 获取任务，通过 complete/fail 更新状态
 * 全程无轮询，事件驱动响应状态变化
 *
 * @example
 * ```ts
 * const queue = new TaskQueue()
 * // 监听任务就绪，自动执行
 * queue.on('task:ready', (task) => scheduleExecution(task))
 * // 监听全部完成，关闭服务
 * queue.on('all:complete', () => shutdown())
 *
 * // 批量添加任务
 * queue.addBatch(tasks)
 * ```
 */
export class TaskQueue {
  /**
   * 任务存储中心：使用 Map 保证 O(1) 读写
   * key = 任务ID, value = 任务对象
   * private 保证外部无法直接篡改，只能通过类方法操作
   */
  private readonly tasks = new Map<string, Task>()

  /**
   * 事件监听器管理器（双层Map结构）
   * 第一层 key：事件类型（TaskQueueEvent）
   * 第二层 key：唯一Symbol（用于取消订阅）, value：事件处理器
   * 支持多订阅、安全取消订阅
   */
  private readonly listeners = new Map<
    TaskQueueEvent,
    Map<symbol, TaskHandler | AllCompleteHandler>
  >()

  // ---------------------------------------------------------------------------
  // 任务添加模块：新增单个/批量任务
  // ---------------------------------------------------------------------------

  /**
   * 添加单个任务到队列
   *
   * 逻辑：
   * 1. 自动判断任务初始状态（有无依赖）
   * 2. 无依赖 → pending，触发 task:ready
   * 3. 有未完成依赖 → blocked，不触发事件
   */
  add(task: Task): void {
    // 解析任务初始状态（pending / blocked）
    const resolved = this.resolveInitialStatus(task)
    // 存入队列
    this.tasks.set(resolved.id, resolved)
    // 就绪则触发就绪事件
    if (resolved.status === 'pending') {
      this.emit('task:ready', resolved)
    }
  }

  /**
   * 批量添加多个任务
   *
   * 特性：
   * 逐个添加，每添加一个都会重新计算依赖
   * 如果数组中前面的任务是后面任务的依赖，会自动正确解锁
   * 如需严格顺序，可提前用 getTaskDependencyOrder 排序
   */
  addBatch(tasks: Task[]): void {
    for (const task of tasks) {
      this.add(task)
    }
  }

  // ---------------------------------------------------------------------------
  // 任务状态更新模块：更新/完成/失败/跳过
  // ---------------------------------------------------------------------------

  /**
   * 对现有任务应用**安全局部更新**（限制可更新字段）
   * 仅允许更新：状态、结果、负责人
   * 自动更新 updatedAt 时间戳
   *
   * @throws 任务ID不存在时抛出错误
   */
  update(
    taskId: string,
    update: Partial<Pick<Task, 'status' | 'result' | 'assignee'>>,
  ): Task {
    // 校验任务必须存在
    const task = this.requireTask(taskId)
    // 合并更新，生成新任务对象（保持不可变更新模式）
    const updated: Task = {
      ...task,
      ...update,
      updatedAt: new Date(), // 自动刷新更新时间
    }
    // 存回队列
    this.tasks.set(taskId, updated)
    return updated
  }

  /**
   * 标记任务为【已完成】
   *
   * 执行流程：
   * 1. 更新任务状态为 completed，保存结果
   * 2. 触发 task:complete 事件
   * 3. 自动解锁所有依赖此任务的阻塞任务
   * 4. 如果全部任务结束，触发 all:complete
   *
   * @throws 任务ID不存在时抛出错误
   */
  complete(taskId: string, result?: string): Task {
    const completed = this.update(taskId, { status: 'completed', result })
    this.emit('task:complete', completed)
    // 核心：解锁依赖此任务的所有阻塞任务
    this.unblockDependents(taskId)
    // 判断队列是否全部完成
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return completed
  }

  /**
   * 标记任务为【已失败】
   *
   * 执行流程：
   * 1. 更新状态为 failed，错误信息存入 result
   * 2. 触发 task:failed 事件
   * 3. **级联失败**：所有依赖此任务的下游任务全部标记为失败
   * 4. 全部完成则触发 all:complete
   *
   * 作用：避免上游失败后，下游任务无限期阻塞
   */
  fail(taskId: string, error: string): Task {
    const failed = this.update(taskId, { status: 'failed', result: error })
    this.emit('task:failed', failed)
    // 级联失败所有下游任务
    this.cascadeFailure(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return failed
  }

  /**
   * 标记任务为【已跳过】
   *
   * 执行流程：
   * 1. 更新状态为 skipped，原因存入 result
   * 2. 触发 task:skipped 事件
   * 3. **级联跳过**：所有下游依赖任务全部跳过
   * 4. 全部完成则触发 all:complete
   */
  skip(taskId: string, reason: string): Task {
    const skipped = this.update(taskId, { status: 'skipped', result: reason })
    this.emit('task:skipped', skipped)
    // 级联跳过所有下游任务
    this.cascadeSkip(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return skipped
  }

  /**
   * 批量跳过**所有未结束**的任务
   * 适用场景：审批拒绝、手动终止流程
   *
   * 安全机制：
   * 先生成快照再遍历，避免遍历中修改Map导致的异常
   * 仅跳过非终结状态（pending/blocked/in_progress）
   */
  skipRemaining(reason = 'Skipped: approval rejected.'): void {
    // 生成快照：遍历期间不修改原Map，保证线程安全
    const snapshot = Array.from(this.tasks.values())
    for (const task of snapshot) {
      // 跳过已终结状态的任务
      if (['completed', 'failed', 'skipped'].includes(task.status)) continue
      const skipped = this.update(task.id, { status: 'skipped', result: reason })
      this.emit('task:skipped', skipped)
    }
    if (this.isComplete()) {
      this.emitAllComplete()
    }
  }

  // ---------------------------------------------------------------------------
  // 私有级联逻辑：失败/跳过的递归传播
  // ---------------------------------------------------------------------------

  /**
   * 【私有】递归级联失败：所有依赖该任务的下游任务 → 标记失败
   * 仅处理 pending/blocked 状态任务
   * 递归处理多层依赖（传递性失败）
   */
  private cascadeFailure(failedTaskId: string): void {
    for (const task of this.tasks.values()) {
      // 只处理未完成的任务
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      // 只处理直接依赖该失败任务的任务
      if (!task.dependsOn?.includes(failedTaskId)) continue

      // 更新为级联失败
      const cascaded = this.update(task.id, {
        status: 'failed',
        result: `Cancelled: dependency "${failedTaskId}" failed.`,
      })
      this.emit('task:failed', cascaded)
      // 递归：继续处理当前任务的下游任务
      this.cascadeFailure(task.id)
    }
  }

  /**
   * 【私有】递归级联跳过：所有依赖该任务的下游任务 → 标记跳过
   * 逻辑与 cascadeFailure 完全一致
   */
  private cascadeSkip(skippedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      if (!task.dependsOn?.includes(skippedTaskId)) continue

      const cascaded = this.update(task.id, {
        status: 'skipped',
        result: `Skipped: dependency "${skippedTaskId}" was skipped.`,
      })
      this.emit('task:skipped', cascaded)
      // 递归传递
      this.cascadeSkip(task.id)
    }
  }

  // ---------------------------------------------------------------------------
  // 任务查询模块：获取待执行任务、状态查询、进度统计
  // ---------------------------------------------------------------------------

  /**
   * 获取指定负责人的**下一个就绪任务**（pending）
   * @param assignee 智能体名称，不传则等价于 nextAvailable
   * @returns 匹配的任务 或 undefined
   */
  next(assignee?: string): Task | undefined {
    if (assignee === undefined) return this.nextAvailable()

    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.assignee === assignee) {
        return task
      }
    }
    return undefined
  }

  /**
   * 获取**全局下一个可用任务**（调度优先级）
   * 优先级：
   * 1. 无负责人的 pending 任务（最高）
   * 2. 第一个有负责人的 pending 任务（兜底）
   */
  nextAvailable(): Task | undefined {
    let fallback: Task | undefined

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue
      // 优先返回无负责人的任务
      if (!task.assignee) return task
      // 记录兜底任务
      if (!fallback) fallback = task
    }

    return fallback
  }

  /** 返回所有任务的快照数组（任何状态） */
  list(): Task[] {
    return Array.from(this.tasks.values())
  }

  /** 根据状态筛选任务数组 */
  getByStatus(status: TaskStatus): Task[] {
    return this.list().filter((t) => t.status === status)
  }

  /** 根据ID查询任务，存在则返回，否则undefined */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 判断队列是否**全部完成**
   * 终结状态：completed / failed / skipped
   * 空队列也视为完成
   */
  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (!['completed', 'failed', 'skipped'].includes(task.status)) {
        return false
      }
    }
    return true
  }

  /**
   * 获取任务执行进度统计（可视化/监控用）
   * @returns 各状态任务数量 + 总数
   */
  getProgress(): {
    total: number
    completed: number
    failed: number
    skipped: number
    inProgress: number
    pending: number
    blocked: number
  } {
    // 初始化所有计数器
    let completed = 0
    let failed = 0
    let skipped = 0
    let inProgress = 0
    let pending = 0
    let blocked = 0

    // 遍历统计
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'completed': completed++; break
        case 'failed': failed++; break
        case 'skipped': skipped++; break
        case 'in_progress': inProgress++; break
        case 'pending': pending++; break
        case 'blocked': blocked++; break
      }
    }

    return {
      total: this.tasks.size,
      completed, failed, skipped, inProgress, pending, blocked
    }
  }

  // ---------------------------------------------------------------------------
  // 事件系统：订阅/取消订阅、事件触发
  // ---------------------------------------------------------------------------

  /**
   * 订阅队列事件（核心事件驱动API）
   * @returns 取消订阅函数（幂等安全）
   *
   * 设计：使用 Symbol 作为唯一订阅ID，避免重复、安全卸载
   */
  on<E extends TaskQueueEvent>(
    event: E,
    handler: HandlerFor<E>,
  ): () => void {
    // 获取事件对应的监听器Map，不存在则创建
    let map = this.listeners.get(event)
    if (!map) {
      map = new Map()
      this.listeners.set(event, map)
    }
    // 生成唯一ID，绑定处理器
    const id = Symbol()
    map.set(id, handler as TaskHandler | AllCompleteHandler)
    
    // 返回取消订阅函数（外部调用即可销毁）
    return () => {
      map!.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // 私有工具方法：状态解析、依赖解锁、事件发射、任务校验
  // ---------------------------------------------------------------------------

  /**
   * 【私有】解析任务**初始状态**
   * 无依赖 → pending
   * 有依赖但未就绪 → blocked
   */
  private resolveInitialStatus(task: Task): Task {
    if (!task.dependsOn || task.dependsOn.length === 0) return task

    const allCurrent = Array.from(this.tasks.values())
    // 调用纯函数判断是否就绪
    const ready = isTaskReady(task, allCurrent)
    if (ready) return task

    // 未就绪 → 标记为阻塞
    return { ...task, status: 'blocked', updatedAt: new Date() }
  }

  /**
   * 【私有】核心：任务完成后，**解锁所有被阻塞的依赖任务**
   * 逻辑：
   * 1. 遍历所有 blocked 任务
   * 2. 检查是否依赖刚完成的任务
   * 3. 重新判断是否就绪，就绪则改为 pending
   * 4. 触发 task:ready 事件
   *
   * 性能优化：一次性构建任务Map，O(n)复杂度
   */
  private unblockDependents(completedId: string): void {
    const allTasks = Array.from(this.tasks.values())
    const taskById = new Map<string, Task>(allTasks.map((t) => [t.id, t]))

    for (const task of allTasks) {
      if (task.status !== 'blocked') continue
      if (!task.dependsOn?.includes(completedId)) continue

      // 重新校验任务是否就绪（传入预构建Map优化性能）
      if (isTaskReady({ ...task, status: 'pending' }, allTasks, taskById)) {
        const unblocked: Task = {
          ...task,
          status: 'pending',
          updatedAt: new Date(),
        }
        this.tasks.set(task.id, unblocked)
        taskById.set(task.id, unblocked) // 更新快照
        this.emit('task:ready', unblocked) // 触发就绪事件
      }
    }
  }

  /** 【私有】触发任务相关事件（ready/complete/failed/skipped） */
  private emit(event: 'task:ready' | 'task:complete' | 'task:failed' | 'task:skipped', task: Task): void {
    const map = this.listeners.get(event)
    if (!map) return
    // 执行所有订阅的处理器
    for (const handler of map.values()) {
      (handler as TaskHandler)(task)
    }
  }

  /** 【私有】触发 all:complete 事件（全部任务结束） */
  private emitAllComplete(): void {
    const map = this.listeners.get('all:complete')
    if (!map) return
    for (const handler of map.values()) {
      (handler as AllCompleteHandler)()
    }
  }

  /**
   * 【私有】强制获取任务，不存在则抛出错误
   * 统一的任务存在性校验工具
   */
  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`TaskQueue: task "${taskId}" not found.`)
    return task
  }
}