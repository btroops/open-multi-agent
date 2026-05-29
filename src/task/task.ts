/**
 * @fileoverview 纯函数式任务工具函数
 *
 * 核心特性：所有工具函数仅操作普通的 Task 对象，**无任何内部可变状态**，
 * 这使得它们可以安全用于 Redux 状态减速器、单元测试、响应式数据流 pipeline 中。
 * 【重要】所有有状态的任务编排/调度逻辑，都应该放在 TaskQueue 类中实现。
 */

import { randomUUID } from 'node:crypto'
import type { Task, TaskStatus } from '../types.js'

// ---------------------------------------------------------------------------
// 任务工厂函数：纯函数创建标准 Task 实例
// ---------------------------------------------------------------------------

/**
 * 创建一个新的任务对象 Task
 * 自动生成 UUID 唯一标识、默认状态为 pending（待执行）、自动设置创建/更新时间
 *
 * @example
 * ```ts
 * const task = createTask({
 *   title: '调研竞争对手',
 *   description: '找出前5名竞争对手及其定价策略',
 *   assignee: '研究员',
 * })
 * ```
 */
export function createTask(input: {
  title: string               // 【必填】任务标题（简短描述）
  description: string         // 【必填】任务详细描述（完整执行要求）
  assignee?: string           // 【可选】任务执行者（智能体名称）
  dependsOn?: string[]        // 【可选】依赖的任务ID数组（必须等这些任务完成才能执行）
  memoryScope?: 'dependencies' | 'all'  // 【可选】共享内存访问范围
  maxRetries?: number         // 【可选】任务执行失败最大重试次数
  retryDelayMs?: number       // 【可选】重试前的延迟时间（毫秒）
  retryBackoff?: number      // 【可选】重试退避系数（指数退避重试）
}): Task {
  // 获取当前时间，统一赋值给创建/更新时间戳
  const now = new Date()

  // 返回标准 Task 结构对象
  return {
    id: randomUUID(),         // 自动生成全球唯一ID，作为任务唯一标识
    title: input.title,        // 赋值任务标题
    description: input.description, // 赋值任务描述
    status: 'pending' as TaskStatus, // 初始状态固定为：待执行
    assignee: input.assignee,  // 赋值任务负责人
    // 【关键】复制依赖数组，避免外部引用修改内部数据（纯函数特性）
    dependsOn: input.dependsOn ? [...input.dependsOn] : undefined,
    memoryScope: input.memoryScope, // 内存作用域
    result: undefined,        // 任务执行结果，初始为未定义
    createdAt: now,           // 任务创建时间
    updatedAt: now,           // 任务最后更新时间（创建/修改/完成都会更新）
    maxRetries: input.maxRetries, // 最大重试次数
    retryDelayMs: input.retryDelayMs, // 重试延迟
    retryBackoff: input.retryBackoff, // 退避系数
  }
}

// ---------------------------------------------------------------------------
// 任务就绪状态判断：检查任务是否可以立即执行
// ---------------------------------------------------------------------------

/**
 * 判断一个任务是否满足【立即执行】的条件
 *
 * 任务就绪的两个**必要条件**：
 * 1. 任务自身状态必须是 pending（待执行）
 * 2. 所有依赖的任务（dependsOn）都必须是 completed（已完成）状态
 *
 * 特殊规则：
 * - 依赖的任务ID不存在于任务列表中 → 视为无法就绪
 *
 * @param task      - 要判断的目标任务
 * @param allTasks  - 当前队列中所有任务的完整集合
 * @param taskById  - 【可选优化】预构建的 任务ID→任务 映射表
 *                    如果提供，函数不会重复构建Map，将循环内调用的复杂度从 O(n²) 降低到 O(n)
 */
export function isTaskReady(
  task: Task,
  allTasks: Task[],
  taskById?: Map<string, Task>,
): boolean {
  // 条件1：任务状态不是待执行 → 直接不就绪
  if (task.status !== 'pending') return false

  // 条件2：任务没有任何依赖 → 直接就绪
  if (!task.dependsOn || task.dependsOn.length === 0) return true

  // 使用外部传入的优化Map，或重新构建（保证查找效率O(1)）
  const taskMap = taskById ?? new Map<string, Task>(allTasks.map((t) => [t.id, t]))

  // 遍历所有依赖任务，逐一校验状态
  for (const depId of task.dependsOn) {
    // 从Map中获取依赖任务
    const dependencyTask = taskMap.get(depId)

    // 【关键判断】
    // 依赖任务不存在，或依赖任务未完成 → 当前任务**不就绪**
    if (!dependencyTask || dependencyTask.status !== 'completed') return false
  }

  // 所有依赖都已完成 → 任务就绪
  return true
}

// ---------------------------------------------------------------------------
// 任务拓扑排序：Kahn 算法实现依赖顺序排序
// ---------------------------------------------------------------------------

/**
 * 对任务列表执行【拓扑排序】，返回符合依赖关系的执行顺序
 * 规则：每个任务一定出现在它所有依赖任务的**后面**
 * 实现算法：经典 Kahn 拓扑排序算法
 *
 * 执行规则：
 * 1. 无依赖的任务排在最前面
 * 2. 存在循环依赖时，仅返回能正常排序的任务（生产环境建议先校验依赖）
 *
 * @example
 * ```ts
 * // 按依赖顺序执行任务
 * const orderedTasks = getTaskDependencyOrder(tasks)
 * for (const task of orderedTasks) {
 *   await run(task)
 * }
 * ```
 */
