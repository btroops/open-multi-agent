/**
 * Four-Layer Event Demonstration
 *
 * 展示 open-multi-agent 框架的四个事件层：
 *   1. 编排层事件  — Orchestrator.onProgress
 *   2. Team 层事件  — Team.on()
 *   3. Agent 间事件 — MessageBus (sendMessage / broadcast)
 *   4. 队列事件     — TaskQueue (通过 Team 的事件桥接)
 *
 * 4 个 Agent 协作完成一份技术方案文档：
 *   strategist（架构师）→ researcher（研究员）→ engineer（工程师）→ reviewer（评审员）
 *
 * 每轮完成后，通过 onApproval 给下一个 Agent 发送团队消息（体现 agent 间通信）。
 *
 * Run:
 *   npx tsx examples/cookbook/four-layer-events.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */
import { OpenMultiAgent } from '../../src/index.js'
import { TaskQueue } from '../../src/task/queue.js'
import { createTask } from '../../src/task/task.js'
import type { AgentConfig, OrchestratorEvent, Task } from '../../src/types.js'

// ============================================================================
// 1. Agent 定义
// ============================================================================

const strategist: AgentConfig = {
  name: 'strategist',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是一名技术架构师。你的输出是清晰、简洁的技术设计方案。
关注: 技术选型、模块划分、接口设计。尽量简短，用 markdown。`,
  tools: ['file_write'],
  maxTurns: 4,
  temperature: 0.2,
}

const researcher: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是一名技术研究员。你阅读架构师的方案，然后调研相关开源技术和最佳实践。
输出: 技术选型对比、推荐方案。用 markdown。`,
  tools: ['file_write'],
  maxTurns: 4,
  temperature: 0.3,
}

const engineer: AgentConfig = {
  name: 'engineer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是一名工程师。你根据架构方案和调研结果编写示例代码或配置。
用 markdown 围栏输出代码。关注可读性和正确性。`,
  tools: ['file_write'],
  maxTurns: 6,
  temperature: 0.1,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是一名代码评审员。审阅前面所有输出，给出结构化评审意见。
格式:
- ## 总体评价
- ## 优点
- ## 改进建议
- ## 结论: [通过 / 需修改]`,
  tools: ['file_read'],
  maxTurns: 4,
  temperature: 0.3,
}

// ============================================================================
// 2. 事件收集器（用于最后汇总展示）
// ============================================================================

interface EventRecord {
  layer: 'orchestrator' | 'team' | 'agent-message' | 'queue'
  type: string
  detail: string
  timestamp: number
}

const eventLog: EventRecord[] = []

