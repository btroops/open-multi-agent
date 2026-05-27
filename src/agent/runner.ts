/**
 * @fileoverview Core conversation loop engine for open-multi-agent.
 *
 * {@link AgentRunner} is the heart of the framework. It handles:
 *  - Sending messages to the LLM adapter
 *  - Extracting tool-use blocks from the response
 *  - Executing tool calls in parallel via {@link ToolExecutor}
 *  - Appending tool results and looping back until `end_turn`
 *  - Accumulating token usage and timing data across all turns
 *
 * The loop follows a standard agentic conversation pattern:
 * one outer `while (true)` that breaks on `end_turn` or maxTurns exhaustion.
 */

import type {
  LLMMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCallRecord,
  TokenUsage,
  StreamEvent,
  ToolResult,
  ToolUseContext,
  TeamInfo,
  LLMAdapter,
  LLMChatOptions,
  TraceEvent,
  LoopDetectionConfig,
  LoopDetectionInfo,
  LLMToolDef,
  ContextStrategy,
  ThinkingConfig,
} from '../types.js'
import { TokenBudgetExceededError } from '../errors.js'
import { LoopDetector } from './loop-detector.js'
import { emitTrace } from '../utils/trace.js'
import { estimateTokens } from '../utils/tokens.js'
import type { ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'

// ---------------------------------------------------------------------------
// Tool presets
// ---------------------------------------------------------------------------

/** Predefined tool sets for common agent use cases. */
export const TOOL_PRESETS = {
  readonly: ['file_read', 'grep', 'glob'],
  readwrite: ['file_read', 'file_write', 'file_edit', 'grep', 'glob'],
  full: ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'bash'],
} as const satisfies Record<string, readonly string[]>

/** Framework-level disallowed tools for safety rails. */
export const AGENT_FRAMEWORK_DISALLOWED: readonly string[] = [
  // Empty for now, infrastructure for future built-in tools
]

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Static configuration for an {@link AgentRunner} instance.
 * These values are constant across every `run` / `stream` call.
 */
export interface RunnerOptions {
  /** LLM model identifier, e.g. `'claude-opus-4-6'`. */
  readonly model: string
  /** Optional system prompt prepended to every conversation. */
  readonly systemPrompt?: string
  /**
   * Maximum number of tool-call round-trips before the runner stops.
   * Prevents unbounded loops. Defaults to `10`.
   */
  readonly maxTurns?: number
  /** Maximum output tokens per LLM response. */
  readonly maxTokens?: number
  /** Sampling temperature passed to the adapter. */
  readonly temperature?: number
  /** Nucleus sampling top_p. Forwarded to all adapters. */
  readonly topP?: number
  /**
   * Top-k sampling. Forwarded to Anthropic and OpenAI-compatible local
   * servers. Cloud OpenAI rejects this parameter.
   */
  readonly topK?: number
  /**
   * Min-p sampling. Only supported by OpenAI-compatible local servers.
   * Cloud OpenAI rejects this parameter; the Anthropic adapter ignores it.
   */
  readonly minP?: number
  /**
   * Whether the model may emit multiple tool calls in a single assistant
   * turn. Forwarded to OpenAI cloud and OpenAI-compatible local servers as
   * `parallel_tool_calls`. The Anthropic adapter ignores this field.
   */
  readonly parallelToolCalls?: boolean
  /**
   * Frequency penalty. Forwarded to OpenAI cloud and OpenAI-compatible local
   * servers. The Anthropic adapter ignores this field.
   */
  readonly frequencyPenalty?: number
  /**
   * Presence penalty. Forwarded to OpenAI cloud and OpenAI-compatible local
   * servers. The Anthropic adapter ignores this field.
   */
  readonly presencePenalty?: number
  /**
   * Adapter-specific escape hatch merged into the outgoing request payload.
   * See {@link AgentConfig.extraBody} for the override precedence contract.
   */
  readonly extraBody?: Record<string, unknown>
  /** See {@link AgentConfig.thinking}. */
  readonly thinking?: ThinkingConfig
  /** AbortSignal that cancels any in-flight adapter call and stops the loop. */
  readonly abortSignal?: AbortSignal
  /**
   * Tool access control configuration.
   * - `toolPreset`: Predefined tool sets for common use cases
   * - `allowedTools`: Whitelist of tool names (allowlist)
   * - `disallowedTools`: Blacklist of tool names (denylist)
   * Tools are resolved in order: preset → allowlist → denylist
   */
  readonly toolPreset?: 'readonly' | 'readwrite' | 'full'
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
  /** Display name of the agent driving this runner (used in tool context). */
  readonly agentName?: string
  /** Short role description of the agent (used in tool context). */
  readonly agentRole?: string
  /** Loop detection configuration. When set, detects stuck agent loops. */
  readonly loopDetection?: LoopDetectionConfig
  /** Maximum cumulative tokens (input + output) allowed for this run. */
  readonly maxTokenBudget?: number
  /** Optional context compression strategy for long multi-turn runs. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Compress tool results that the agent has already processed.
   * See {@link AgentConfig.compressToolResults} for details.
   */
  readonly compressToolResults?: boolean | { readonly minChars?: number }
}

/**
 * Per-call callbacks for observing tool execution in real time.
 * All callbacks are optional; unused ones are simply skipped.
 */
export interface RunOptions {
  /** Fired just before each tool is dispatched. */
  readonly onToolCall?: (name: string, input: Record<string, unknown>) => void
  /** Fired after each tool result is received. */
  readonly onToolResult?: (name: string, result: ToolResult) => void
  /** Fired after each complete {@link LLMMessage} is appended. */
  readonly onMessage?: (message: LLMMessage) => void
  /**
   * Fired when the runner detects a potential configuration issue.
   * For example, when a model appears to ignore tool definitions.
   */
  readonly onWarning?: (message: string) => void
  /** Trace callback for observability spans. Async callbacks are safe. */
  readonly onTrace?: (event: TraceEvent) => void | Promise<void>
  /** Run ID for trace correlation. */
  readonly runId?: string
  /** Task ID for trace correlation. */
  readonly taskId?: string
  /** Agent name for trace correlation (overrides RunnerOptions.agentName). */
  readonly traceAgent?: string
  /**
   * Per-call abort signal. When set, takes precedence over the static
   * {@link RunnerOptions.abortSignal}. Useful for per-run timeouts.
   */
  readonly abortSignal?: AbortSignal
  /**
   * Team context for built-in tools such as `delegate_to_agent`.
   * Injected by the orchestrator during `runTeam` / `runTasks` pool runs.
   */
  readonly team?: TeamInfo
}

