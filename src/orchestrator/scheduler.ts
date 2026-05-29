/**
 * @fileoverview 开放式多智能体编排器的任务调度策略模块
 *
 * {@link Scheduler} 调度器类封装了四种独立的任务分配策略，
 * 用于将一组待执行的 {@link Task} 任务，分配给一组可用的智能体（Agent）：
 *
 * 1. `round-robin` (轮询)      — 按索引均匀分配任务，最基础的负载均衡。
 * 2. `least-busy` (最空闲)     — 分配给当前正在执行任务最少的智能体。
 * 3. `capability-match` (能力匹配) — 根据任务描述与智能体能力的关键词匹配度分配。
 * 4. `dependency-first` (依赖优先) — 优先分配阻塞了最多其他任务的“关键路径”任务。
 *
 * 该调度器是**无状态**的（每次调用独立）。所有可变的任务状态都存储在传入的
 * {@link TaskQueue} 任务队列中。
 */

import type { AgentConfig, Task } from '../types.js'
import type { TaskQueue } from '../task/queue.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

// ---------------------------------------------------------------------------
// 公共类型定义
// ---------------------------------------------------------------------------

/**
 * 调度器支持的四种策略类型
 *
 * - `round-robin`       — 按智能体索引顺序轮询分配
 * - `least-busy`        — 优先分配给任务最少（最空闲）的智能体
 * - `capability-match`  — 基于任务文本与智能体角色的关键词亲和度分配
 * - `dependency-first`  — 优先调度能解锁最多下游任务的关键任务
 */
export type SchedulingStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capability-match'
  | 'dependency-first'

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 【核心算法】统计有多少个任务（直接或间接）被阻塞，等待指定任务完成
 * 用于 `dependency-first` 策略，计算每个任务的“关键程度/优先级”
 *
 * 算法：前向广度优先搜索 (BFS) 遍历依赖图
 * 逻辑：对于每个依赖了 `taskId` 的任务，加入结果集并递归查找，不重复访问节点
 *
 * @param taskId - 要统计的任务ID
 * @param allTasks - 所有任务列表
 * @returns 被该任务阻塞的任务总数
 */
function countBlockedDependents(taskId: string, allTasks: Task[]): number {
  // 1. 构建 任务ID -> 任务对象 的映射，加速查找
  const idToTask = new Map<string, Task>(allTasks.map((t) => [t.id, t]))

  // 2. 构建【反向依赖图】: key = 被依赖的任务ID, value = 依赖它的任务ID列表
  // 例如：A依赖B，C依赖B -> dependents.get(B) = [A, C]
  const dependents = new Map<string, string[]>()
  for (const t of allTasks) {
    // 遍历当前任务的所有依赖
    for (const depId of t.dependsOn ?? []) {
      // 当前任务 t 依赖于 depId，所以 t 是 depId 的下游/被阻塞者
      const list = dependents.get(depId) ?? []
      list.push(t.id)
      dependents.set(depId, list)
    }
  }

  // 3. BFS 遍历，统计所有被阻塞的任务
  const visited = new Set<string>() // 记录已访问的任务ID，防止环和重复计算
  const queue: string[] = [taskId]  // 初始化队列，从目标任务开始

  while (queue.length > 0) {
    const current = queue.shift()! // 取出队首任务
    // 遍历当前任务的所有下游（依赖它的任务）
    for (const depId of dependents.get(current) ?? []) {
      // 如果未访问过，且任务存在
      if (!visited.has(depId) && idToTask.has(depId)) {
        visited.add(depId)       // 标记为已访问
        queue.push(depId)        // 加入队列，继续向下游查找
      }
    }
  }

  // 4. 返回总数（visited 中不包含起始任务本身，直接返回大小即可）
  return visited.size
}

// ---------------------------------------------------------------------------
// 调度器主类
// ---------------------------------------------------------------------------

/**
 * 任务调度器：使用四种可配置策略之一，将待执行任务分配给可用智能体
 *
 * @example
 * ```ts
 * // 创建一个基于“能力匹配”的调度器
 * const scheduler = new Scheduler('capability-match')
 *
 * // 生成任务 -> 智能体 的分配映射表
 * const assignments = scheduler.schedule(pendingTasks, teamAgents)
 *
 * // 或者直接自动更新任务队列的负责人
 * scheduler.autoAssign(queue, teamAgents)
 * ```
 */
export class Scheduler {
  /**
   * 轮询算法专用游标
   * 用于记录上一次分配到了哪个智能体，保证连续调用时均匀分发，
   * 而不是每次都从第一个智能体开始。
   */
  private roundRobinCursor = 0