function log(layer: EventRecord['layer'], type: string, detail: string) {
  const record: EventRecord = { layer, type, detail, timestamp: Date.now() }
  eventLog.push(record)
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] [${layer.padEnd(15)}] ${type.padEnd(24)} ${detail}`)
}

// ============================================================================
// 3. 示意 TaskQueue 的独立事件（不依赖 runTasks）
// ============================================================================

function demonstrateTaskQueueEvents(): void {
  console.log('\n' + '='.repeat(60))
  console.log('【队列事件演示】手动操作 TaskQueue 观察事件')
  console.log('='.repeat(60))

  const queue = new TaskQueue()

  // 订阅队列事件
  queue.on('task:ready', (task) => {
    log('queue', 'task:ready', `"${task.title}" (${task.assignee ?? '未分配'})`)
  })
  queue.on('task:complete', (task) => {
    log('queue', 'task:complete', `"${task.title}" ✅`)
  })
  queue.on('task:failed', (task) => {
    log('queue', 'task:failed', `"${task.title}" ❌`)
  })
  queue.on('task:skipped', (task) => {
    log('queue', 'task:skipped', `"${task.title}" ⏭️`)
  })
  queue.on('all:complete', () => {
    log('queue', 'all:complete', '队列所有任务已结束')
  })

  // 添加两个有依赖关系的任务
  const taskA = createTask({ title: '前置任务', description: '必须先完成' })
  const taskB = createTask({
    title: '后置任务',
    description: '依赖前置任务',
    dependsOn: [taskA.id],
  })

  queue.add(taskA)
  queue.add(taskB) // 应自动变为 blocked，不会触发 task:ready

  // 查看队列状态
  const progress1 = queue.getProgress()
  log('queue', '状态快照', `pending=${progress1.pending} blocked=${progress1.blocked}`)

  // 完成任务 A → 应 unblock 任务 B
  queue.complete(taskA.id, '前置任务结果')
  queue.complete(taskB.id, '后置任务结果')
}

// ============================================================================
// 4. 编排层事件处理器
// ============================================================================

function handleProgress(event: OrchestratorEvent): void {
  switch (event.type) {
    case 'task_start': {
      const task = event.data as Task | undefined
      log('orchestrator', 'task_start', `"${task?.title ?? event.task}" → ${event.agent}`)
      break
    }
    case 'task_complete': {
      const task = event.data as Task | undefined
      log('orchestrator', 'task_complete', `"${task?.title ?? event.task}" ← ${event.agent}`)
      break
    }
    case 'agent_start':
      log('orchestrator', 'agent_start', `${event.agent}`)
      break
    case 'agent_complete':
      log('orchestrator', 'agent_complete', `${event.agent}`)
      break
    case 'task_skipped':
      log('orchestrator', 'task_skipped', `${event.task}`)
      break
    case 'message':
      log('orchestrator', 'message', `${event.agent} → (团队)`)
      break
    case 'error':
      log('orchestrator', 'error', `${event.agent ?? ''} ${event.task ?? ''}`)
      break
  }
}

// ============================================================================
// 5. 主流程
// ============================================================================

async function main() {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║      Open-Multi-Agent 四层事件演示                   ║')
  console.log('╚══════════════════════════════════════════════════════╝')

  // ---- 5a. 队列事件独立演示 ----
  demonstrateTaskQueueEvents()

  // ---- 5b. 创建编排器和团队 ----
  console.log('\n' + '='.repeat(60))
  console.log('【编排层 + Team层 + Agent间事件】创建团队和运行管线')
  console.log('='.repeat(60))

  // 先声明 team 变量，onApproval 中通过闭包引用
  let team: Team

  const orchestrator = new OpenMultiAgent({
    defaultModel: 'claude-sonnet-4-6',
    maxConcurrency: 1, // 串行，方便观察事件顺序
    onProgress: handleProgress,
    // onApproval 在每轮任务完成后、下一轮开始前触发
    // 用它来给下一个 Agent 发送团队消息，体现 Agent 间通信
    onApproval: (completed, next) => {
      for (const c of completed) {
        const from = c.assignee
        for (const n of next) {
          const to = n.assignee
          if (from && to && from !== to) {
            const msg = `接力完成！"${c.title}" 的结果已经写入共享内存，请基于它继续你的工作。`
            team.sendMessage(from, to, msg)
          }
        }
      }
      return true
    },
  })

  team = orchestrator.createTeam('doc-team', {
    name: 'doc-team',
    agents: [strategist, researcher, engineer, reviewer],
    sharedMemory: true,
    maxConcurrency: 1,
  })

  // ---- 5c. Team 层事件订阅 ----
  // team.on('message') 和 team.on('broadcast') 会在 sendMessage / broadcast 调用时触发
  // team.on('task:ready/complete/failed') 桥接了 Team 内部 TaskQueue 的事件，
  // 但这些事件仅在手动调用 team.addTask() 等操作时触发，
  // runTasks / runTeam 使用自己独立的 TaskQueue，不经过 Team 的事件桥。
  // 队列事件的完整演示见上面 demonstrateTaskQueueEvents()。
  team.on('message', (data) => {
    const event = data as OrchestratorEvent
    log('team', 'message', `${event.agent} → ${(event.data as any)?.to ?? '(团队)'}`)
  })
  team.on('broadcast', (data) => {
    const event = data as OrchestratorEvent
    log('team', 'broadcast', `${event.agent} → (全员广播)`)
  })

  // 在开始前发送广播和点对点消息
  // 这些消息会被 buildTaskPrompt 注入到对应 Agent 的 prompt 中
  team.broadcast('system', '各位好！本次目标是产出一份技术方案文档。请大家依次接力完成。')
  team.sendMessage('system', 'strategist', '请先做全局架构设计，后续同学会基于你的方案展开。')

  // ---- 5d. 定义任务管线 ----
  const tasks: Array<{
    title: string
    description: string
    assignee?: string
    dependsOn?: string[]
  }> = [
    {
      title: '架构设计',
      description: `设计一个小型文档站点生成器的技术方案。