/** The aggregated result returned when a full run completes. */
export interface RunResult {
  /** All messages accumulated during this run (assistant + tool results). */
  readonly messages: LLMMessage[]
  /** The final text output from the last assistant turn. */
  readonly output: string
  /** All tool calls made during this run, in execution order. */
  readonly toolCalls: ToolCallRecord[]
  /** Aggregated token counts across every LLM call in this run. */
  readonly tokenUsage: TokenUsage
  /** Total number of LLM turns (including tool-call follow-ups). */
  readonly turns: number
  /** True when the run was terminated or warned due to loop detection. */
  readonly loopDetected?: boolean
  /** True when the run was terminated due to token budget limits. */
  readonly budgetExceeded?: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract every TextBlock from a content array and join them. */
function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Extract every ToolUseBlock from a content array. */
function extractToolUseBlocks(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/**
 * Boundaries (`startIndex` inclusive, `endIndex` exclusive) of a single
 * atomic conversation turn within a flat message array.
 */
interface Turn {
  startIndex: number
  endIndex: number
}

/**
 * Group a flat message array into atomic turns so context-management
 * strategies can split on safe boundaries.
 *
 * A turn is one of:
 *   - a single user / assistant text message, or
 *   - an assistant message containing one or more `tool_use` blocks plus the
 *     immediately following user message containing the matching `tool_result`
 *     blocks (kept together so neither half can be dropped on its own).
 *
 * Splitting on turn boundaries — instead of slicing by raw message count —
 * prevents orphaned `tool_use_id` references that the Anthropic and OpenAI
 * APIs reject. Modelled on `groupIntoTurns` from the context-chef library.
 *
 * 将扁平的消息数组按原子轮次（atomic turns）分组，以便上下文管理策略能够在安全的边界上切分。
 *
 * 一个“轮次”（turn）的定义：
 *   - 单条 user 或 assistant 的纯文本消息；或
 *   - 一条包含一个或多个 `tool_use` 块的 assistant 消息，紧接着的
 *     一条包含对应 `tool_result` 块的 user 消息（两者作为一个整体，不可拆分）。
 *
 * 为什么需要这样做？
 *   - 如果直接按消息数量或 token 数量截断，可能会在 `tool_use` 和它的 `tool_result`
 *     之间切开，导致 `tool_use_id` 无法匹配。
 *   - Anthropic / OpenAI API 要求成对出现：`tool_use` 必须后跟匹配的 `tool_result`，
 *     否则请求会被拒绝。
 *   - 按轮次分组后，可以安全地从头部或尾部丢弃完整的轮次，而不会产生孤立的 `tool_use`。
 *
 * 实现参考了 `context-chef` 库的 `groupIntoTurns` 方法。
 *
 * @param messages 扁平的消息数组（包含 user / assistant 交替的角色）
 * @returns Turn 数组，每个 Turn 包含起始和结束索引（startIndex 包含，endIndex 不包含）
 *
 * @example
 * 输入：
 *   [user, assistant(有tool_use), user(有tool_result), assistant, user]
 * 输出：
 *   Turn1: {start:0, end:1}         // 第一条 user
 *   Turn2: {start:1, end:3}         // assistant(tool_use) + user(tool_result)
 *   Turn3: {start:3, end:4}         // assistant
 *   Turn4: {start:4, end:5}         // user
 */
function groupIntoTurns(messages: LLMMessage[]): Turn[] {
  const turns: Turn[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    const hasToolUse =
      msg.role === 'assistant' && msg.content.some(b => b.type === 'tool_use')
    if (hasToolUse) {
      const start = i
      i++
      // Absorb the matching tool_result user message, when present.
      if (
        i < messages.length
        && messages[i]!.role === 'user'
        && messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        i++
      }
      turns.push({ startIndex: start, endIndex: i })
    } else {
      turns.push({ startIndex: i, endIndex: i + 1 })
      i++
    }
  }
  return turns
}

/**
 * Replace `image` blocks with text placeholders so binary attachment data
 * never leaks into the summarisation prompt.
 *
 * `summarizeMessages` flattens old turns via `JSON.stringify(message)` and
 * inlines the result into a text user-message it ships to the summary model.
 * For an `ImageBlock`, that serialisation includes the full base64 payload —
 * a 1MB image would balloon the "compression" call by ~250k tokens, defeating
 * its purpose and risking context-limit rejection.
 *
 * The placeholder still tells the summariser that media was present at this
 * turn, so the produced summary can reference it. Modelled on chef Janitor's
 * `stripAttachmentsForCompression`.
 *
 *
 * 问题背景：
 *   - `summarizeMessages` 方法在压缩长对话时，会将旧消息序列化为 JSON 字符串作为提示的一部分，
 *     然后发送给摘要模型（另一个 LLM）。
 *   - 如果原始消息中包含 `image` 块（通常携带 base64 编码的图片数据），`JSON.stringify`
 *     会将其完整序列化，导致一个 1MB 的图片变成大约 250k tokens 的 base64 字符串。
 *   - 这会导致几个问题：
 *       1) 摘要调用的 token 消耗巨大，违背了“压缩”的初衷（节省 token）。
 *       2) 极有可能超出摘要模型的最大上下文窗口（context limit）。
 *       3) 摘要模型并不需要看到图片的原始像素数据，只需要知道“这里有一张图片”。
 *
 * 解决方案：
 *   - 在构造摘要提示之前，遍历所有消息，将 `image` 块替换为简单的文本占位符，
 *     格式为 `[image: {media_type}]`（例如 `[image: image/jpeg]`）。
 *   - 这样摘要模型仍然知道该轮对话中有图片内容，可以据此生成合理的摘要，
 *     但不会消耗大量 token 去编码二进制数据。
 *
 * 设计参考：
 *   - 该函数模仿了 `context-chef` 库（chef Janitor）中的 `stripAttachmentsForCompression` 方法。
 *
 * 注意：
 *   - 该替换只影响传给摘要模型的消息，不会修改保存在 `conversationMessages` 中的原始消息。
 *   - 只处理 `type === 'image'` 的块，其他类型的块（text, tool_use, tool_result 等）保持不变。
 *
 * @param messages 原始 LLM 消息数组（可能包含 ImageBlock）
 * @returns 新消息数组，其中所有 ImageBlock 已被替换为文本占位符
 */
function stripImageBlocksForSummary(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((msg) => {
    if (!msg.content.some(b => b.type === 'image')) return msg
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type === 'image') {
        return { type: 'text', text: `[image: ${block.source.media_type}]` } satisfies TextBlock
      }
      return block
    })
    return { role: msg.role, content: newContent }
  })
}

/** Add two {@link TokenUsage} values together, returning a new object. */
function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

/** Default minimum content length before tool result compression kicks in. */
const DEFAULT_MIN_COMPRESS_CHARS = 500

/**
 * Prepends synthetic framing text to the first user message so we never emit
 * consecutive `user` turns (Bedrock) and summaries do not concatenate onto
 * the original user prompt (direct API). If there is no user message yet,
 * inserts a single assistant text preamble.
 *
 * 使用场景：
 *   - 当使用摘要压缩策略时，压缩后的新消息需要插入类似 `[Conversation summary] ...` 的前缀，
 *     但绝不能直接拼接到原始的第一条用户消息（例如用户原始问题）上，因为那样会污染原始 prompt。
 *   - 对于某些 LLM API（如 Bedrock），连续两条 user 消息是不允许的。通过将前缀插入到第一条 user
 *     消息的开头（而非增加单独一条 user），维持了 user/assistant 交替规则。
 *
 * @param messages 原始消息数组（可能以 user 或 assistant 开头）
 * @param prefix   要插入的文本前缀（例如摘要内容）
 * @returns 修改后的消息数组
 */
