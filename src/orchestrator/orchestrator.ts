/**
 * @fileoverview OpenMultiAgent — the top-level multi-agent orchestration class.
 *
 * {@link OpenMultiAgent} is the primary public API of the open-multi-agent framework.
 * It ties together every subsystem:
 *
 *  - {@link Team}       — Agent roster, shared memory, inter-agent messaging
 *  - {@link TaskQueue}  — Dependency-aware work queue
 *  - {@link Scheduler}  — Task-to-agent assignment strategies
 *  - {@link AgentPool}  — Concurrency-controlled execution pool
 *  - {@link Agent}      — Conversation + tool-execution loop
 *
 * ## Quick start
 *
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 *
 * const team = orchestrator.createTeam('research', {
 *   name: 'research',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You are a researcher.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You are a technical writer.' },
 *   ],
 *   sharedMemory: true,
 * })
 *
 * const result = await orchestrator.runTeam(team, 'Produce a report on TypeScript 5.5.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ## Key design decisions
 *
 * - **Coordinator pattern** — `runTeam()` spins up a temporary "coordinator" agent
 *   that breaks the high-level goal into tasks, assigns them, and synthesises the
 *   final answer. This is the framework's killer feature.
 * - **Parallel-by-default** — Independent tasks (no shared dependency) run in
 *   parallel up to `maxConcurrency`.
 * - **Graceful failure** — A failed task marks itself `'failed'` and its direct
 *   dependents remain `'blocked'` indefinitely; all non-dependent tasks continue.
 * - **Progress callbacks** — Callers can pass `onProgress` in the config to receive
 *   structured {@link OrchestratorEvent}s without polling.
 */

import type {
  AgentConfig,
  AgentRunResult,
  CoordinatorConfig,
  RunTeamOptions,
  OrchestratorConfig,
  OrchestratorEvent,
  Task,
  TaskExecutionMetrics,
  TaskExecutionRecord,
  TaskStatus,
  TeamConfig,
  TeamInfo,
  TeamRunResult,
  TokenUsage,
} from '../types.js'
import type { RunOptions } from '../agent/runner.js'
import { Agent } from '../agent/agent.js'
import { AgentPool } from '../agent/pool.js'
import { emitTrace, generateRunId } from '../utils/trace.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { createTask } from '../task/task.js'
import { Scheduler } from './scheduler.js'
import { TokenBudgetExceededError } from '../errors.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MAX_DELEGATION_DEPTH = 3
const DEFAULT_MODEL = 'claude-opus-4-6'

// ---------------------------------------------------------------------------
// Short-circuit helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Regex patterns that indicate a goal requires multi-agent coordination.
 *
 * Each pattern targets a distinct complexity signal:
 * - Sequencing:     "first … then", "step 1 / step 2", numbered lists
 * - Coordination:   "collaborate", "coordinate", "review each other"
 * - Parallel work:  "in parallel", "at the same time", "concurrently"
 * - Multi-phase:    "phase", "stage", multiple distinct action verbs joined by connectives
 */
const COMPLEXITY_PATTERNS: RegExp[] = [
  // Explicit sequencing
  /\bfirst\b.{3,60}\bthen\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\bstage\s*\d/i,
  /^\s*\d+[\.\)]/m,                       // numbered list items ("1. …", "2) …")

  // Coordination language — must be an imperative directive aimed at the agents
  // ("collaborate with X", "coordinate the team", "agents should coordinate"),
  // not a descriptive use ("how does X coordinate with Y" / "what does collaboration mean").
  // Match either an explicit preposition or a noun-phrase that names a group.
  /\bcollaborat(?:e|ing)\b\s+(?:with|on|to)\b/i,
  /\bcoordinat(?:e|ing)\b\s+(?:with|on|across|between|the\s+(?:team|agents?|workers?|effort|work))\b/i,
  /\breview\s+each\s+other/i,
  /\bwork\s+together\b/i,

  // Parallel execution
  /\bin\s+parallel\b/i,
  /\bconcurrently\b/i,
  /\bat\s+the\s+same\s+time\b/i,

  // Multiple deliverables joined by connectives
  // Matches patterns like "build X, then deploy Y and test Z"
  /\b(?:build|create|implement|design|write|develop)\b.{5,80}\b(?:and|then)\b.{5,80}\b(?:build|create|implement|design|write|develop|test|review|deploy)\b/i,
]


/**
 * Maximum goal length (in characters) below which a goal *may* be simple.
 *
 * Goals longer than this threshold almost always contain enough detail to
 * warrant multi-agent decomposition. The value is generous — short-circuit
 * is meant for genuinely simple, single-action goals.
 */
const SIMPLE_GOAL_MAX_LENGTH = 200

/**
 * Determine whether a goal is simple enough to skip coordinator decomposition.
 *
 * A goal is considered "simple" when ALL of the following hold:
 *   1. Its length is ≤ {@link SIMPLE_GOAL_MAX_LENGTH}.
 *   2. It does not match any {@link COMPLEXITY_PATTERNS}.
 *
 * The complexity patterns are deliberately conservative — they only fire on
 * imperative coordination directives (e.g. "collaborate with the team",
 * "coordinate the workers"), so descriptive uses ("how do pods coordinate
 * state", "explain microservice collaboration") remain classified as simple.
 *
 * Exported for unit testing.
 */
export function isSimpleGoal(goal: string): boolean {
  if (goal.length > SIMPLE_GOAL_MAX_LENGTH) return false
  return !COMPLEXITY_PATTERNS.some((re) => re.test(goal))
}

/**
 * Select the best-matching agent for a goal using keyword affinity scoring.
 *
 * The scoring logic mirrors {@link Scheduler}'s `capability-match` strategy
 * exactly, including its asymmetric use of the agent's `model` field:
 *
 *  - `agentKeywords` is computed from `name + systemPrompt + model` so that
 *    a goal which mentions a model name (e.g. "haiku") can boost an agent
 *    bound to that model.
 *  - `agentText` (used for the reverse direction) is computed from
 *    `name + systemPrompt` only — model names should not bias the
 *    text-vs-goal-keywords match.
 *
 * The two-direction sum (`scoreA + scoreB`) ensures both "agent describes
 * goal" and "goal mentions agent capability" contribute to the final score.
 *
 * Exported for unit testing.
 */
export function selectBestAgent(goal: string, agents: AgentConfig[]): AgentConfig {
  if (agents.length <= 1) return agents[0]!

  const goalKeywords = extractKeywords(goal)

  let bestAgent = agents[0]!
  let bestScore = -1

  for (const agent of agents) {
    const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
    // Mirror Scheduler.capability-match: include `model` here only.
    const agentKeywords = extractKeywords(`${agent.name} ${agent.systemPrompt ?? ''} ${agent.model}`)

    const scoreA = keywordScore(agentText, goalKeywords)
    const scoreB = keywordScore(goal, agentKeywords)
    const score = scoreA + scoreB

    if (score > bestScore) {
      bestScore = score
      bestAgent = agent
    }
  }

  return bestAgent
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function resolveTokenBudget(primary?: number, fallback?: number): number | undefined {
  if (primary === undefined) return fallback
  if (fallback === undefined) return primary
  return Math.min(primary, fallback)
}

/**
 * Build a minimal {@link Agent} with its own fresh registry/executor.
 * Pool workers pass `includeDelegateTool` so `delegate_to_agent` is available during `runTeam` / `runTasks`.
 */
function buildAgent(
  config: AgentConfig,
  toolRegistration?: { readonly includeDelegateTool?: boolean },
): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry, toolRegistration)
  if (config.customTools) {
    for (const tool of config.customTools) {
      registry.register(tool, { runtimeAdded: true })
    }
  }
  const executor = new ToolExecutor(registry, {
    ...(config.maxToolOutputChars !== undefined
      ? { maxToolOutputChars: config.maxToolOutputChars }
      : {}),
  })
  return new Agent(config, registry, executor)
}

/** Promise-based delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Maximum delay cap to prevent runaway exponential backoff (30 seconds). */
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Compute the retry delay for a given attempt, capped at {@link MAX_RETRY_DELAY_MS}.
 */