文件输出到 /tmp/doc-gen/architecture.md。
内容包括：
- 技术栈选型（Node.js + Markdown 解析）
- 核心模块划分（解析器、渲染器、文件监听器）
- 目录结构设计
- 核心接口定义

控制在 40 行以内。`,
      assignee: 'strategist',
    },
    {
      title: '技术调研',
      description: `阅读架构师的设计方案（在共享内存中），然后：
1. 调研适合的 Markdown 解析库（marked / remark / markdown-it 等）
2. 调研文件监听方案（chokidar / fs.watch）
3. 输出对比分析和推荐方案到 /tmp/doc-gen/research.md`,
      assignee: 'researcher',
      dependsOn: ['架构设计'],
    },
    {
      title: '示例实现',
      description: `阅读架构方案和调研结果（在共享内存中）。
编写一个极简的原型代码到 /tmp/doc-gen/src/：
- parser.ts: 用推荐的 Markdown 库解析 .md 文件
- server.ts: 用 Node 内置 http 模块起一个预览服务器（端口 3003）
- 不需要完整实现，只需要核心逻辑的骨架即可

输出为可读的代码文件。`,
      assignee: 'engineer',
      dependsOn: ['技术调研'],
    },
    {
      title: '综合评审',
      description: `审阅本次任务的全部输出（架构方案、调研报告、示例代码）。
请给出结构化评审意见：
- 方案完整性
- 技术选型合理性
- 代码质量
- 改进建议
- 结论：通过 / 需修改

输出到 /tmp/doc-gen/review.md`,
      assignee: 'reviewer',
      dependsOn: ['示例实现'],
      memoryScope: 'all', // 能看到全部共享内存（不仅仅是直接依赖）
    },
  ]

  // ---- 5e. 执行管线 ----
  console.log()
  log('orchestrator', 'runTasks', '开始执行 4 阶段任务管线')

  const result = await orchestrator.runTasks(team, tasks)

  console.log('\n' + '='.repeat(60))
  console.log('管线执行完成')
  console.log('='.repeat(60))

  // ---- 5f. 发送后续消息（演示 MessageBus 的点对点通信） ----
  // 这条消息不会影响已完成的管线，只是展示 MessageBus 的独立通信能力
  team.sendMessage('system', 'reviewer', '请确认你的评审意见已经写入文件。')

  // ---- 5g. 打印结果 ----
  console.log('\n## 运行结果')
  console.log(`Success: ${result.success}`)
  console.log(
    `Tokens: input=${result.totalTokenUsage.input_tokens} output=${result.totalTokenUsage.output_tokens}`,
  )

  console.log('\n## Agent 结果')
  for (const [name, r] of result.agentResults) {
    const icon = r.success ? '✅' : '❌'
    const toolCalls = r.toolCalls.map((c) => c.toolName).join(', ') || '(无)'
    console.log(`  ${icon} ${name.padEnd(14)} tools: ${toolCalls} tokens: ${r.tokenUsage.input_tokens + r.tokenUsage.output_tokens}`)
  }

  // ---- 5h. 事件汇总统计 ----
  console.log('\n## 事件触发统计')
  const byLayer = new Map<string, number>()
  const byType = new Map<string, number>()
  for (const e of eventLog) {
    byLayer.set(e.layer, (byLayer.get(e.layer) ?? 0) + 1)
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
  }

  console.log('\n按层级:')
  for (const [layer, count] of byLayer) {
    console.log(`  ${layer.padEnd(18)} ${count} 次`)
  }

  console.log('\n按事件类型:')
  for (const [type, count] of byType) {
    console.log(`  ${type.padEnd(24)} ${count} 次`)
  }

  // 打印 reviewer 的最终输出
  const reviewResult = result.agentResults.get('reviewer')
  if (reviewResult?.success) {
    console.log('\n## 评审意见')
    console.log('─'.repeat(60))
    console.log(reviewResult.output.slice(0, 800))
    console.log('─'.repeat(60))
  }
}

main().catch((err) => {
  console.error('运行失败:', err)
  process.exit(1)
})