  /**
   * 构造函数：初始化调度策略
   * @param strategy - 要使用的调度算法，默认 'dependency-first' (依赖优先)
   *                   这是复杂多步骤任务流最安全、最高效的默认策略
   */
  constructor(private readonly strategy: SchedulingStrategy = 'dependency-first') {}

  // -------------------------------------------------------------------------
  // 主 API 入口
  // -------------------------------------------------------------------------

  /**
   * 核心调度方法：根据待分配任务和智能体列表，返回任务分配方案
   *
   * 规则：
   * 1. 只处理 **状态为 pending 且 未分配负责人** 的任务
   * 2. 已分配负责人的任务保持不变
   * 3. 除 `round-robin` 外，其他算法均为**确定性算法**（输入相同，输出必相同）
   *
   * @param tasks - 当前运行中所有任务的快照（任意状态）
   * @param agents - 可用的智能体配置列表
   * @returns Map<任务ID, 智能体名称> 分配结果
   */
  schedule(tasks: Task[], agents: AgentConfig[]): Map<string, string> {
    // 无可用智能体，直接返回空映射
    if (agents.length === 0) return new Map()

    // 筛选出：待执行 + 无负责人 的任务（这些才需要分配）
    const unassigned = tasks.filter(
      (t) => t.status === 'pending' && !t.assignee,
    )

    // 根据策略路由到具体实现
    switch (this.strategy) {
      case 'round-robin':
        return this.scheduleRoundRobin(unassigned, agents)
      case 'least-busy':
        return this.scheduleLeastBusy(unassigned, agents, tasks)
      case 'capability-match':
        return this.scheduleCapabilityMatch(unassigned, agents)
      case 'dependency-first':
        return this.scheduleDependencyFirst(unassigned, agents, tasks)
    }
  }

  /**
   * 便捷方法：自动将调度结果应用到**实时任务队列**
   *
   * 逻辑：
   * 1. 调用 schedule 获取分配方案
   * 2. 遍历方案，调用 queue.update 设置任务负责人
   * 3. 捕获异常：任务可能在调度瞬间已完成/失败，跳过即可
   *
   * @param queue - 实时任务队列（会被修改）
   * @param agents - 可用智能体
   */
  autoAssign(queue: TaskQueue, agents: AgentConfig[]): void {
    const allTasks = queue.list()
    const assignments = this.schedule(allTasks, agents)

    for (const [taskId, agentName] of assignments) {
      try {
        // 为任务设置负责人（智能体名称）
        queue.update(taskId, { assignee: agentName })
      } catch {
        // 任务可能已完成/失败/被删除，安全跳过
      }
    }
  }

  // -------------------------------------------------------------------------
  // 四大调度策略具体实现
  // -------------------------------------------------------------------------

  /**
   * 策略1：轮询调度 (Round Robin)
   *
   * 原理：按智能体数组顺序，1号、2号、3号、1号、2号、3号...循环分配
   * 特点：最简单、最公平、无状态感知
   * 优势：绝对均匀分配任务数量
   */
  private scheduleRoundRobin(
    unassigned: Task[],
    agents: AgentConfig[],
  ): Map<string, string> {
    const result = new Map<string, string>()

    for (const task of unassigned) {
      // 计算当前游标对应的智能体索引（取模实现循环）
      const agentIndex = this.roundRobinCursor % agents.length
      const agent = agents[agentIndex]!
      
      // 记录分配结果
      result.set(task.id, agent.name)
      
      // 游标自增，为下一个任务准备
      this.roundRobinCursor = (this.roundRobinCursor + 1) % agents.length
    }

    return result
  }