export function computeRetryDelay(
  baseDelay: number,
  backoff: number,
  attempt: number,
): number {
  return Math.min(baseDelay * backoff ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/**
 * 带【可选重试 + 指数退避】执行智能体任务
 * 保证任务在临时故障（网络波动、LLM限流、超时）时自动重试
 *
 * 为可测试性而导出 —— 内部由 executeQueue 调用
 *
 * @param run      - 执行任务的函数（通常是 pool.run）
 * @param task     - 要执行的任务（重试配置从任务字段读取）
 * @param onRetry  - 每次重试前调用，上报事件数据
 * @param delayFn  - 可注入的延迟函数（默认真实睡眠，测试可替换）
 * @returns 最后一次尝试的 AgentRunResult
 */
export async function executeWithRetry(
  run: () => Promise<AgentRunResult>,
  task: Task,
  onRetry?: (data: { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }) => void,
  delayFn: (ms: number) => Promise<void> = sleep,
): Promise<AgentRunResult> {

  // ==================== 1. 解析重试配置 ====================
  // 最大重试次数（任务配置，默认 0 次 = 不重试）
  const rawRetries = Number.isFinite(task.maxRetries) ? task.maxRetries! : 0
  // 总尝试次数 = 重试次数 + 1（第一次执行）
  const maxAttempts = Math.max(0, rawRetries) + 1

  // 基础重试延迟（默认 1000ms）
  const baseDelay = Math.max(0, Number.isFinite(task.retryDelayMs) ? task.retryDelayMs! : 1000)
  // 指数退避系数（默认 2 倍，延迟指数级增长）
  const backoff = Math.max(1, Number.isFinite(task.retryBackoff) ? task.retryBackoff! : 2)

  // 存储最后一次错误信息
  let lastError: string = ''
  // 累计所有尝试的 Token 消耗（保证计费/监控显示真实成本）
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  // ==================== 2. 重试循环 ====================
  // 尝试最多 maxAttempts 次
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 执行任务
      const result = await run()

      // 累计 Token（重试的所有消耗都算进去）
      totalUsage = {
        input_tokens: totalUsage.input_tokens + result.tokenUsage.input_tokens,
        output_tokens: totalUsage.output_tokens + result.tokenUsage.output_tokens,
      }

      // ==================== 成功：直接返回 ====================
      if (result.success) {
        return { ...result, tokenUsage: totalUsage }
      }

      // ==================== 业务失败（LLM返回失败） ====================
      lastError = result.output

      // 如果还有重试机会 → 等待后重试
      if (attempt < maxAttempts) {
        // 计算下一次延迟：指数退避
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        // 触发重试回调
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        // 等待
        await delayFn(delay)
        continue
      }

      // 重试次数用完 → 返回最终失败结果
      return { ...result, tokenUsage: totalUsage }
    }

    // ==================== 异常失败（抛错：网络、超时、崩溃） ====================
    catch (err) {
      lastError = err instanceof Error ? err.message : String(err)

      // 还有重试机会
      if (attempt < maxAttempts) {
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        await delayFn(delay)
        continue
      }

      // 全部重试失败 → 返回标准化失败结果
      return {
        success: false,
        output: lastError,
        messages: [],
        tokenUsage: totalUsage,
        toolCalls: [],
      }
    }
  }

  // 理论上不会走到这里，TypeScript 需要返回值
  return {
    success: false,
    output: lastError,
    messages: [],
    tokenUsage: totalUsage,
    toolCalls: [],
  }
}

// ---------------------------------------------------------------------------
// Parsed task spec (result of coordinator decomposition)
// ---------------------------------------------------------------------------

interface ParsedTaskSpec {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}

/**
 * 从协调者原始输出中，尝试提取【任务规格JSON数组】
 * 设计兼容两种输出格式：
 * 1. 标准格式：```json 代码块包裹的JSON数组（提示词强制要求的格式）
 * 2. 降级格式：纯文本中的裸JSON数组
 * 无法提取有效数组时，返回 null
 * 
 * @param raw 协调者原始输出文本
 * @returns 合法的 ParsedTaskSpec 数组 / null
 */