function prependSyntheticPrefixToFirstUser(
  messages: LLMMessage[],
  prefix: string,
): LLMMessage[] {
  const userIdx = messages.findIndex(m => m.role === 'user')
  if (userIdx < 0) {
    return [{
      role: 'assistant',
      content: [{ type: 'text', text: prefix.trimEnd() }],
    }, ...messages]
  }
  const target = messages[userIdx]!
  const merged: LLMMessage = {
    role: 'user',
    content: [{ type: 'text', text: prefix }, ...target.content],
  }
  return [...messages.slice(0, userIdx), merged, ...messages.slice(userIdx + 1)]
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * Drives a full agentic conversation: LLM calls, tool execution, and looping.
 *
 * @example
 * ```ts
 * const runner = new AgentRunner(adapter, registry, executor, {
 *   model: 'claude-opus-4-6',
 *   maxTurns: 10,
 * })
 * const result = await runner.run(messages)
 * console.log(result.output)
 * ```
 */
export class AgentRunner {
  private readonly maxTurns: number
  private summarizeCache: {
    oldSignature: string
    summaryPrefix: string
  } | null = null

  constructor(
    private readonly adapter: LLMAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly options: RunnerOptions,
  ) {
    this.maxTurns = options.maxTurns ?? 10
  }

  private serializeMessage(message: LLMMessage): string {
    return JSON.stringify(message)
  }
  /**
   * 使用滑动窗口策略截断消息历史，保留最近的 N 轮完整对话（原子轮次），
   * 同时确保不会拆分 `tool_use` / `tool_result` 对。
   *
   * @param messages 原始消息数组
   * @param maxTurns 要保留的最大轮次数（每个轮次通常包含一条 assistant 和一条 user 消息，
   *                 但 tool 轮次会包含 assistant(tool_use) + user(tool_result) 两条）
   * @returns 截断后的消息数组，可能包含一个说明前缀（如果丢弃了历史）
   */
  private truncateToSlidingWindow(messages: LLMMessage[], maxTurns: number): LLMMessage[] {
    if (maxTurns <= 0) {
      return messages
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex]! : null
    const afterFirst = firstUserIndex >= 0
      ? messages.slice(firstUserIndex + 1)
      : messages.slice()

    // Walk turns from the tail, accumulating message count until we have at
    // least `maxTurns * 2` messages — preserving the historical "message-pair
    // count" semantics of `maxTurns` for plain conversations while never
    // splitting a tool_use/tool_result pair (see `groupIntoTurns`). The kept
    // slice may exceed the target by one message when the boundary lands
    // inside an atomic tool turn — that's the smallest safe slice.
    const target = maxTurns * 2
    if (afterFirst.length <= target) {
      return messages
    }

    const turns = groupIntoTurns(afterFirst)
    let cumulative = 0
    let cutoffTurnIdx = turns.length
    for (let i = turns.length - 1; i >= 0; i--) {
      cumulative += turns[i]!.endIndex - turns[i]!.startIndex
      cutoffTurnIdx = i
      if (cumulative >= target) break
    }

    const keptTurns = turns.slice(cutoffTurnIdx)
    const keepStartIdx = keptTurns[0]!.startIndex
    const kept = afterFirst.slice(keepStartIdx)
    const droppedTurns = turns.length - keptTurns.length

    const result: LLMMessage[] = []
    if (firstUser !== null) {
      result.push(firstUser)
    }

    if (droppedTurns > 0) {
      const notice =
        `[Earlier conversation history truncated — ${droppedTurns} turn(s) removed]\n\n`
      result.push(...prependSyntheticPrefixToFirstUser(kept, notice))
      return result
    }

    result.push(...kept)
    return result
  }
  /**
   * 使用 LLM 对对话历史中较旧的部分生成摘要，然后用摘要替换旧部分，
   * 从而实现上下文压缩（适用于长对话场景）。
   *
   * 核心流程：
   *   1. 检查是否需要压缩（预估 token 数 > maxTokens 且消息数量 >= 4）。
   *   2. 保留第一条 user 消息（通常是用户原始输入），将剩余消息分为“旧部分”和“最近部分”。
   *      - 分界点选择在偶数边界（保证不会拆散 tool_use / tool_result 对）。
   *   3. 对旧部分移除图片块（避免 base64 炸裂），并生成签名用于缓存。
   *   4. 如果缓存命中，直接复用之前的摘要前缀；否则调用 LLM 生成摘要。
   *   5. 将摘要前缀通过 `prependSyntheticPrefixToFirstUser` 安全地注入到“最近部分”的第一条 user 消息开头。
   *   6. 返回新的消息列表（第一条 user 消息 + 注入摘要后的最近部分），以及摘要调用消耗的 token 用量。
   *
   * @param messages         原始消息数组（完整对话历史）
   * @param maxTokens        压缩阈值（预估 token 数超过此值才触发压缩）
   * @param summaryModel     用于生成摘要的模型名称（未指定时使用主模型）
   * @param baseChatOptions  基础 LLM 调用选项（将复制并覆盖 model，同时清除 tools）
   * @param turns            当前轮次编号（仅用于 trace 事件）
   * @param options          运行时选项（包含 trace 回调等）
   * @returns 压缩后的消息数组及本次摘要调用消耗的 token（若无压缩则 usage 为零）
   */
  private async summarizeMessages(
    messages: LLMMessage[],
    maxTokens: number,
    summaryModel: string | undefined,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    const estimated = estimateTokens(messages)
    if (estimated <= maxTokens || messages.length < 4) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUser = messages[firstUserIndex]!
    const rest = messages.slice(firstUserIndex + 1)
    if (rest.length < 2) {
      return { messages, usage: ZERO_USAGE }
    }

    // Split on an even boundary so we never separate a tool_use assistant turn
    // from its tool_result user message (rest is user/assistant pairs).
    const splitAt = Math.max(2, Math.floor(rest.length / 4) * 2)
    const oldPortion = rest.slice(0, splitAt)
    const recentPortion = rest.slice(splitAt)

    // Strip image attachments before serialising — JSON.stringify on an
    // ImageBlock would inline the entire base64 payload into the summary
    // prompt, so a 1MB image would defeat the very purpose of compression.
    // The placeholder still flags that media existed at this turn so the
    // summariser can mention it. recentPortion is untouched (returned to
    // the caller verbatim, never serialised here).
    const oldPortionForSummary = stripImageBlocksForSummary(oldPortion)
    const oldSignature = oldPortionForSummary.map(m => this.serializeMessage(m)).join('\n')
    if (this.summarizeCache !== null && this.summarizeCache.oldSignature === oldSignature) {
      const mergedRecent = prependSyntheticPrefixToFirstUser(
        recentPortion,
        `${this.summarizeCache.summaryPrefix}\n\n`,
      )
      return { messages: [firstUser, ...mergedRecent], usage: ZERO_USAGE }
    }

    const summaryPrompt = [
      'Summarize the following conversation history for an LLM.',
      '- Preserve user goals, constraints, and decisions.',
      '- Keep key tool outputs and unresolved questions.',
      '- Use concise bullets.',
      '- Do not fabricate details.',
    ].join('\n')

    const summaryInput: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: summaryPrompt },
          { type: 'text', text: `\n\nConversation:\n${oldSignature}` },
        ],
      },
    ]

    const summaryOptions: LLMChatOptions = {
      ...baseChatOptions,
      model: summaryModel ?? this.options.model,
      tools: undefined,
    }

    const summaryStartMs = Date.now()
    const summaryResponse = await this.adapter.chat(summaryInput, summaryOptions)
    if (options.onTrace) {
      const summaryEndMs = Date.now()
      emitTrace(options.onTrace, {
        type: 'llm_call',
        runId: options.runId ?? '',
        taskId: options.taskId,
        agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
        model: summaryOptions.model,
        phase: 'summary',
        turn: turns,
        tokens: summaryResponse.usage,
        startMs: summaryStartMs,
        endMs: summaryEndMs,
        durationMs: summaryEndMs - summaryStartMs,
      })
    }

    const summaryText = extractText(summaryResponse.content).trim()
    const summaryPrefix = summaryText.length > 0
      ? `[Conversation summary]\n${summaryText}`
      : '[Conversation summary unavailable]'

    this.summarizeCache = { oldSignature, summaryPrefix }
    const mergedRecent = prependSyntheticPrefixToFirstUser(
      recentPortion,
      `${summaryPrefix}\n\n`,
    )
    return {
      messages: [firstUser, ...mergedRecent],
      usage: summaryResponse.usage,
    }
  }

  /**
   * 根据配置的上下文策略（滑动窗口 / 摘要 / 紧凑压缩 / 自定义）压缩消息数组。
   * 该方法在主循环中每轮 LLM 调用之前被调用，用于将对话历史控制在 token 预算内。
   *
   * @param messages        原始消息数组（完整的对话历史）
   * @param strategy        上下文策略配置对象
   * @param baseChatOptions 基础 LLM 选项（用于摘要策略，因为摘要需要调用 LLM）
   * @param turns           当前轮次编号（仅用于追踪事件）
   * @param options         运行时选项（包含 trace 回调等）
   * @returns 压缩后的消息数组及本次压缩消耗的 token（注意：只有摘要策略会消耗 token，
   *          其他策略的 `usage` 均为零；自定义策略当前返回零，但可扩展）
   * @throws 如果自定义策略的 `compress` 函数返回空数组或非数组，抛出错误
   */
  private async applyContextStrategy(
    messages: LLMMessage[],
    strategy: ContextStrategy,
    baseChatOptions: LLMChatOptions,
    turns: number,
    options: RunOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    // --------------------------------------------------------------------------
    // 策略一：滑动窗口（sliding-window）
    // --------------------------------------------------------------------------
    // 特点：
    //   - 不调用 LLM，极快且无 token 消耗
    //   - 保留第一条 user 消息 + 最近的 N 个原子轮次（根据 groupIntoTurns 分组）
    //   - 丢弃的轮次会在第一条 user 消息后添加一条说明 `[Earlier conversation history truncated — X turn(s) removed]`
    //   - 保证不会拆分 tool_use / tool_result 对
    if (strategy.type === 'sliding-window') {
      return {
        messages: this.truncateToSlidingWindow(messages, strategy.maxTurns),
        usage: ZERO_USAGE,
      }
    }

    // --------------------------------------------------------------------------
    // 策略二：摘要（summarize）
    // --------------------------------------------------------------------------
    // 特点：
    //   - 调用 LLM（使用 `summaryModel` 或主模型）对较旧的部分生成摘要
    //   - 保留第一条 user 消息 + 最近的一部分消息，在最近部分前面注入摘要前缀
    //   - 摘要结果会缓存（基于旧消息的签名），相同签名直接复用缓存，避免重复调用 LLM
    //   - 返回的 `usage` 包含摘要调用消耗的 token（包括输入和输出）
    if (strategy.type === 'summarize') {
      return this.summarizeMessages(
        messages,
        strategy.maxTokens,
        strategy.summaryModel,
        baseChatOptions,
        turns,
        options,
      )
    }

    // --------------------------------------------------------------------------
    // 策略三：紧凑压缩（compact）
    // --------------------------------------------------------------------------
    // 特点：
    //   - 不调用 LLM，纯启发式规则，无 token 消耗
    //   - 压缩长文本块、长 tool_result 内容，保留 tool_use 块和最近 N 轮完整消息
    //   - 对错误结果、委托结果（delegate_to_agent）不压缩
    //   - 返回的 `usage` 始终为零
    if (strategy.type === 'compact') {
      return {
        messages: this.compactMessages(messages, strategy),
        usage: ZERO_USAGE,
      }
    }

    // --------------------------------------------------------------------------
    // 策略四：自定义（custom）
    // --------------------------------------------------------------------------
    // 特点：
    //   - 用户提供 `compress(messages, estimatedTokens)` 函数
    //   - 框架仅要求返回非空的 LLMMessage[]，并检查合法性
    //   - 压缩过程可能消耗 token（例如调用外部服务），但返回值中的 `usage` 固定为零，
    //     因为框架无法获知自定义压缩的内部消耗。如果需要记录，用户应自行通过 `onTrace` 上报。
    const estimated = estimateTokens(messages)
    const compressed = await strategy.compress(messages, estimated)
    if (!Array.isArray(compressed) || compressed.length === 0) {
      throw new Error('contextStrategy.custom.compress must return a non-empty LLMMessage[]')
    }
    return { messages: compressed, usage: ZERO_USAGE }
  }

  // -------------------------------------------------------------------------
  // Tool resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the final set of tools available to this agent based on the
   * three-layer configuration: preset → allowlist → denylist → framework safety.
   *
   * Returns LLMToolDef[] for direct use with LLM adapters.
   */
  private resolveTools(): LLMToolDef[] {
    // Validate configuration for contradictions
    if (this.options.toolPreset && this.options.allowedTools) {
      console.warn(
        'AgentRunner: both toolPreset and allowedTools are set. ' +
        'Final tool access will be the intersection of both.'
      )
    }

    if (this.options.allowedTools && this.options.disallowedTools) {
      const overlap = this.options.allowedTools.filter(tool =>
        this.options.disallowedTools!.includes(tool)
      )
      if (overlap.length > 0) {
        console.warn(
          `AgentRunner: tools [${overlap.map(name => `"${name}"`).join(', ')}] appear in both allowedTools and disallowedTools. ` +
          'This is contradictory and may lead to unexpected behavior.'
        )
      }
    }

    const allTools = this.toolRegistry.toToolDefs()
    const runtimeCustomTools = this.toolRegistry.toRuntimeToolDefs()
    const runtimeCustomToolNames = new Set(runtimeCustomTools.map(t => t.name))
    let filteredTools = allTools.filter(t => !runtimeCustomToolNames.has(t.name))

    // 1. Apply preset filter if set
    if (this.options.toolPreset) {
      const presetTools = new Set(TOOL_PRESETS[this.options.toolPreset] as readonly string[])
      filteredTools = filteredTools.filter(t => presetTools.has(t.name))
    }

    // 2. Apply allowlist filter if set
    if (this.options.allowedTools) {
      filteredTools = filteredTools.filter(t => this.options.allowedTools!.includes(t.name))
    }

    // 3. Apply denylist filter if set
    const denied = this.options.disallowedTools
      ? new Set(this.options.disallowedTools)
      : undefined
    if (denied) {
      filteredTools = filteredTools.filter(t => !denied.has(t.name))
    }

    // 4. Apply framework-level safety rails
    const frameworkDenied = new Set(AGENT_FRAMEWORK_DISALLOWED)
    filteredTools = filteredTools.filter(t => !frameworkDenied.has(t.name))

    // Runtime-added custom tools bypass preset / allowlist but respect denylist.
    const finalRuntime = denied
      ? runtimeCustomTools.filter(t => !denied.has(t.name))
      : runtimeCustomTools
    return [...filteredTools, ...finalRuntime]
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a complete conversation starting from `messages`.
   *
   * The call may internally make multiple LLM requests (one per tool-call
   * round-trip). It returns only when:
   *  - The LLM emits `end_turn` with no tool-use blocks, or
   *  - `maxTurns` is exceeded, or
   *  - The abort signal is triggered.
   */
  async run(
    messages: LLMMessage[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    // Collect everything yielded by the internal streaming loop.
    const accumulated: RunResult = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_USAGE,
      turns: 0,
    }

    for await (const event of this.stream(messages, options)) {
      if (event.type === 'done') {
        Object.assign(accumulated, event.data)
      } else if (event.type === 'error') {
        throw event.data
      }
    }

    return accumulated
  }

  /**
   * Run the conversation and yield {@link StreamEvent}s incrementally.
   *
   * Callers receive:
   *  - `{ type: 'text', data: string }` for each text delta
   *  - `{ type: 'tool_use', data: ToolUseBlock }` when the model requests a tool
   *  - `{ type: 'tool_result', data: ToolResultBlock }` after each execution
 *  - `{ type: 'budget_exceeded', data: TokenBudgetExceededError }` on budget trip
   *  - `{ type: 'done', data: RunResult }` at the very end
   *  - `{ type: 'error', data: Error }` on unrecoverable failure
   */
  async *stream(
    initialMessages: LLMMessage[],
    options: RunOptions = {},
  ): AsyncGenerator<StreamEvent> {
    // Working copy of the conversation — mutated as turns progress.
    let conversationMessages: LLMMessage[] = [...initialMessages]
    const newMessages: LLMMessage[] = []

    // Accumulated state across all turns.
    let totalUsage: TokenUsage = ZERO_USAGE
    const allToolCalls: ToolCallRecord[] = []
    let finalOutput = ''
    let turns = 0
    let budgetExceeded = false

    // Build the stable LLM options once; model / tokens / temp don't change.
    // resolveTools() returns LLMToolDef[] with three-layer filtering applied.
    const toolDefs = this.resolveTools()

    // Per-call abortSignal takes precedence over the static one.
    const effectiveAbortSignal = options.abortSignal ?? this.options.abortSignal

    const baseChatOptions: LLMChatOptions = {
      model: this.options.model,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      topP: this.options.topP,
      topK: this.options.topK,
      minP: this.options.minP,
      parallelToolCalls: this.options.parallelToolCalls,
      frequencyPenalty: this.options.frequencyPenalty,
      presencePenalty: this.options.presencePenalty,
      extraBody: this.options.extraBody,
      thinking: this.options.thinking,
      systemPrompt: this.options.systemPrompt,
      abortSignal: effectiveAbortSignal,
    }

    // Loop detection state — only allocated when configured.
    const detector = this.options.loopDetection
      ? new LoopDetector(this.options.loopDetection)
      : null
    let loopDetected = false
    let loopWarned = false
    const loopAction = this.options.loopDetection?.onLoopDetected ?? 'warn'

    try {
      // -----------------------------------------------------------------
      // Main agentic loop — `while (true)` until end_turn or maxTurns
      // -----------------------------------------------------------------
      while (true) {
        // Respect abort before each LLM call.
        if (effectiveAbortSignal?.aborted) {
          break
        }

        // Guard against unbounded loops.
        if (turns >= this.maxTurns) {
          break
        }

        turns++

        // Compress consumed tool results before context strategy (lightweight,
        // no LLM calls) so the strategy operates on already-reduced messages.
        if (this.options.compressToolResults && turns > 1) {
          conversationMessages = this.compressConsumedToolResults(conversationMessages)
        }

        // Optionally compact context before each LLM call.
        if (this.options.contextStrategy) {
          const compacted = await this.applyContextStrategy(
            conversationMessages,
            this.options.contextStrategy,
            baseChatOptions,
            turns,
            options,
          )
          conversationMessages = compacted.messages
          totalUsage = addTokenUsage(totalUsage, compacted.usage)
        }

        // ------------------------------------------------------------------
        // Step 1: Call the LLM and collect the full response for this turn.
        // ------------------------------------------------------------------
        const llmStartMs = Date.now()
        const response = await this.adapter.chat(conversationMessages, baseChatOptions)
        if (options.onTrace) {
          const llmEndMs = Date.now()
          emitTrace(options.onTrace, {
            type: 'llm_call',
            runId: options.runId ?? '',
            taskId: options.taskId,
            agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
            model: this.options.model,
            phase: 'turn',
            turn: turns,
            tokens: response.usage,
            startMs: llmStartMs,
            endMs: llmEndMs,
            durationMs: llmEndMs - llmStartMs,
          })
        }

        totalUsage = addTokenUsage(totalUsage, response.usage)

        // ------------------------------------------------------------------
        // Step 2: Build the assistant message from the response content.
        // ------------------------------------------------------------------
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: response.content,
        }

        conversationMessages.push(assistantMessage)
        newMessages.push(assistantMessage)
        options.onMessage?.(assistantMessage)

        // Yield text deltas so streaming callers can display them promptly.
        const turnText = extractText(response.content)
        if (turnText.length > 0) {
          yield { type: 'text', data: turnText } satisfies StreamEvent
        }

        const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens
        // Defer the break to after tool_result is appended so we never leave
        // an unmatched tool_use block in conversationMessages (which would
        // cause a 400 on any subsequent API call that replays the history).
        let pendingBudgetExceeded = false
        if (this.options.maxTokenBudget !== undefined && totalTokens > this.options.maxTokenBudget) {
          budgetExceeded = true
          finalOutput = turnText
          yield {
            type: 'budget_exceeded',
            data: new TokenBudgetExceededError(
              this.options.agentName ?? 'unknown',
              totalTokens,
              this.options.maxTokenBudget,
            ),
          } satisfies StreamEvent
          pendingBudgetExceeded = true
        }

        // Extract tool-use blocks for detection and execution.
        const toolUseBlocks = extractToolUseBlocks(response.content)

        // ------------------------------------------------------------------
        // Step 2.5: Loop detection — check before yielding tool_use events
        // so that terminate mode doesn't emit orphaned tool_use without
        // matching tool_result.
        // ------------------------------------------------------------------
        let injectWarning = false
        let injectWarningKind: 'tool_repetition' | 'text_repetition' = 'tool_repetition'
        if (detector && toolUseBlocks.length > 0) {
          const toolInfo = detector.recordToolCalls(toolUseBlocks)
          const textInfo = turnText.length > 0 ? detector.recordText(turnText) : null
          const info = toolInfo ?? textInfo

          if (info) {
            yield { type: 'loop_detected', data: info } satisfies StreamEvent
            options.onWarning?.(info.detail)

            const action = typeof loopAction === 'function'
              ? await loopAction(info)
              : loopAction

            if (action === 'terminate') {
              loopDetected = true
              finalOutput = turnText
              break
            } else if (action === 'warn' || action === 'inject') {
              if (loopWarned) {
                // Second detection after a warning — force terminate.
                loopDetected = true
                finalOutput = turnText
                break
              }
              loopWarned = true
              injectWarning = true
              injectWarningKind = info.kind
              // Fall through to execute tools, then inject warning.
            }
            // 'continue' — do nothing, let the loop proceed normally.
          } else {
            // No loop detected this turn — agent has recovered, so reset
            // the warning state. A future loop gets a fresh warning cycle.
            loopWarned = false
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Decide whether to continue looping.
        // ------------------------------------------------------------------
        if (toolUseBlocks.length === 0) {
          // Warn on first turn if tools were provided but model didn't use them.
          if (turns === 1 && toolDefs.length > 0 && options.onWarning) {
            const agentName = this.options.agentName ?? 'unknown'
            options.onWarning(
              `Agent "${agentName}" has ${toolDefs.length} tool(s) available but the model ` +
              `returned no tool calls. If using a local model, verify it supports tool calling ` +
              `(see https://ollama.com/search?c=tools).`,
            )
          }
          // No tools requested — this is the terminal assistant turn.
          finalOutput = turnText
          break
        }

        // Announce each tool-use block the model requested (after loop
        // detection, so terminate mode never emits unpaired events).
        // ------------------------------------------------------------------
        // 将本轮 LLM 请求的所有工具调用块逐个发布给调用方（流式事件）
        // ------------------------------------------------------------------
        // 为什么要放在循环检测 **之后**？
        // 
        // 1. 循环检测可能决定立即终止（action === 'terminate'）
        //    - 如果在此之前就已经 yield 了 tool_use 事件，调用方会收到“工具请求”
        //    - 但由于循环立即 break，后续的 tool_result 永远不会 yield
        //    - 这会导致调用方看到孤立的 tool_use 事件，没有对应的 tool_result
        //    - 这种“未配对”的事件会破坏调用方对执行流程的预期，也可能导致 UI 显示异常
        //
        // 2. 通过将 yield 放在循环检测 **之后**：
        //    - 如果 action === 'terminate'，代码会直接 break 跳出循环，根本不会走到这个 for 循环
        //    - 因此调用方永远不会收到那些将要被丢弃的 tool_use 事件
        //    - 保证了事件流的完整性：要么 tool_use 和 tool_result 成对出现，要么都不出现
        //
        // 3. 对于 action === 'inject' 或 'warn'（第一次警告）：
        //    - 循环检测不终止，代码会继续执行到这里
        //    - 正常 yield tool_use 事件，稍后也会 yield tool_result 事件（包括注入的警告文本）
        //    - 事件对保持完整
        //
        // 4. 对于 action === 'continue'：
        //    - 同样正常执行，不影响事件配对
        //
        for (const block of toolUseBlocks) {
          yield { type: 'tool_use', data: block } satisfies StreamEvent
        }

        // ------------------------------------------------------------------
        // Step 4: Execute all tool calls in PARALLEL.
        //
        // Parallel execution is critical for multi-tool responses where the
        // tools are independent (e.g. reading several files at once).
        // ------------------------------------------------------------------
        const toolContext: ToolUseContext = this.buildToolContext(options)

        const executionPromises = toolUseBlocks.map(async (block): Promise<{
          resultBlock: ToolResultBlock
          record: ToolCallRecord
          delegationUsage?: TokenUsage
        }> => {
          options.onToolCall?.(block.name, block.input)

          const startTime = Date.now()
          let result: ToolResult

          try {
            result = await this.toolExecutor.execute(
              block.name,
              block.input,
              toolContext,
            )
          } catch (err) {
            // Tool executor errors become error results — the loop continues.
            const message = err instanceof Error ? err.message : String(err)
            result = { data: message, isError: true }
          }

          const endTime = Date.now()
          const duration = endTime - startTime

          options.onToolResult?.(block.name, result)

          if (options.onTrace) {
            emitTrace(options.onTrace, {
              type: 'tool_call',
              runId: options.runId ?? '',
              taskId: options.taskId,
              agent: options.traceAgent ?? this.options.agentName ?? 'unknown',
              tool: block.name,
              isError: result.isError ?? false,
              input: block.input,
              output: result.data,
              startMs: startTime,
              endMs: endTime,
              durationMs: duration,
            })
          }

          const record: ToolCallRecord = {
            toolName: block.name,
            input: block.input,
            output: result.data,
            duration,
          }

          const resultBlock: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.data,
            is_error: result.isError,
          }

          return {
            resultBlock,
            record,
            ...(result.metadata?.tokenUsage !== undefined
              ? { delegationUsage: result.metadata.tokenUsage }
              : {}),
          }
        })

        // Wait for every tool in this turn to finish.
        const executions = await Promise.all(executionPromises)

        // Roll up any nested-run token usage surfaced via ToolResult.metadata
        // (e.g. from delegate_to_agent) so it counts against this agent's budget.
        let delegationTurnUsage: TokenUsage | undefined
        for (const ex of executions) {
          if (ex.delegationUsage !== undefined) {
            totalUsage = addTokenUsage(totalUsage, ex.delegationUsage)
            delegationTurnUsage = delegationTurnUsage === undefined
              ? ex.delegationUsage
              : addTokenUsage(delegationTurnUsage, ex.delegationUsage)
          }
        }

        // ------------------------------------------------------------------
        // Step 5: Accumulate results and build the user message that carries
        //         them back to the LLM in the next turn.
        // ------------------------------------------------------------------
        const toolResultBlocks: ContentBlock[] = executions.map(e => e.resultBlock)

        for (const { record, resultBlock } of executions) {
          allToolCalls.push(record)
          yield { type: 'tool_result', data: resultBlock } satisfies StreamEvent
        }

        // Inject a loop-detection warning into the tool-result message so
        // the LLM sees it alongside the results (avoids two consecutive user
        // messages which violates the alternating-role constraint).
        if (injectWarning) {
          const warningText = injectWarningKind === 'text_repetition'
            ? 'WARNING: You appear to be generating the same response repeatedly. ' +
              'This suggests you are stuck in a loop. Please try a different approach ' +
              'or provide new information.'
            : 'WARNING: You appear to be repeating the same tool calls with identical arguments. ' +
              'This suggests you are stuck in a loop. Please try a different approach, use different ' +
              'parameters, or explain what you are trying to accomplish.'
          toolResultBlocks.push({ type: 'text' as const, text: warningText })
        }

        const toolResultMessage: LLMMessage = {
          role: 'user',
          content: toolResultBlocks,
        }

        conversationMessages.push(toolResultMessage)
        newMessages.push(toolResultMessage)
        options.onMessage?.(toolResultMessage)

        // Budget check is deferred until tool_result events have been yielded
        // and the tool_result user message has been appended, so stream
        // consumers see matched tool_use/tool_result pairs and the returned
        // `messages` remain resumable against the Anthropic/OpenAI APIs.
        // ------------------------------------------------------------------
        // Budget check (phase 2) – deferred until after tool_result handling
        // ------------------------------------------------------------------
        //
        // 为什么需要延迟到这里才最终决定是否终止？
        //
        // 第一阶段的预算检查（在 LLM 响应后、工具执行前）发现超限时，只设置了
        // `pendingBudgetExceeded = true`，但并未立即 `break`。原因是：
        //   - 此时还未 yield tool_use 事件，也未执行工具、未产生 tool_result
        //   - 如果立即终止，调用方会看到不完整的执行痕迹：既没有完整的 tool_use，
        //     也没有对应的 tool_result，违反了“事件成对出现”的约定。
        //   - 更重要的是，`conversationMessages` 历史会停留在包含未匹配 tool_use 的
        //     assistant 消息上，而缺乏对应的 tool_result user 消息。这样的历史记录
        //     后续无法重新提交给 Anthropic/OpenAI API（会报 400 错误）。
        //
        // 因此框架承诺：**无论是否超限，只要本轮产生了 tool_use，就一定会在终止前
        //   执行工具、生成 tool_result、并将其作为 user 消息追加到历史中**。
        //   这保证了即使预算超限，最终返回的 `messages` 数组也始终是 API 可接受的
        //   完整对话（tool_use 与 tool_result 配对完整）。
        //
        // 下面两个检查分别处理两种超限场景：

        // ------------------------------------------------------------------
        // 场景 A：第一阶段超限（LLM 调用后立即发现超出预算）
        // ------------------------------------------------------------------
        // `pendingBudgetExceeded` 在第一阶段被设置为 true。此时：
        //   - 工具已经执行完毕
        //   - tool_result 事件已 yield
        //   - tool_result user 消息已追加到 conversationMessages
        // 历史已经是完整的。现在可以安全退出，不必继续下一轮循环。
        // ------------------------------------------------------------------
        // 场景 B：因本轮产生的委托调用（子 Agent）导致超限
        // ------------------------------------------------------------------
        // 有些工具（例如 delegate_to_agent）会在执行过程中调用子 Agent，并产生额外的
        // token 消耗。这些消耗在工具执行完成后才通过 `ex.delegationUsage` 汇总到
        // `totalUsage` 中。因此即使第一阶段没有超限，加上委托 token 后可能超限。
        if (pendingBudgetExceeded) {
          break
        }
        if (delegationTurnUsage !== undefined && this.options.maxTokenBudget !== undefined) {
          const totalAfterDelegation = totalUsage.input_tokens + totalUsage.output_tokens
          if (totalAfterDelegation > this.options.maxTokenBudget) {
            budgetExceeded = true
            finalOutput = turnText
            yield {
              type: 'budget_exceeded',
              data: new TokenBudgetExceededError(
                this.options.agentName ?? 'unknown',
                totalAfterDelegation,
                this.options.maxTokenBudget,
              ),
            } satisfies StreamEvent
            break
          }
        }

        // Loop back to Step 1 — send updated conversation to the LLM.
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error } satisfies StreamEvent
      return
    }

    // If the loop exited due to maxTurns, use whatever text was last emitted.
    if (finalOutput === '' && conversationMessages.length > 0) {
      const lastAssistant = [...conversationMessages]
        .reverse()
        .find(m => m.role === 'assistant')
      if (lastAssistant !== undefined) {
        finalOutput = extractText(lastAssistant.content)
      }
    }

    const runResult: RunResult = {
      // Return only the messages added during this run (not the initial seed).
      messages: newMessages,
      output: finalOutput,
      toolCalls: allToolCalls,
      tokenUsage: totalUsage,
      turns,
      ...(loopDetected ? { loopDetected: true } : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
    }

    yield { type: 'done', data: runResult } satisfies StreamEvent
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Rule-based selective context compaction (no LLM calls).
   *
   * Compresses old turns while preserving the conversation skeleton:
   * - tool_use blocks (decisions) are always kept
   * - Long tool_result content is replaced with a compact marker
   * - Long assistant text blocks are truncated with an excerpt
   * - Error tool_results are never compressed
   * - Recent turns (within `preserveRecentTurns`) are kept intact
   *
   * 基于规则的选择性上下文压缩（无 LLM 调用）
   *
   * 当对话消息的预估 token 数超过 `strategy.maxTokens` 时，该方法对旧消息进行启发式压缩，
   * 同时保留关键的决策信息（tool_use 块），减少 token 消耗。
   *
   * 压缩原则：
   * - `tool_use` 块（代表 agent 的决策/行动意图）始终保留，不压缩
   * - 过长的 assistant 文本块被截断并添加省略标记
   * - 过长的 `tool_result` 内容被替换为紧凑的摘要标记（除非是错误结果或委托结果）
   * - 最近的 N 轮（`preserveRecentTurns`）保持完整不压缩
   * - 第一条 user 消息始终原样保留（通常包含用户原始问题/系统提示）
   * - 错误结果（`is_error: true`）绝不压缩
   * - `delegate_to_agent` 的结果也保留原样（父 agent 可能需要从中提取子 agent 的输出）
   * 
   * 
   * 原始消息: [firstUser] [oldTurn1] [oldTurn2] ... [recentTurns...]
   *        ↓
   *  1. 找出第一条 user 消息 (永久保留)
   *  2. 从尾部向前保留最近 preserveRecentTurns 轮完整对话（assistant+user 对）
   *  3. 对中间区域的消息进行压缩：
   *    - assistant: 保留 tool_use，截断长文本，[Image compacted]
   *    - user: 保留短 tool_result 和错误/委托结果，将长结果改为标记
   *  4. 返回压缩后的数组，可能完全未变（anyChanged = false）
   * @param messages 原始消息数组
   * @param strategy 压缩策略配置（type: 'compact'）
   * @returns 压缩后的消息数组（如果没有实际压缩则返回原数组）
   */
  private compactMessages(
    messages: LLMMessage[],
    strategy: Extract<ContextStrategy, { type: 'compact' }>,
  ): LLMMessage[] {
    const estimated = estimateTokens(messages)
    if (estimated <= strategy.maxTokens) {
      return messages
    }

    const preserveRecent = strategy.preserveRecentTurns ?? 4
    const minToolResultChars = strategy.minToolResultChars ?? 200
    const minTextBlockChars = strategy.minTextBlockChars ?? 2000
    const textBlockExcerptChars = strategy.textBlockExcerptChars ?? 200

    // Find the first user message — it is always preserved as-is.
    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return messages
    }

    // Walk backward to find the boundary between old and recent turns.
    // A "turn pair" is an assistant message followed by a user message.
    let boundary = messages.length
    let pairsFound = 0
    for (let i = messages.length - 1; i > firstUserIndex && pairsFound < preserveRecent; i--) {
      if (messages[i]!.role === 'user' && i > 0 && messages[i - 1]!.role === 'assistant') {
        pairsFound++
        boundary = i - 1
      }
    }

    // If all turns fit within the recent window, nothing to compact.
    if (boundary <= firstUserIndex + 1) {
      return messages
    }

    // Build a tool_use_id → tool name lookup from old assistant messages.
    const toolNameMap = new Map<string, string>()
    for (let i = firstUserIndex + 1; i < boundary; i++) {
      const msg = messages[i]!
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name)
        }
      }
    }

    // Process old messages (between first user and boundary).
    let anyChanged = false
    const result: LLMMessage[] = []

    for (let i = 0; i < messages.length; i++) {
      // First user message and recent messages: keep intact.
      if (i <= firstUserIndex || i >= boundary) {
        result.push(messages[i]!)
        continue
      }

      const msg = messages[i]!
      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (msg.role === 'assistant') {
          // tool_use blocks: always preserve (decisions).
          if (block.type === 'tool_use') return block
          // Long text blocks: truncate with excerpt.
          if (block.type === 'text' && block.text.length >= minTextBlockChars) {
            msgChanged = true
            return {
              type: 'text',
              text: `${block.text.slice(0, textBlockExcerptChars)}... [truncated — ${block.text.length} chars total]`,
            } satisfies TextBlock
          }
          // Image blocks in old turns: replace with marker.
          if (block.type === 'image') {
            msgChanged = true
            return { type: 'text', text: '[Image compacted]' } satisfies TextBlock
          }
          return block
        }

        // User messages in old zone.
        if (block.type === 'tool_result') {
          // Error results: always preserve.
          if (block.is_error) return block
          // Already compressed by compressToolResults or a prior compact pass.
          if (
            block.content.startsWith('[Tool output compressed') ||
            block.content.startsWith('[Tool result:')
          ) {
            return block
          }
          // Short results: preserve.
          if (block.content.length < minToolResultChars) return block
          const toolName = toolNameMap.get(block.tool_use_id) ?? 'unknown'
          // Delegation results: preserve — parent agent may still reason over them.
          if (toolName === 'delegate_to_agent') return block
          // Compress.
          msgChanged = true
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: `[Tool result: ${toolName} — ${block.content.length} chars, compacted]`,
          } satisfies ToolResultBlock
        }
        return block
      })

      if (msgChanged) {
        anyChanged = true
        result.push({ role: msg.role, content: newContent } as LLMMessage)
      } else {
        result.push(msg)
      }
    }

    return anyChanged ? result : messages
  }

  /**
   * Replace consumed tool results with compact markers.
   *
   * A tool_result is "consumed" when the assistant has produced a response
   * after seeing it (i.e. there is an assistant message following the user
   * message that contains the tool_result).  The most recent user message
   * with tool results is always kept intact — the LLM is about to see it.
   *
   * Error results and results shorter than `minChars` are never compressed.
   *
    * --------------------------------------------------------------------------
    * 目的：在每轮循环开始前，将那些“已经被 LLM 看过的”长 tool_result 替换为简短标记，
    *       从而减少后续消息的 token 占用。
    *
    * 判断“已消费”的逻辑：
    *   - 假设对话序列为：... user(tool_result) → assistant(响应) → ...
    *   - 当 assistant 已经在 tool_result 之后生成了响应，那么这条 tool_result 就算“已消费”。
    *   - 最后一条带有 tool_result 的 user 消息（正准备喂给 LLM 的）**不被压缩**，
    *     因为 LLM 还没有机会看到它。
    *   - 该函数会在每一轮循环（除第一轮外）的开始时被调用，此时 conversationMessages
    *     中已经包含了上一轮追加的 assistant（可能带 tool_use）和 user(tool_result)，
    *     而最新的 user(tool_result) 正是 LLM 将在本轮看到的消息，所以它被排除在压缩之外。
    * --------------------------------------------------------------------------
    * */
  private compressConsumedToolResults(messages: LLMMessage[]): LLMMessage[] {
    const config = this.options.compressToolResults
    if (!config) return messages

    const minChars = typeof config === 'object'
      ? (config.minChars ?? DEFAULT_MIN_COMPRESS_CHARS)
      : DEFAULT_MIN_COMPRESS_CHARS

    // Find the last user message that carries tool_result blocks.
    let lastToolResultUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i]!.role === 'user' &&
        messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        lastToolResultUserIdx = i
        break
      }
    }

    // Nothing to compress if there's at most one tool-result user message.
    if (lastToolResultUserIdx <= 0) return messages

    // Build a tool_use_id → tool name map so we can exempt delegation results,
    // whose full output the parent agent may need to re-read in later turns.
    const toolNameMap = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolNameMap.set(block.id, block.name)
      }
    }

    let anyChanged = false
    const result = messages.map((msg, idx) => {
      // Only compress user messages that appear before the last one.
      if (msg.role !== 'user' || idx >= lastToolResultUserIdx) return msg

      const hasToolResult = msg.content.some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (block.type !== 'tool_result') return block

        // Never compress error results — they carry diagnostic value.
        if (block.is_error) return block

        // Never compress delegation results — the parent agent relies on the full sub-agent output.
        if (toolNameMap.get(block.tool_use_id) === 'delegate_to_agent') return block

        // Skip already-compressed results — avoid re-compression with wrong char count.
        if (block.content.startsWith('[Tool output compressed')) return block

        // Skip short results — the marker itself has overhead.
        if (block.content.length < minChars) return block

        msgChanged = true
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: `[Tool output compressed — ${block.content.length} chars, already processed]`,
        } satisfies ToolResultBlock
      })

      if (msgChanged) {
        anyChanged = true
        return { role: msg.role, content: newContent } as LLMMessage
      }
      return msg
    })

    return anyChanged ? result : messages
  }

  /**
   * Build the {@link ToolUseContext} passed to every tool execution.
   * Identifies this runner as the invoking agent.
   */
  /**
   * --------------------------------------------------------------------------
   * 构建工具执行上下文对象
   * --------------------------------------------------------------------------
   *
   * 该方法的职责是创建 ToolUseContext 对象，该对象会在每个工具被调用时作为
   * 执行环境的一部分传递给工具。工具可以使用这个上下文来了解：
   *   - 是哪个 Agent 发起了本次调用（agent 信息）
   *   - 是否应该提前终止（abortSignal）
   *   - 当前是否在多 Agent 协作环境中（team 信息）
   *
   * 为什么需要这个上下文？
   *   - 有些工具需要知道调用者的身份，例如 delegate_to_agent 工具需要知道
   *     当前 Agent 的名称和模型，以便正确委派子任务。
   *   - 支持可取消的长时运行工具：abortSignal 允许工具在外部取消时提前退出。
   *   - 支持团队协作场景：team 信息可以让工具知道兄弟 Agent 的存在，从而实现
   *     路由或信息共享。
   *
   * 返回值结构 ToolUseContext：
   *   - agent: 当前 Agent 的身份描述
   *       - name: Agent 显示名称（默认为 'runner'）
   *       - role: 角色描述（默认为 'assistant'，可用于系统提示中的身份说明）
   *       - model: 当前使用的 LLM 模型标识（例如 'claude-opus-4-6'）
   *   - abortSignal: 可选的 AbortSignal，工具执行时可检查是否已中止
   *   - team: 可选的团队信息，包含团队成员列表、当前 Agent 在团队中的角色等。
   *           仅在 Orchestrator 运行 Team 时才会注入。
   *
   * 优先级规则：
   *   - abortSignal 优先使用 RunOptions 中传入的，若未提供则回退到 RunnerOptions
   *     中的静态 abortSignal。这使得调用方可以为单次运行设置独立的超时控制。
   *   - team 信息只在调用方显式传递时才会出现在上下文中，保证非团队场景下
   *     工具不会意外依赖团队信息。
   *
   * 使用场景示例：
   *   1. 文件读写工具：可以检查 abortSignal，在外部取消时停止读取大文件。
   *   2. delegate_to_agent 工具：读取 agent.name 和 agent.model，决定委派给
   *      哪个子 Agent 以及使用什么模型配置。
   *   3. 日志工具：记录是哪个 Agent 发起了调用，便于调试。
   *
   * 注意：
   *   - 该方法是私有方法，仅供 AgentRunner 内部使用，在每次并行执行工具前调用。
   *   - 返回的对象是浅拷贝（直接使用 options 中的引用），工具不应修改此对象，
   *     但可以安全地读取其属性。
   * --------------------------------------------------------------------------
   */
  private buildToolContext(options: RunOptions = {}): ToolUseContext {
    return {
      agent: {
        name: this.options.agentName ?? 'runner',
        role: this.options.agentRole ?? 'assistant',
        model: this.options.model,
      },
      abortSignal: options.abortSignal ?? this.options.abortSignal,
      ...(options.team !== undefined ? { team: options.team } : {}),
    }
  }
}