export function getTaskDependencyOrder(tasks: Task[]): Task[] {
  // 空数组直接返回
  if (tasks.length === 0) return []

  // 构建 任务ID → 任务对象 的映射表，O(1) 快速查找
  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]))

  // --------------------------
  // 第一步：构建任务依赖图（拓扑排序核心数据结构）
  // --------------------------
  const inDegree = new Map<string, number>()
  // 入度：当前任务依赖的【有效任务数量】
  // 入度=0 → 无依赖，可以直接执行

  const successors = new Map<string, string[]>()
  // 后继节点：依赖当前任务的所有子任务
  // 例：A依赖B → B的后继是A

  // 初始化所有任务的入度和后继列表
  for (const task of tasks) {
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0)
    if (!successors.has(task.id)) successors.set(task.id, [])

    // 遍历当前任务的所有依赖
    for (const depId of task.dependsOn ?? []) {
      // 只处理存在的有效依赖（忽略无效ID）
      if (taskById.has(depId)) {
        // 当前任务入度 +1（多一个依赖）
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
        // 将当前任务加入【被依赖任务】的后继列表
        const depSuccessors = successors.get(depId) ?? []
        depSuccessors.push(task.id)
        successors.set(depId, depSuccessors)
      }
    }
  }

  // --------------------------
  // 第二步：执行 Kahn 算法
  // --------------------------
  // 初始化队列：所有入度=0（无依赖）的任务，作为起始执行节点
  const queue: string[] = []
  for (const [taskId, degree] of inDegree) {
    if (degree === 0) queue.push(taskId)
  }

  // 存储最终排序结果
  const orderedTasks: Task[] = []

  // 循环处理队列
  while (queue.length > 0) {
    // 取出队首任务ID
    const currentTaskId = queue.shift()!
    // 获取任务对象，加入结果列表
    const currentTask = taskById.get(currentTaskId)
    if (currentTask) orderedTasks.push(currentTask)

    // 遍历当前任务的所有后继（依赖它的任务）
    for (const successorId of successors.get(currentTaskId) ?? []) {
      // 后继任务的入度 -1（因为一个依赖已完成）
      const newDegree = (inDegree.get(successorId) ?? 0) - 1
      inDegree.set(successorId, newDegree)

      // 如果入度变为0 → 该任务就绪，加入队列
      if (newDegree === 0) queue.push(successorId)
    }
  }

  // 返回拓扑排序后的任务列表
  return orderedTasks
}

// ---------------------------------------------------------------------------
// 任务依赖校验：检测无效依赖、自依赖、循环依赖
// ---------------------------------------------------------------------------

/**
 * 完整校验任务依赖图的合法性，排查三类致命错误：
 * 1. 自依赖（任务依赖自己）
 * 2. 引用不存在的无效任务ID
 * 3. 循环依赖（A→B→C→A，死锁）
 *
 * @returns valid：是否通过校验
 *          errors：错误描述数组
 *
 * @example
 * ```ts
 * const { valid, errors } = validateTaskDependencies(tasks)
 * if (!valid) throw new Error(errors.join('\n'))
 * ```
 */
export function validateTaskDependencies(tasks: Task[]): {
  valid: boolean
  errors: string[]
} {
  // 存储所有校验错误
  const errors: string[] = []
  // 构建任务ID映射表
  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]))

  // --------------------------
  // 第一遍校验：基础错误检查
  // 1. 自依赖检查
  // 2. 无效任务ID检查
  // --------------------------
  for (const task of tasks) {
    // 遍历当前任务的所有依赖
    for (const depId of task.dependsOn ?? []) {
      // 检查1：任务依赖自己
      if (depId === task.id) {
        errors.push(`任务"${task.title}"（ID: ${task.id}）存在自依赖，无法执行。`)
        continue
      }
      // 检查2：依赖的任务ID不存在
      if (!taskById.has(depId)) {
        errors.push(`任务"${task.title}"（ID: ${task.id}）引用了不存在的依赖ID："${depId}"。`)
      }
    }
  }

  // --------------------------
  // 第二遍校验：循环依赖检测（DFS 三色染色法）
  // 算法标准实现，高效检测有向图环
  // --------------------------
  // 三色标记定义：
  // 0 (白色)  = 未访问 / 未处理
  // 1 (灰色)  = 正在访问 / 递归栈中
  // 2 (黑色)  = 已访问 / 处理完成
  const nodeColor = new Map<string, 0 | 1 | 2>()
  for (const task of tasks) nodeColor.set(task.id, 0)

  // 递归DFS遍历函数
  const visitNode = (currentId: string, path: string[]): void => {
    // 节点已处理完成，直接返回
    if (nodeColor.get(currentId) === 2) return

    // 节点正在访问中 → 发现【循环依赖】！
    if (nodeColor.get(currentId) === 1) {
      // 截取循环路径
      const cycleStartIndex = path.indexOf(currentId)
      const cyclePath = path.slice(cycleStartIndex).concat(currentId)
      errors.push(`检测到循环依赖：${cyclePath.join(' -> ')}`)
      return
    }

    // 标记为：正在访问（灰色）
    nodeColor.set(currentId, 1)

    // 递归访问当前任务的所有依赖
    const currentTask = taskById.get(currentId)
    for (const depId of currentTask?.dependsOn ?? []) {
      // 只遍历有效任务
      if (taskById.has(depId)) {
        visitNode(depId, [...path, currentId])
      }
    }

    // 标记为：处理完成（黑色）
    nodeColor.set(currentId, 2)
  }

  // 遍历所有未访问的任务，启动DFS检测
  for (const task of tasks) {
    if (nodeColor.get(task.id) === 0) {
      visitNode(task.id, [])
    }
  }

  // 返回最终校验结果：无错误则合法
  return { valid: errors.length === 0, errors }
}