  /**
   * 策略2：最空闲优先 (Least Busy)
   *
   * 原理：实时统计每个智能体正在运行（in_progress）的任务数，
   *       每次都把新任务分配给**当前负载最小**的智能体。
   * 特点：动态负载均衡，防止单个智能体过载
   * 平局规则：负载相同时，选择数组中靠前的智能体
   */
  private scheduleLeastBusy(
    unassigned: Task[],
    agents: AgentConfig[],
    allTasks: Task[],
  ): Map<string, string> {
    // 1. 初始化负载计数器：key=智能体名, value=正在执行的任务数
    const load = new Map<string, number>(agents.map((a) => [a.name, 0]))
    
    // 2. 统计当前真实负载（遍历所有任务）
    for (const task of allTasks) {
      // 只统计【执行中】且【已分配】的任务
      if (task.status === 'in_progress' && task.assignee) {
        const currentLoad = load.get(task.assignee) ?? 0
        load.set(task.assignee, currentLoad + 1)
      }
    }

    const result = new Map<string, string>()

    // 3. 逐个分配任务
    for (const task of unassigned) {
      // 初始化：假设第一个智能体最优
      let bestAgent = agents[0]!
      let bestLoad = load.get(bestAgent.name) ?? 0

      // 遍历所有智能体，找出负载最小的
      for (let i = 1; i < agents.length; i++) {
        const agent = agents[i]!
        const agentLoad = load.get(agent.name) ?? 0
        
        // 发现更空闲的，更新最优解
        if (agentLoad < bestLoad) {
          bestLoad = agentLoad
          bestAgent = agent
        }
      }

      // 4. 执行分配
      result.set(task.id, bestAgent.name)
      
      // 5. 【关键】模拟负载增加
      // 本轮批量分配中，假设任务已发出，防止所有任务都堆给同一个“初始最闲”的智能体
      load.set(bestAgent.name, (load.get(bestAgent.name) ?? 0) + 1)
    }

    return result
  }

  /**
   * 策略3：能力匹配调度 (Capability Match)
   *
   * 原理：NLP 关键词匹配。
   *       提取任务（标题+描述）的关键词，与智能体（名称+系统提示词）的关键词对比，
   *       得分最高的智能体执行该任务。
   * 特点：让专业的人干专业的事，智能分配，提升执行质量
   * 降级：无匹配度时，自动回退到轮询
   */
  private scheduleCapabilityMatch(
    unassigned: Task[],
    agents: AgentConfig[],
  ): Map<string, string> {
    const result = new Map<string, string>()

    // 1. 【预计算优化】提前提取所有智能体的关键词，避免每个任务重复计算
    const agentKeywords = new Map<string, string[]>(
      agents.map((a) => [
        a.name,
        // 从 名称 + 系统提示词 + 模型 中提取能力关键词
        extractKeywords(`${a.name} ${a.systemPrompt ?? ''} ${a.model}`),
      ]),
    )

    // 2. 遍历每个未分配任务，计算最佳匹配智能体
    for (const task of unassigned) {
      // 提取任务关键词
      const taskText = `${task.title} ${task.description}`
      const taskKeywords = extractKeywords(taskText)

      // 初始化最优解
      let bestAgent = agents[0]!
      let bestScore = -1

      // 3. 为当前任务匹配所有智能体，计算得分
      for (const agent of agents) {
        const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
        
        // 双向匹配得分，更精准：
        // scoreA: 智能体描述 包含多少 任务关键词
        const scoreA = keywordScore(agentText, taskKeywords)
        // scoreB: 任务描述 包含多少 智能体关键词
        const scoreB = keywordScore(taskText, agentKeywords.get(agent.name) ?? [])
        
        // 总得分
        const totalScore = scoreA + scoreB

        // 更新最高分
        if (totalScore > bestScore) {
          bestScore = totalScore
          bestAgent = agent
        }
      }

      // 4. 分配给得分最高的智能体
      result.set(task.id, bestAgent.name)
    }

    return result
  }

  /**
   * 策略4：依赖优先调度 (Dependency First) —— **最优默认策略**
   *
   * 原理：
   * 1. 计算每个任务的**关键度**（阻塞了多少下游任务）
   * 2. 关键度越高，优先级越高，越先分配
   * 3. 优先级相同的任务，使用轮询分配给智能体
   *
   * 核心价值：
   * 优先执行关键路径上的任务，最大化并行效率，缩短整体任务完成时间。
   */
  private scheduleDependencyFirst(
    unassigned: Task[],
    agents: AgentConfig[],
    allTasks: Task[],
  ): Map<string, string> {
    // 1. 【核心排序】按【被阻塞任务数】降序排列
    // 阻塞别人越多的任务，排越前面，优先分配
    const rankedTasks = [...unassigned].sort((taskA, taskB) => {
      const criticalityA = countBlockedDependents(taskA.id, allTasks)
      const criticalityB = countBlockedDependents(taskB.id, allTasks)
      // 降序：大的在前
      return criticalityB - criticalityA
    })

    const result = new Map<string, string>()
    // 使用本地游标，不污染类的主游标，但最终会同步
    let assignCursor = this.roundRobinCursor

    // 2. 按排好的优先级顺序，轮询分配给智能体
    for (const task of rankedTasks) {
      const agent = agents[assignCursor % agents.length]!
      result.set(task.id, agent.name)
      assignCursor = (assignCursor + 1) % agents.length
    }

    // 3. 同步游标状态，保证与纯轮询策略行为一致
    this.roundRobinCursor = assignCursor

    return result
  }
}