function parseTaskSpecs(raw: string): ParsedTaskSpec[] | null {
  // ==================== 第一步：提取JSON内容（双层策略，保证鲁棒性） ====================
  // 策略1：正则匹配 ```json ... ``` 代码块，提取内部纯JSON内容（优先使用）
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/)
  // 匹配到代码块 → 用代码块内的内容；没匹配到 → 直接用原始文本
  const candidate = fenceMatch ? fenceMatch[1]! : raw

  // 策略2：定位数组边界，找到第一个 [ 和最后一个 ]
  // 作用：过滤LLM输出的多余文字，只保留数组部分
  const arrayStart = candidate.indexOf('[')
  const arrayEnd = candidate.lastIndexOf(']')
  // 边界校验：找不到开头/结尾，或结尾在开头前面 → 无效，直接返回null
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    return null
  }

  // 截取从 [ 到 ] 的完整字符串（包含两端），得到纯JSON数组片段
  const jsonSlice = candidate.slice(arrayStart, arrayEnd + 1)

  // ==================== 第二步：解析并校验JSON（类型安全，防止崩溃） ====================
  try {
    // 解析JSON
    const parsed: unknown = JSON.parse(jsonSlice)
    // 必须是数组，否则无效
    if (!Array.isArray(parsed)) return null

    // 初始化合法任务数组
    const specs: ParsedTaskSpec[] = []
    // 遍历数组中的每一个元素，逐一项校验
    for (const item of parsed) {
      // 过滤：非对象 / null 直接跳过
      if (typeof item !== 'object' || item === null) continue
      const obj = item as Record<string, unknown>

      // 【必填字段强校验】title 和 description 必须是字符串，不满足则跳过该任务
      if (typeof obj['title'] !== 'string') continue
      if (typeof obj['description'] !== 'string') continue

      // 【可选字段弱校验】只保留合法类型的值，非法值设为undefined
      specs.push({
        title: obj['title'], // 必填，已校验
        description: obj['description'], // 必填，已校验
        // 经办人：仅字符串有效
        assignee: typeof obj['assignee'] === 'string' ? obj['assignee'] : undefined,
        // 依赖列表：仅保留字符串类型的依赖项
        dependsOn: Array.isArray(obj['dependsOn'])
          ? (obj['dependsOn'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
        // 内存作用域：仅 'all' 合法
        memoryScope: obj['memoryScope'] === 'all' ? 'all' : undefined,
        // 重试配置：仅数字有效
        maxRetries: typeof obj['maxRetries'] === 'number' ? obj['maxRetries'] : undefined,
        retryDelayMs: typeof obj['retryDelayMs'] === 'number' ? obj['retryDelayMs'] : undefined,
        retryBackoff: typeof obj['retryBackoff'] === 'number' ? obj['retryBackoff'] : undefined,
      })
    }

    // 有合法任务则返回，无则返回null
    return specs.length > 0 ? specs : null
  } catch {
    // JSON解析失败（格式错误）→ 返回null
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestration loop
// ---------------------------------------------------------------------------

/**
 * Team-level context optionally injected into every worker prompt when
 * `RunTeamOptions.revealCoordinator` is true.
 */
interface RevealCoordinatorContext {
  readonly goal: string
  readonly rosterNames: readonly string[]
}

function buildRevealCoordinatorLines(
  revealContext: RevealCoordinatorContext,
  assignee: string,
): string[] {
  return [
    '## Team context',
    `Goal: ${revealContext.goal}`,
    `Team: ${revealContext.rosterNames.join(', ')}`,
    `Your role in this team: ${assignee}`,
    'Assignment: You are responsible for the prompt below in this team run.',
    '',
  ]
}

function prependRevealCoordinatorContext(
  prompt: string,
  revealContext: RevealCoordinatorContext | undefined,
  assignee: string,
): string {
  return revealContext
    ? [...buildRevealCoordinatorLines(revealContext, assignee), prompt].join('\n')
    : prompt
}

/**
 * Internal execution context assembled once per `runTeam` / `runTasks` call.
 */
interface RunContext {
  readonly team: Team
  readonly pool: AgentPool
  readonly scheduler: Scheduler
  readonly agentResults: Map<string, AgentRunResult>
  readonly config: OrchestratorConfig
  /** Trace run ID, present when `onTrace` is configured. */
  readonly runId?: string
  /** AbortSignal for run-level cancellation. Checked between task dispatch rounds. */
  readonly abortSignal?: AbortSignal
  cumulativeUsage: TokenUsage
  readonly maxTokenBudget?: number
  budgetExceededTriggered: boolean
  budgetExceededReason?: string
  readonly taskMetrics: Map<string, TaskExecutionMetrics>
  /**
   * Present only when `runTeam` is called with `{ revealCoordinator: true }`.
   * `runTasks` omits this entirely (no goal concept).
   */
  readonly revealCoordinatorContext?: RevealCoordinatorContext
}

/**
 * Build {@link TeamInfo} for tool context, including nested `runDelegatedAgent`
 * that respects pool capacity to avoid semaphore deadlocks.
 *
 * Delegation always builds a **fresh** Agent instance for the target and runs
 * it via `pool.runEphemeral` — the pool semaphore still gates total concurrency,
 * but the per-agent lock is bypassed. This matches `delegate_to_agent`'s "runs
 * in a fresh conversation for this prompt only" contract and prevents mutual
 * delegation (A→B while B→A) from deadlocking on each other's agent locks.
 * 
 * 为工具上下文构建 TeamInfo 对象（核心：委派任务能力）
 * 包含嵌套的 runDelegatedAgent 方法，严格遵守并发池限制，**避免信号量死锁**
 *
 * 委派机制核心设计：
 * 1. 每次委派都会为目标Agent创建**全新实例**
 * 2. 通过 pool.runEphemeral 执行
 * 3. 全局并发信号量依然限制总并发数
 * 4. **绕过单个Agent的独占锁**
 *
 * 解决痛点：
 * 防止 A 委派 B、B 同时委派 A 时，因为互相等待对方的锁而导致【死锁】
 */
function buildTaskAgentTeamInfo(
  ctx: RunContext,               // 全局执行上下文
  taskId: string,                // 当前任务ID
  traceBase: Partial<RunOptions>,// 基础追踪配置
  delegationDepth: number,       // 当前委派深度（A→B 是1，B→C 是2）
  delegationChain: readonly string[], // 委派链路（如 [A, B, C]）
): TeamInfo {
  const sharedMem = ctx.team.getSharedMemoryInstance()
  const maxDepth = ctx.config.maxDelegationDepth // 最大委派深度（防止无限递归）
  const agentConfigs = ctx.team.getAgents()       // 团队所有智能体配置
  const agentNames = agentConfigs.map((a) => a.name)

  // ==================== 核心：委派执行函数（给工具 delegate_to_agent 调用） ====================
  const runDelegatedAgent = async (targetAgent: string, prompt: string): Promise<AgentRunResult> => {
    const pool = ctx.pool

    // 【死锁防护1】检查是否有空闲并发槽位，没有则直接拒绝，防止死锁
    if (pool.availableRunSlots < 1) {
      return {
        success: false,
        output: 'Agent池无空闲并发槽位，委派任务可能导致死锁，请增大 maxConcurrency',
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    // 校验目标Agent是否存在于团队
    const targetConfig = agentConfigs.find((a) => a.name === targetAgent)
    if (!targetConfig) {
      return {
        success: false,
        output: `未知智能体 "${targetAgent}"`,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    // 构建【临时一次性Agent】，继承全局默认配置
    const effective: AgentConfig = {
      ...targetConfig,
      provider: targetConfig.provider ?? ctx.config.defaultProvider,
      baseURL: targetConfig.baseURL ?? ctx.config.defaultBaseURL,
      apiKey: targetConfig.apiKey ?? ctx.config.defaultApiKey,
    }
    // 创建临时Agent，包含委派工具
    const tempAgent = buildAgent(effective, { includeDelegateTool: true })

    // 【递归】构建下一级委派上下文（深度+1，链路追加）
    const nestedTeam = buildTaskAgentTeamInfo(
      ctx,
      taskId,
      traceBase,
      delegationDepth + 1,
      [...delegationChain, targetAgent],
    )

    const childOpts: Partial<RunOptions> = {
      ...traceBase,
      traceAgent: targetAgent,
      taskId,
      team: nestedTeam, // 注入嵌套团队信息，支持多级委派
    }

    // ==================== 关键：用 runEphemeral 执行 ====================
    // runEphemeral = 临时执行
    // 特点：走全局并发信号量，但**绕过单个Agent的独占锁**
    // 作用：防止 A→B、B→A 互相锁死
    return pool.runEphemeral(
      tempAgent,
      prependRevealCoordinatorContext(prompt, ctx.revealCoordinatorContext, targetAgent),
      childOpts,
    )
  }

  // 返回给 Agent 工具使用的团队信息
  return {
    name: ctx.team.name,
    agents: agentNames,             // 团队成员列表
    ...(sharedMem ? { sharedMemory: sharedMem.getStore() } : {}), // 共享内存
    delegationDepth,                // 当前深度
    maxDelegationDepth: maxDepth,   // 最大深度
    delegationPool: ctx.pool,       // 并发池
    delegationChain,                // 委派链路
    runDelegatedAgent,              // 【核心能力】委派执行函数
  }
}

/**
 * 执行任务队列中的所有任务
 * 遵循依赖关系，无依赖的独立任务自动并行执行
 *
 * 编排循环（轮次机制）：
 *  1. 找出所有依赖已满足、状态为 pending 的任务
 *  2. 通过 Agent 池并行派发这些任务
 *  3. 任务完成后，队列自动解锁其下游依赖任务
 *  4. 循环直到没有可执行任务，或剩余任务全部失败/阻塞
 */
async function executeQueue(
  queue: TaskQueue,    // 任务队列（DAG结构）
  ctx: RunContext,     // 全局执行上下文（池、配置、统计、信号）
): Promise<void> {
  const { team, pool, scheduler, config } = ctx

  // 监听队列的任务跳过事件，转发给外层进度回调
  const unsubSkipped = config.onProgress
    ? queue.on('task:skipped', (task) => {
        config.onProgress!({
          type: 'task_skipped',
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)
      })
    : undefined

  // ==================== 核心编排循环：一轮一轮执行任务 ====================
  while (true) {
    // 每一轮开始前检查：是否被外部中止
    if (ctx.abortSignal?.aborted) {
      queue.skipRemaining('Skipped: run aborted.')
      break
    }

    // 关键：每一轮都重新自动分配未指派的任务（可能上一轮解锁了新任务）
    scheduler.autoAssign(queue, team.getAgents())

    // 获取当前所有【可执行】的任务（依赖已完成，状态 pending）
    const pending = queue.getByStatus('pending')
    // 没有可执行任务 → 退出循环
    if (pending.length === 0) {
      break
    }

    // 记录本轮成功完成的任务，用于审批关卡
    const completedThisRound: Task[] = []

    // ==================== 并行派发本轮所有任务 ====================
    const dispatchPromises = pending.map(async (task): Promise<void> => {
      // 1. 标记任务为执行中
      queue.update(task.id, { status: 'in_progress' as TaskStatus })

      // 2. 检查是否有执行人
      const assignee = task.assignee
      if (!assignee) {
        const msg = `Task "${task.title}" has no assignee.`
        queue.fail(task.id, msg)
        config.onProgress?.({ type: 'error', task: task.id, data: msg })
        return
      }

      // 3. 检查执行人是否存在于 Agent 池
      const agent = pool.get(assignee)
      if (!agent) {
        const msg = `Agent "${assignee}" not found in pool for task "${task.title}".`
        queue.fail(task.id, msg)
        config.onProgress?.({ type: 'error', task: task.id, agent: assignee, data: msg })
        return
      }

      // 触发事件：任务开始 / 智能体开始
      config.onProgress?.({ type: 'task_start', task: task.id, agent: assignee, data: task })
      config.onProgress?.({ type: 'agent_start', agent: assignee, task: task.id, data: task })

      // ==================== 构建任务提示词（核心：注入依赖结果） ====================
      const prompt = await buildTaskPrompt(task, team, queue, ctx.revealCoordinatorContext)

      // 构建运行时选项：追踪、中止信号、团队上下文（用于委派）
      const traceBase: Partial<RunOptions> = {
        ...(config.onTrace ? { onTrace: config.onTrace, runId: ctx.runId ?? '', taskId: task.id, traceAgent: assignee } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      }
      const runOptions: Partial<RunOptions> = {
        ...traceBase,
        team: buildTaskAgentTeamInfo(ctx, task.id, traceBase, 0, [assignee]),
      }

      // ==================== 带重试机制执行任务 ====================
      const taskStartMs = Date.now()
      let retryCount = 0

      const result = await executeWithRetry(
        // 执行逻辑：从并发池运行智能体
        () => pool.run(
          assignee,
          prompt,
          runOptions,
          // 流式输出转发
          config.onAgentStream
            ? (event) => {
                if (config.onTrace) {
                  const streamMs = Date.now()
                  emitTrace(config.onTrace, {
                    type: 'agent_stream',
                    runId: ctx.runId ?? '',
                    taskId: task.id,
                    agent: assignee,
                    streamType: event.type,
                    startMs: streamMs,
                    endMs: streamMs,
                    durationMs: 0,
                  })
                }
                config.onAgentStream!(assignee, event)
              }
            : undefined,
        ),
        task,
        // 重试事件回调
        (retryData) => {
          retryCount++
          config.onProgress?.({
            type: 'task_retry',
            task: task.id,
            agent: assignee,
            data: retryData,
          })
        },
      )

      const taskEndMs = Date.now()

      // 记录任务追踪日志
      if (config.onTrace) {
        emitTrace(config.onTrace, {
          type: 'task',
          runId: ctx.runId ?? '',
          taskId: task.id,
          taskTitle: task.title,
          agent: assignee,
          success: result.success,
          retries: retryCount,
          startMs: taskStartMs,
          endMs: taskEndMs,
          durationMs: taskEndMs - taskStartMs,
        })
      }

      // ==================== 统计：结果、指标、Token 消耗 ====================
      ctx.agentResults.set(`${assignee}:${task.id}`, result)
      ctx.taskMetrics.set(task.id, {
        startMs: taskStartMs,
        endMs: taskEndMs,
        durationMs: Math.max(0, taskEndMs - taskStartMs),
        tokenUsage: result.tokenUsage,
        toolCalls: result.toolCalls,
      })

      // 累计 Token 消耗
      ctx.cumulativeUsage = addUsage(ctx.cumulativeUsage, result.tokenUsage)
      const totalTokens = ctx.cumulativeUsage.input_tokens + ctx.cumulativeUsage.output_tokens

      // 判断是否超出全局 Token 预算
      if (
        !ctx.budgetExceededTriggered
        && ctx.maxTokenBudget !== undefined
        && totalTokens > ctx.maxTokenBudget
      ) {
        ctx.budgetExceededTriggered = true
        const err = new TokenBudgetExceededError('orchestrator', totalTokens, ctx.maxTokenBudget)
        ctx.budgetExceededReason = err.message
        config.onProgress?.({ type: 'budget_exceeded', agent: assignee, task: task.id, data: err })
      }

      // ==================== 任务执行成功 ====================
      if (result.success) {
        // 把结果写入【共享内存】，下游任务可读取
        const sharedMem = team.getSharedMemoryInstance()
        if (sharedMem) {
          await sharedMem.write(assignee, `task:${task.id}:result`, result.output)
          sharedMem.advanceTurn() // 推进回合，用于TTL过期
        }

        // 标记任务完成，并解锁下游任务
        const completedTask = queue.complete(task.id, result.output)
        completedThisRound.push(completedTask)

        // 触发完成事件
        config.onProgress?.({ type: 'task_complete', task: task.id, agent: assignee, data: result })
        config.onProgress?.({ type: 'agent_complete', agent: assignee, task: task.id, data: result })
      }
      // ==================== 任务执行失败 ====================
      else {
        queue.fail(task.id, result.output)
        config.onProgress?.({ type: 'error', task: task.id, agent: assignee, data: result })
      }
    })

    // ==================== 等待本轮所有并行任务执行完毕 ====================
    await Promise.all(dispatchPromises)

    // Token 预算耗尽 → 跳过所有剩余任务
    if (ctx.budgetExceededTriggered) {
      queue.skipRemaining(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
      break
    }

    // ==================== 审批关卡（人在回路） ====================
    // 每批任务完成后，可人工审批是否继续下一轮
    if (config.onApproval && completedThisRound.length > 0) {
      scheduler.autoAssign(queue, team.getAgents())
      const nextPending = queue.getByStatus('pending')

      if (nextPending.length > 0) {
        let approved: boolean
        try {
          // 调用外部审批回调
          approved = await config.onApproval(completedThisRound, nextPending)
        } catch (err) {
          const reason = `Skipped: approval callback error — ${err instanceof Error ? err.message : String(err)}`
          queue.skipRemaining(reason)
          break
        }
        // 审批不通过 → 终止流程
        if (!approved) {
          queue.skipRemaining('Skipped: approval rejected.')
          break
        }
      }
    }
  }

  // 取消队列事件监听
  unsubSkipped?.()
}

/**
 * 为单个任务构建智能体的最终执行提示词
 *
 * 自动注入以下内容（决定了Agent能看到什么信息）：
 *  1. 可选：团队协调上下文（调试用）
 *  2. 任务标题 + 任务描述
 *  3. 默认：只注入【直接依赖任务】的结果（最小必要信息）
 *  4. 可选：如果 memoryScope=all，则注入【全部共享内存】内容
 *  5. 其他成员发给该智能体的团队消息
 */
async function buildTaskPrompt(
  task: Task,                // 当前要执行的任务
  team: Team,                // 团队实例
  queue: TaskQueue,          // 任务队列（用于查依赖任务结果）
  revealContext?: RevealCoordinatorContext, // 是否暴露协调者上下文（调试）
): Promise<string> {
  // 用数组存储提示词片段，最后统一拼接（高效、清晰）
  const lines: string[] = []

  // ==================== 1. 可选：注入调试用的协调者上下文 ====================
  // 仅当开启 revealCoordinator 时才添加，用于让Agent知道全局目标和团队结构
  if (revealContext && task.assignee) {
    lines.push(...buildRevealCoordinatorLines(revealContext, task.assignee))
  }

  // ==================== 2. 核心：注入任务本身信息 ====================
  lines.push(
    `# Task: ${task.title}`,  // 任务标题
    '',
    task.description,         // 任务详细描述
  )

  // ==================== 3. 注入上下文信息（两种模式） ====================
  // 模式A：memoryScope = all → 读取【全部共享内存】（全局可见）
  if (task.memoryScope === 'all') {
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      // 获取共享内存里所有数据的摘要
      const summary = await sharedMem.getSummary()
      if (summary) {
        lines.push('', summary)
      }
    }
  }
  // 模式B：默认模式 → 只读取【直接依赖的前置任务】结果（最小权限、干净）
  else if (task.dependsOn && task.dependsOn.length > 0) {
    const depResults: string[] = []

    // 遍历所有依赖任务ID
    for (const depId of task.dependsOn) {
      const depTask = queue.get(depId)
      // 只把【已完成】的依赖任务结果注入
      if (depTask?.status === 'completed' && depTask.result) {
        depResults.push(`### ${depTask.title} (by ${depTask.assignee ?? 'unknown'})\n${depTask.result}`)
      }
    }

    // 如果有依赖结果，加入提示词
    if (depResults.length > 0) {
      lines.push('', '## Context from prerequisite tasks', '', ...depResults)
    }
  }

  // ==================== 4. 注入团队消息：其他Agent发给当前Agent的消息 ====================
  if (task.assignee) {
    const messages = team.getMessages(task.assignee)
    if (messages.length > 0) {
      lines.push('', '## Messages from team members')
      for (const msg of messages) {
        lines.push(`- **${msg.from}**: ${msg.content}`)
      }
    }
  }

  // 把所有片段用换行拼接，返回最终提示词
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// OpenMultiAgent
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator for the open-multi-agent framework.
 *
 * Manages teams, coordinates task execution, and surfaces progress events.
 * Most users will interact with this class exclusively.
 */
export class OpenMultiAgent {
  private readonly config: Required<
    Omit<OrchestratorConfig, 'onApproval' | 'onAgentStream' | 'onPlanReady' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget'>
  > & Pick<OrchestratorConfig, 'onApproval' | 'onAgentStream' | 'onPlanReady' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget'>

  private readonly teams: Map<string, Team> = new Map()
  private completedTaskCount = 0

  /**
   * @param config - Optional top-level configuration.
   *
   * Sensible defaults:
   *   - `maxConcurrency`: 5
   *   - `maxDelegationDepth`: 3
   *   - `defaultModel`:   `'claude-opus-4-6'`
   *   - `defaultProvider`: `'anthropic'`
   */
  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      maxDelegationDepth: config.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultProvider: config.defaultProvider ?? 'anthropic',
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      maxTokenBudget: config.maxTokenBudget,
      onApproval: config.onApproval,
      onPlanReady: config.onPlanReady,
      onAgentStream: config.onAgentStream,
      onProgress: config.onProgress,
      onTrace: config.onTrace,
    }
  }

  // -------------------------------------------------------------------------
  // Team management
  // -------------------------------------------------------------------------

  /**
   * Create and register a {@link Team} with the orchestrator.
   *
   * The team is stored internally so {@link getStatus} can report aggregate
   * agent counts. Returns the new {@link Team} for further configuration.
   *
   * @param name   - Unique team identifier. Throws if already registered.
   * @param config - Team configuration (agents, shared memory, concurrency).
   */
  createTeam(name: string, config: TeamConfig): Team {
    if (this.teams.has(name)) {
      throw new Error(
        `OpenMultiAgent: a team named "${name}" already exists. ` +
        `Use a unique name or call shutdown() to clear all teams.`,
      )
    }
    const team = new Team(config)
    this.teams.set(name, team)
    return team
  }

  // -------------------------------------------------------------------------
  // Single-agent convenience
  // -------------------------------------------------------------------------

  /**
   * Run a single prompt with a one-off agent.
   *
   * Constructs a fresh agent from `config`, runs `prompt` in a single turn,
   * and returns the result. The agent is not registered with any pool or team.
   *
   * Useful for simple one-shot queries that do not need team orchestration.
   *
   * @param config - Agent configuration.
   * @param prompt - The user prompt to send.
   */
  async runAgent(
    config: AgentConfig,
    prompt: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<AgentRunResult> {
    const effectiveBudget = resolveTokenBudget(config.maxTokenBudget, this.config.maxTokenBudget)
    const effective: AgentConfig = {
      ...config,
      provider: config.provider ?? this.config.defaultProvider,
      baseURL: config.baseURL ?? this.config.defaultBaseURL,
      apiKey: config.apiKey ?? this.config.defaultApiKey,
      maxTokenBudget: effectiveBudget,
    }
    const agent = buildAgent(effective)
    this.config.onProgress?.({
      type: 'agent_start',
      agent: config.name,
      data: { prompt },
    })

    // Build run-time options: trace + optional abort signal. RunOptions has
    // readonly fields, so we assemble the literal in one shot.
    const traceFields = this.config.onTrace
      ? {
          onTrace: this.config.onTrace,
          runId: generateRunId(),
          traceAgent: config.name,
        }
      : null
    const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
    const runOptions: Partial<RunOptions> | undefined =
      traceFields || abortFields
        ? { ...(traceFields ?? {}), ...(abortFields ?? {}) }
        : undefined

    const result = await agent.run(prompt, runOptions)

    if (result.budgetExceeded) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: config.name,
        data: new TokenBudgetExceededError(
          config.name,
          result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
          effectiveBudget ?? 0,
        ),
      })
    }

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: config.name,
      data: result,
    })

    if (result.success) {
      this.completedTaskCount++
    }

    return result
  }

  // -------------------------------------------------------------------------
  // 自动编排团队执行（框架核心杀手特性）
  // -------------------------------------------------------------------------

  /**
   * 基于高层级目标，全自动编排执行一个智能体团队
   * 
   * 这是整个框架的旗舰方法，执行流程如下：
   * 1. 临时创建一个「协调者（coordinator）」智能体，接收目标和团队成员列表，将目标拆解为结构化JSON任务列表
   * 2. 任务加载到 TaskQueue 中，将基于标题的依赖引用解析为真实任务ID，构建依赖图
   * 3. 调度器（Scheduler）将未分配的任务自动分配给团队中的智能体
   * 4. 任务按依赖关系执行，无依赖的任务根据 maxConcurrency 并行执行
   * 5. 每个任务执行完成后，结果持久化到共享内存，供后续智能体读取
   * 6. 协调者根据所有任务的输出，合成最终答案
   * 7. 返回标准化的团队执行结果（TeamRunResult）
   *
   * @param team - 通过 createTeam 或 new Team() 创建的智能体团队
   * @param goal - 面向团队的自然语言高层级目标
   * @param options - 执行选项
   */
  async runTeam(
    team: Team,
    goal: string,
    options?: RunTeamOptions,
  ): Promise<TeamRunResult> {
    // 获取团队中所有智能体的配置信息
    const agentConfigs = team.getAgents()
    // 获取用户传入的协调者配置覆盖项
    const coordinatorOverrides = options?.coordinator

    // ------------------------------------------------------------------
    // 短路径优化：简单目标跳过协调者，直接执行
    // 
    // 设计意图：当目标简短、无多步骤/协调需求时，直接派发给单个智能体执行
    // 比启动协调者拆解+汇总更快速、更省Token
    // 最优智能体通过「关键词亲和度算法」匹配（与调度器capability-match策略一致）
    // ------------------------------------------------------------------
    // 非仅生成计划 + 团队有智能体 + 目标是简单目标 → 执行短路径
    if (!options?.planOnly && agentConfigs.length > 0 && isSimpleGoal(goal)) {
      // 选择最匹配当前目标的智能体
      const bestAgent = selectBestAgent(goal, agentConfigs)

      // 直接使用 buildAgent() + agent.run()，而非 this.runAgent()
      // 目的：避免重复的进度事件、重复的任务计数，事件在此处手动触发
      // 解析最终生效的Token预算（取智能体自身和全局配置的最小值）
      const effectiveBudget = resolveTokenBudget(bestAgent.maxTokenBudget, this.config.maxTokenBudget)
      // 构建最终生效的智能体配置（合并全局默认配置）
      const effective: AgentConfig = {
        ...bestAgent,
        provider: bestAgent.provider ?? this.config.defaultProvider,
        baseURL: bestAgent.baseURL ?? this.config.defaultBaseURL,
        apiKey: bestAgent.apiKey ?? this.config.defaultApiKey,
        maxTokenBudget: effectiveBudget,
      }
      // 创建智能体实例
      const agent = buildAgent(effective)

      // 触发进度事件：智能体启动（短路径模式）
      this.config.onProgress?.({
        type: 'agent_start',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', goal },
      })

      // 构建追踪配置：如果开启追踪，生成运行ID
      const traceFields = this.config.onTrace
        ? { onTrace: this.config.onTrace, runId: generateRunId(), traceAgent: bestAgent.name }
        : null
      // 构建中止信号配置
      const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
      // 合并运行选项
      const runOptions: Partial<RunOptions> | undefined =
        traceFields || abortFields
          ? { ...(traceFields ?? {}), ...(abortFields ?? {}) }
          : undefined

      // 记录执行开始时间
      const scStartMs = Date.now()
      // 执行智能体（一次性执行，无历史对话）
      const result = await agent.run(goal, runOptions)
      // 记录执行结束时间
      const scEndMs = Date.now()

      // 如果触发Token预算超限，触发对应进度事件
      if (result.budgetExceeded) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: bestAgent.name,
          data: new TokenBudgetExceededError(
            bestAgent.name,
            result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
            effectiveBudget ?? 0,
          ),
        })
      }

      // 触发进度事件：智能体执行完成
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', result },
      })

      // 存储智能体执行结果
      const agentResults = new Map<string, AgentRunResult>()
      agentResults.set(bestAgent.name, result)

      // 构造短路径模式的任务执行记录
      const tasks: readonly TaskExecutionRecord[] = [{
        id: 'short-circuit',
        title: `Short-circuit: ${bestAgent.name}`,
        assignee: bestAgent.name,
        status: result.success ? 'completed' : 'failed',
        dependsOn: [],
        metrics: {
          startMs: scStartMs,
          endMs: scEndMs,
          durationMs: Math.max(0, scEndMs - scStartMs),
          tokenUsage: result.tokenUsage,
          toolCalls: result.toolCalls,
        },
      }]
      // 构建并返回最终结果
      return this.buildTeamRunResult(agentResults, goal, tasks)
    }

    // ------------------------------------------------------------------
    // 步骤1：协调者智能体 将目标拆解为子任务
    // ------------------------------------------------------------------
    // 构建协调者智能体配置（合并用户覆盖配置 + 全局默认配置）
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      model: coordinatorOverrides?.model ?? this.config.defaultModel,
      ...(coordinatorOverrides?.adapter !== undefined ? { adapter: coordinatorOverrides.adapter } : {}),
      provider: coordinatorOverrides?.provider ?? this.config.defaultProvider,
      baseURL: coordinatorOverrides?.baseURL ?? this.config.defaultBaseURL,
      apiKey: coordinatorOverrides?.apiKey ?? this.config.defaultApiKey,
      // 构建协调者系统提示词（包含团队成员信息、任务规则）
      systemPrompt: this.buildCoordinatorPrompt(agentConfigs, coordinatorOverrides),
      maxTurns: coordinatorOverrides?.maxTurns ?? 3,
      maxTokens: coordinatorOverrides?.maxTokens,
      temperature: coordinatorOverrides?.temperature,
      topP: coordinatorOverrides?.topP,
      topK: coordinatorOverrides?.topK,
      minP: coordinatorOverrides?.minP,
      parallelToolCalls: coordinatorOverrides?.parallelToolCalls,
      frequencyPenalty: coordinatorOverrides?.frequencyPenalty,
      presencePenalty: coordinatorOverrides?.presencePenalty,
      extraBody: coordinatorOverrides?.extraBody,
      toolPreset: coordinatorOverrides?.toolPreset,
      tools: coordinatorOverrides?.tools,
      disallowedTools: coordinatorOverrides?.disallowedTools,
      loopDetection: coordinatorOverrides?.loopDetection,
      timeoutMs: coordinatorOverrides?.timeoutMs,
    }

    // 构建「目标拆解」提示词，让协调者输出结构化任务
    const decompositionPrompt = this.buildDecompositionPrompt(goal, agentConfigs)
    // 创建协调者智能体实例
    const coordinatorAgent = buildAgent(coordinatorConfig)
    // 生成追踪ID（如果开启追踪）
    const runId = this.config.onTrace ? generateRunId() : undefined

    // 触发进度事件：协调者启动（任务分解阶段）
    this.config.onProgress?.({
      type: 'agent_start',
      agent: 'coordinator',
      data: { phase: 'decomposition', goal },
    })

    // 构建拆解任务的运行选项（追踪 + 中止信号）
    const decompTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator', abortSignal: options?.abortSignal }
      : options?.abortSignal ? { abortSignal: options.abortSignal } : undefined
    // 执行协调者：拆解目标为任务
    const decompositionResult = await coordinatorAgent.run(decompositionPrompt, decompTraceOptions)
    // 存储协调者的拆解结果
    const agentResults = new Map<string, AgentRunResult>()
    agentResults.set('coordinator:decompose', decompositionResult)
    
    // 初始化全局Token预算统计
    const maxTokenBudget = this.config.maxTokenBudget
    let cumulativeUsage = addUsage(ZERO_USAGE, decompositionResult.tokenUsage)

    // 检查：全局Token预算是否超限
    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: 'coordinator',
        data: new TokenBudgetExceededError(
          'coordinator',
          cumulativeUsage.input_tokens + cumulativeUsage.output_tokens,
          maxTokenBudget,
        ),
      })
      // 预算超限，直接返回结果
      return this.buildTeamRunResult(agentResults, goal, [])
    }

    // ------------------------------------------------------------------
    // 步骤2：解析协调者输出的结构化任务
    // ------------------------------------------------------------------
    // 从协调者的输出中解析任务规格（JSON数组）
    const taskSpecs = parseTaskSpecs(decompositionResult.output)

    // 初始化任务队列、调度器、任务指标存储
    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')
    const taskMetrics = new Map<string, TaskExecutionMetrics>()

    // 如果解析到有效任务 → 加载到任务队列
    if (taskSpecs && taskSpecs.length > 0) {
      // 将任务规格加载到队列：自动将「任务标题依赖」解析为真实任务ID，构建依赖图
      this.loadSpecsIntoQueue(taskSpecs, agentConfigs, queue)
    } else {
      // 降级方案：协调者未输出有效结构化任务 → 为每个智能体创建一个默认任务
      for (const agentConfig of agentConfigs) {
        const task = createTask({
          title: `${agentConfig.name}: ${goal.slice(0, 80)}`,
          description: goal,
          assignee: agentConfig.name,
        })
        queue.add(task)
      }
    }

    // ------------------------------------------------------------------
    // 步骤3：自动分配未指派的任务
    // ------------------------------------------------------------------
    // 调度器自动为无执行人的任务分配最合适的智能体
    scheduler.autoAssign(queue, agentConfigs)

    // ------------------------------------------------------------------
    // 步骤4：构建智能体池，执行任务队列
    // ------------------------------------------------------------------
    // 构建智能体并发池（控制并发数、防止死锁）
    const pool = this.buildPool(agentConfigs)
    // 构建执行上下文：贯穿整个编排流程的共享数据
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId,
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      maxTokenBudget,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics,
      // 可选：是否暴露协调者上下文（用于调试/可视化）
      ...(options?.revealCoordinator
        ? {
            revealCoordinatorContext: {
              goal,
              rosterNames: agentConfigs.map((a) => a.name),
            },
          }
        : {}),
    }

    // 获取生成的任务计划
    const planTasks = queue.list()
    const planReadyStartMs = Date.now()
    let approved = true

    // 钩子：任务计划已生成，等待用户/系统审核（人在回路）
    if (this.config.onPlanReady) {
      try {
        approved = await this.config.onPlanReady(planTasks)
      } catch {
        approved = false
      }
    }

    // 触发追踪事件：计划就绪
    if (this.config.onTrace) {
      const planReadyEndMs = Date.now()
      emitTrace(this.config.onTrace, {
        type: 'plan_ready',
        runId: runId ?? '',
        agent: 'coordinator',
        taskCount: planTasks.length,
        approved,
        startMs: planReadyStartMs,
        endMs: planReadyEndMs,
        durationMs: planReadyEndMs - planReadyStartMs,
      })
    }

    // 审核不通过 → 直接返回失败结果
    if (!approved) {
      return { ...this.buildTeamRunResult(agentResults, goal, []), success: false }
    }

    // 选项：仅生成任务计划，不执行 → 返回计划结果
    if (options?.planOnly) {
      const planOnlyTasks: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
        id: task.id,
        title: task.title,
        assignee: task.assignee,
        status: task.status,
        dependsOn: task.dependsOn ?? [],
        metrics: undefined,
      }))
      // 触发协调者完成事件
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: 'coordinator',
        data: decompositionResult,
      })
      return {
        ...this.buildTeamRunResult(agentResults, goal, planOnlyTasks),
        planOnly: true,
      }
    }

    // 核心：执行任务队列（按DAG依赖、并行调度、异常重试、预算控制）
    await executeQueue(queue, ctx)
    // 更新累计Token消耗
    cumulativeUsage = ctx.cumulativeUsage
    // 转换任务队列数据为标准化执行记录
    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      metrics: taskMetrics.get(task.id),
    }))

    // ------------------------------------------------------------------
    // 步骤5：协调者智能体 汇总所有任务结果，生成最终答案
    // ------------------------------------------------------------------
    // 预算已超限 → 跳过汇总，直接返回结果
    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      return this.buildTeamRunResult(agentResults, goal, taskRecords)
    }

    // 构建「结果汇总」提示词（包含目标、所有任务执行结果）
    const synthesisPrompt = await this.buildSynthesisPrompt(goal, queue.list(), team)
    // 构建汇总阶段的运行选项
    const synthTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator' }
      : undefined
    // 执行协调者：汇总结果
    const synthesisResult = await coordinatorAgent.run(synthesisPrompt, synthTraceOptions)
    // 存储汇总结果
    agentResults.set('coordinator', synthesisResult)
    // 累计汇总阶段的Token消耗
    cumulativeUsage = addUsage(cumulativeUsage, synthesisResult.tokenUsage)

    // 检查汇总后是否超限
    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: 'coordinator',
        data: new TokenBudgetExceededError(
          'coordinator',
          cumulativeUsage.input_tokens + cumulativeUsage.output_tokens,
          maxTokenBudget,
        ),
      })
    }

    // 触发进度事件：协调者汇总完成
    this.config.onProgress?.({
      type: 'agent_complete',
      agent: 'coordinator',
      data: synthesisResult,
    })

    // 说明：协调者的拆解/汇总是内部元步骤，不计入用户任务计数
    // 最终结果统计仅包含实际业务任务

    // 构建并返回最终的团队执行结果
    return this.buildTeamRunResult(agentResults, goal, taskRecords)
  }

  // -------------------------------------------------------------------------
  // Explicit-task team run
  // -------------------------------------------------------------------------

  /**
   * Run a team with an explicitly provided task list.
   *
   * Simpler than {@link runTeam}: no coordinator agent is involved. Tasks are
   * loaded directly into the queue, unassigned tasks are auto-assigned via the
   * {@link Scheduler}, and execution proceeds in dependency order.
   *
   * @param team  - A team created via {@link createTeam}.
   * @param tasks - Array of task descriptors.
   */
  async runTasks(
    team: Team,
    tasks: ReadonlyArray<{
      title: string
      description: string
      assignee?: string
      dependsOn?: string[]
      memoryScope?: 'dependencies' | 'all'
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()
    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')

    this.loadSpecsIntoQueue(
      tasks.map((t) => ({
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        dependsOn: t.dependsOn,
        memoryScope: t.memoryScope,
        maxRetries: t.maxRetries,
        retryDelayMs: t.retryDelayMs,
        retryBackoff: t.retryBackoff,
      })),
      agentConfigs,
      queue,
    )

    scheduler.autoAssign(queue, agentConfigs)

    const pool = this.buildPool(agentConfigs)
    const agentResults = new Map<string, AgentRunResult>()
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId: this.config.onTrace ? generateRunId() : undefined,
      abortSignal: options?.abortSignal,
      cumulativeUsage: ZERO_USAGE,
      maxTokenBudget: this.config.maxTokenBudget,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics: new Map<string, TaskExecutionMetrics>(),
    }

    await executeQueue(queue, ctx)

    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      metrics: ctx.taskMetrics.get(task.id),
    }))

    return this.buildTeamRunResult(agentResults, undefined, taskRecords)
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Returns a lightweight status snapshot.
   *
   * - `teams`          — Number of teams registered with this orchestrator.
   * - `activeAgents`   — Total agents currently in `running` state.
   * - `completedTasks` — Cumulative count of successfully completed tasks
   *                      (coordinator meta-steps excluded).
   */
  getStatus(): { teams: number; activeAgents: number; completedTasks: number } {
    return {
      teams: this.teams.size,
      activeAgents: 0, // Pools are ephemeral per-run; no cross-run state to inspect.
      completedTasks: this.completedTaskCount,
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deregister all teams and reset internal counters.
   *
   * Does not cancel in-flight runs. Call this when you want to reuse the
   * orchestrator instance for a fresh set of teams.
   *
   * Async for forward compatibility — shutdown may need to perform async
   * cleanup (e.g. graceful agent drain) in future versions.
   */
  async shutdown(): Promise<void> {
    this.teams.clear()
    this.completedTaskCount = 0
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the system prompt given to the coordinator agent. */
  private buildCoordinatorSystemPrompt(agents: AgentConfig[]): string {
    return [
      'You are a task coordinator responsible for decomposing high-level goals',
      'into concrete, actionable tasks and assigning them to the right team members.',
      '',
      this.buildCoordinatorRosterSection(agents),
      '',
      this.buildCoordinatorOutputFormatSection(),
      '',
      this.buildCoordinatorSynthesisSection(),
    ].join('\n')
  }

  /** Build coordinator system prompt with optional caller overrides. */
  private buildCoordinatorPrompt(agents: AgentConfig[], config?: CoordinatorConfig): string {
    if (config?.systemPrompt) {
      return [
        config.systemPrompt,
        '',
        this.buildCoordinatorRosterSection(agents),
        '',
        this.buildCoordinatorOutputFormatSection(),
        '',
        this.buildCoordinatorSynthesisSection(),
      ].join('\n')
    }

    const base = this.buildCoordinatorSystemPrompt(agents)
    if (!config?.instructions) {
      return base
    }

    return [
      base,
      '',
      '## Additional Instructions',
      config.instructions,
    ].join('\n')
  }

  /**
   * 构建协调者（Coordinator）系统提示词中的【团队成员名册】章节
   * 核心作用：向协调者清晰展示团队所有智能体的核心信息，让其知晓可分配任务的成员
   * @param agents 团队中所有智能体的配置数组
   * @returns 格式化后的 Markdown 格式团队名册文本
   */
  private buildCoordinatorRosterSection(agents: AgentConfig[]): string {
    // 遍历所有智能体配置，生成标准化的成员列表项
    const roster = agents
      .map(
        (a) =>
          // 格式：- **智能体名称** (使用的模型): 智能体能力描述（无描述则默认通用智能体）
          `- **${a.name}** (${a.model}): ${a.systemPrompt ?? 'general purpose agent'}`,
      )
      .join('\n') // 所有成员用换行分隔，拼接为完整列表

    // 返回 Markdown 章节：## 标题 + 成员列表
    return [
      '## Team Roster', // 章节标题：团队名册
      roster,           // 拼接好的智能体成员列表
    ].join('\n')
  }

  /**
   * 构建协调者（Coordinator）系统提示词中的【输出格式 + 依赖规则】章节
   * 核心使命：
   * 1. 严格定义任务JSON的字段格式（和 parseTaskSpecs 解析规则完全对应）
   * 2. 教会LLM如何科学设计任务依赖（保证并行性、节省Token）
   * 3. 强制输出规范，杜绝多余文本，方便代码解析
   */
  private buildCoordinatorOutputFormatSection(): string {
    return [
      '## Output Format',
      // 指令：拆解目标时，只允许返回 任务对象组成的JSON数组
      'When asked to decompose a goal, respond ONLY with a JSON array of task objects.',
      'Each task must have:',
      '  - "title":       Short descriptive title (string)',
      '  - "description": Full task description with context and expected output (string)',
      '  - "assignee":    One of the agent names listed in the roster (string)',
      '  - "dependsOn":   Array of titles of tasks this task depends on (string[], may be empty).',
      '',
      // ==================== 高级：依赖关系设计指导（框架优化关键） ====================
      '## Dependency Guidance',
      // 核心原则：每个智能体只保留**最小必要依赖**，最大化并行执行
      'Prefer the minimum set of upstream tasks each assignee needs. When deciding dependsOn for agent X:',
      // 规则1：以智能体的systemPrompt（能力描述）为第一依据
      '  1. Use X\'s system prompt as the primary signal for what inputs it consumes.',
      // 规则2：只有智能体明确需要该输入时，才添加依赖
      '  2. Lean toward including a task as a dependency only when X\'s system prompt names or describes needing that kind of input.',
      // 规则3：禁止因为「有用」就加依赖，无明确需求则不加
      '  3. Avoid adding a dependency just because the information "would be useful" or matches general best practice; if X\'s system prompt gives no indication it consumes that input, prefer to leave it out.',
      // 规则4：不确定时，少依赖 > 多依赖（额外依赖会降低并行性、浪费Token）
      '  4. When uncertain, prefer fewer dependencies over more — extra parents cost parallelism and tokens.',
      '',

      // ==================== 格式约束：保证解析成功率 ====================
      // 必须用```json代码块包裹JSON
      'Wrap the JSON in a ```json code fence.',
      // 代码块外**禁止任何文字**（彻底杜绝LLM乱加解释）
      'Do not include any text outside the code fence.',
    ].join('\n')
  }

  /**
   * 构建协调者（Coordinator）系统提示词中的【结果汇总指导】章节
   * 核心作用：指导协调者在【所有子任务执行完成后】，如何整合任务结果、生成最终答案
   * 该片段会被拼接进协调者的完整系统提示词，作用于 runTeam 的最后汇总阶段
   */
  private buildCoordinatorSynthesisSection(): string {
    return [
      '## When synthesising results',
      'You will be given completed task outputs and asked to synthesise a final answer.',
      'Write a clear, comprehensive response that addresses the original goal.',
    ].join('\n')
  }

  /**
   * 为协调者（coordinator）构建【目标拆解】专用提示词
   * 核心作用：指令协调者将用户的高层级目标，拆解为团队智能体可执行的子任务
   * 并强制要求输出标准JSON格式，方便后续代码解析
   * @param goal - 用户输入的高层级自然语言目标
   * @param agents - 团队中所有智能体的配置列表
   * @returns 拼接完成的拆解任务提示词字符串
   */
  private buildDecompositionPrompt(goal: string, agents: AgentConfig[]): string {
    // 提取团队所有智能体的名称，拼接为逗号分隔的字符串（如：分析师,开发者,测试员）
    const names = agents.map((a) => a.name).join(', ')
    
    // 拼接最终的提示词（使用数组+换行拼接，结构更清晰）
    return [
      // 核心指令：让协调者为指定团队拆解目标
      `Decompose the following goal into tasks for your team (${names}).`,
      '', // 空行，格式化提示词结构
      `## Goal`, // 标题：标记目标区域
      goal,      // 插入用户的真实目标
      '',
      // 严格格式约束：只允许返回```json代码块包裹的任务数组，无任何额外文本
      'Return ONLY the JSON task array in a ```json code fence.',
    ].join('\n')
  }

  /** Build the synthesis prompt shown to the coordinator after all tasks complete. */
  private async buildSynthesisPrompt(
    goal: string,
    tasks: Task[],
    team: Team,
  ): Promise<string> {
    const completedTasks = tasks.filter((t) => t.status === 'completed')
    const failedTasks = tasks.filter((t) => t.status === 'failed')
    const skippedTasks = tasks.filter((t) => t.status === 'skipped')

    const resultSections = completedTasks.map((t) => {
      const assignee = t.assignee ?? 'unknown'
      return `### ${t.title} (completed by ${assignee})\n${t.result ?? '(no output)'}`
    })

    const failureSections = failedTasks.map(
      (t) => `### ${t.title} (FAILED)\nError: ${t.result ?? 'unknown error'}`,
    )

    const skippedSections = skippedTasks.map(
      (t) => `### ${t.title} (SKIPPED)\nReason: ${t.result ?? 'approval rejected'}`,
    )

    // Also include shared memory summary for additional context
    let memorySummary = ''
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      memorySummary = await sharedMem.getSummary()
    }

    return [
      `## Original Goal`,
      goal,
      '',
      `## Task Results`,
      ...resultSections,
      ...(failureSections.length > 0 ? ['', '## Failed Tasks', ...failureSections] : []),
      ...(skippedSections.length > 0 ? ['', '## Skipped Tasks', ...skippedSections] : []),
      ...(memorySummary ? ['', memorySummary] : []),
      '',
      '## Your Task',
      'Synthesise the above results into a comprehensive final answer that addresses the original goal.',
      'If some tasks failed or were skipped, note any gaps in the result.',
    ].join('\n')
  }

  /**
   * 将任务规格列表加载至任务队列
   *
   * 核心能力：处理基于【任务标题】的依赖引用
   * 实现方案：先构建「任务标题 -> 任务ID」映射表，再将依赖解析为真实ID后加入队列
   * 解决痛点：LLM 只能输出任务标题作为依赖，而系统必须用唯一ID管理任务依赖关系
   */
  private loadSpecsIntoQueue(
    // 任务规格：ParsedTaskSpec 基础上扩展重试、内存作用域等配置
    specs: ReadonlyArray<ParsedTaskSpec & {
      memoryScope?: 'dependencies' | 'all'
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    agentConfigs: AgentConfig[], // 团队所有智能体配置
    queue: TaskQueue, // 目标任务队列
  ): void {
    // 构建智能体名称集合，用于快速校验任务经办人是否为团队有效成员
    const agentNames = new Set(agentConfigs.map((a) => a.name))

    // ==================== 第一轮遍历：仅创建任务，生成唯一ID，构建标题-ID映射 ====================
    // 任务标题（小写格式化）=> 任务唯一ID 的映射表
    const titleToId = new Map<string, string>()
    // 临时存储所有创建好的任务对象（暂不加入队列）
    const createdTasks: Task[] = []

    // 遍历所有任务规格，创建任务实例
    for (const spec of specs) {
      const task = createTask({
        title: spec.title,
        description: spec.description,
        // 经办人校验：仅保留团队内存在的智能体，无效则设为undefined（后续调度器自动分配）
        assignee: spec.assignee && agentNames.has(spec.assignee)
          ? spec.assignee
          : undefined,
        // 透传扩展配置
        memoryScope: spec.memoryScope,
        maxRetries: spec.maxRetries,
        retryDelayMs: spec.retryDelayMs,
        retryBackoff: spec.retryBackoff,
      })

      // 建立标题映射：统一小写+去空格，兼容LLM输出的大小写、空格误差
      titleToId.set(spec.title.toLowerCase().trim(), task.id)
      // 存入临时任务列表
      createdTasks.push(task)
    }

    // ==================== 第二轮遍历：解析依赖，将标题转为真实ID，加入任务队列 ====================
    for (let i = 0; i < createdTasks.length; i++) {
      const spec = specs[i]!       // 原始任务规格
      const task = createdTasks[i]! // 第一轮创建的任务对象

      // 无依赖的任务，直接加入队列，跳过依赖解析
      if (!spec.dependsOn || spec.dependsOn.length === 0) {
        queue.add(task)
        continue
      }

      // 存储解析后的【真实任务ID】依赖列表
      const resolvedDeps: string[] = []
      // 遍历LLM输出的依赖引用（支持任务ID / 任务标题两种格式）
      for (const depRef of spec.dependsOn) {
        // 兼容方案1：直接按【任务ID】查找
        const byId = createdTasks.find((t) => t.id === depRef)
        // 兼容方案2：按【格式化后的任务标题】查找
        const byTitle = titleToId.get(depRef.toLowerCase().trim())
        // 优先取ID匹配，其次取标题匹配的结果
        const resolvedId = byId?.id ?? byTitle

        // 解析成功则加入最终依赖列表
        if (resolvedId) {
          resolvedDeps.push(resolvedId)
        }
      }

      // 合并依赖字段，生成最终任务对象
      const taskWithDeps: Task = {
        ...task,
        dependsOn: resolvedDeps.length > 0 ? resolvedDeps : undefined,
      }

      // 将带完整依赖的任务正式加入队列
      queue.add(taskWithDeps)
    }
  }

  /** Build an {@link AgentPool} from a list of agent configurations. */
  private buildPool(agentConfigs: AgentConfig[]): AgentPool {
    const pool = new AgentPool(this.config.maxConcurrency)
    for (const config of agentConfigs) {
      const effective: AgentConfig = {
        ...config,
        model: config.model,
        provider: config.provider ?? this.config.defaultProvider,
        baseURL: config.baseURL ?? this.config.defaultBaseURL,
        apiKey: config.apiKey ?? this.config.defaultApiKey,
      }
      pool.add(buildAgent(effective, { includeDelegateTool: true }))
    }
    return pool
  }

  /**
   * 将单次运行的「agentResults」聚合为最终的「团队运行结果（TeamRunResult）」
   *
   * 作用：
   * 1. 把格式为 agentName:taskId 的扁平结果，按 agentName 合并
   * 2. 累加所有 Token 消耗
   * 3. 合并输出内容、消息、工具调用
   * 4. 计算整体是否成功
   * 5. 过滤掉协调者（coordinator）的内部执行记录
   *
   * 注意：
   * 只有非协调者的真实任务会计入 completedTaskCount，避免重复统计
   */
  private buildTeamRunResult(
    agentResults: Map<string, AgentRunResult>, // 原始结果：key = agentName:taskId
    goal?: string,                            // 用户原始目标
    tasks?: readonly TaskExecutionRecord[],   // 任务执行记录
  ): TeamRunResult {
    // 总 Token 消耗（初始为0）
    let totalUsage: TokenUsage = ZERO_USAGE
    // 整体是否全部成功
    let overallSuccess = true
    // 合并后的结果：key = agentName，一个Agent只保留一条汇总结果
    const collapsed = new Map<string, AgentRunResult>()

    // 遍历所有执行结果
    for (const [key, result] of agentResults) {
      // ==================== 1. 提取智能体名称 ====================
      // 把 agentName:taskId 切分，只保留 agentName
      const agentName = key.includes(':') ? key.split(':')[0]! : key

      // ==================== 2. 累计统计数据 ====================
      // 累加 Token
      totalUsage = addUsage(totalUsage, result.tokenUsage)
      // 只要有一个失败，整体就是失败
      if (!result.success) overallSuccess = false

      // ==================== 3. 按智能体合并结果 ====================
      const existing = collapsed.get(agentName)
      // 该智能体第一次出现 → 直接保存
      if (!existing) {
        collapsed.set(agentName, result)
      }
      // 该智能体多次执行任务 → 合并结果
      else {
        collapsed.set(agentName, {
          success: existing.success && result.success, // 全部成功才算成功
          output: [existing.output, result.output].filter(Boolean).join('\n\n---\n\n'), // 输出用分隔符拼接
          messages: [...existing.messages, ...result.messages], // 消息合并
          tokenUsage: addUsage(existing.tokenUsage, result.tokenUsage), // Token累加
          toolCalls: [...existing.toolCalls, ...result.toolCalls], // 工具调用合并
          structured: result.structured !== undefined ? result.structured : existing.structured, // 保留最后一次结构化结果
        })
      }

      // ==================== 4. 统计成功完成的任务数（只算真实任务） ====================
      // 成功 + 不是 coordinator 开头 → 才算用户任务
      if (result.success && !key.startsWith('coordinator')) {
        this.completedTaskCount++
      }
    }

    // ==================== 5. 返回最终团队报告 ====================
    return {
      success: overallSuccess,               // 整体是否成功
      goal,                                  // 原始目标
      tasks,                                 // 任务列表
      agentResults: collapsed,               // 每个Agent的汇总结果
      totalTokenUsage: totalUsage,           // 全团队总Token消耗
    }
  }
}
