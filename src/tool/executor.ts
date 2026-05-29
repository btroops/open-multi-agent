/**
 * 并行工具执行器，支持并发控制和错误隔离。
 *
 * 功能特性：
 * - 通过 Zod schema 验证输入
 * - 可选地通过 `tool.outputSchema` 验证工具输出
 * - 使用轻量级信号量（Semaphore）强制执行最大并发限制
 * - 将所有执行错误以 `ToolResult` 对象形式返回，而不是抛出异常
 *
 * 类型从 `../types` 导入，确保与框架其余部分的一致性。
 */

// 导入框架中定义的核心类型：工具执行结果和工具调用上下文
import type { ToolResult, ToolUseContext } from '../types.js'
// 导入工具定义类型（包含 name, execute, inputSchema 等）
import type { ToolDefinition } from '../types.js'
// 导入工具注册表，用于根据名称查找工具定义
import { ToolRegistry } from './framework.js'
// 导入信号量工具，用于控制并发数量
import { Semaphore } from '../utils/semaphore.js'
// 导入 Zod 的 schema 类型，用于输入/输出校验
import type { ZodSchema } from 'zod'

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

/**
 * ToolExecutor 的配置选项接口。
 */
export interface ToolExecutorOptions {
  /**
   * 可同时执行的最大工具调用数量。
   * 默认值为 4。
   */
  maxConcurrency?: number

  /**
   * 代理（Agent）级别的工具输出最大字符数默认值。
   * 工具自身的 `maxOutputChars` 配置优先级高于此值。
   */
  maxToolOutputChars?: number
}

/**
 * 描述一个批量工具调用项。
 * 用于向 ToolExecutor 提交多个并发调用。
 */
export interface BatchToolCall {
  /** 调用方分配的 ID，将作为结果映射中的键（key） */
  id: string

  /** 已注册的工具名称 */
  name: string

  /** 来自 LLM 的原始（未解析）输入对象 */
  input: Record<string, unknown>
}

/**
 * 从 {@link ToolRegistry} 执行工具，针对每个工具使用其 Zod schema 验证输入，
 * 并在批量执行时强制执行并发限制。
 *
 * 所有错误（包括未知工具名称、Zod 验证失败、执行异常）都会被捕获并作为
 * `ToolResult` 对象返回，且 `isError: true`，以便代理运行器将它们转发给 LLM。
 */
export class ToolExecutor {
  // 私有字段：工具注册表，用于根据名称获取工具定义
  private readonly registry: ToolRegistry
  // 私有字段：信号量，用于控制并发执行数量
  private readonly semaphore: Semaphore
  // 私有字段：代理级别的最大输出字符数（可能为 undefined）
  private readonly maxToolOutputChars?: number

  // 构造函数：接收一个 ToolRegistry 实例和可选的配置选项
  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    // 存储注册表引用
    this.registry = registry
    // 创建信号量，并发数默认为 4（如果未提供则使用默认值）
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4)
    // 存储代理级别的输出字符限制
    this.maxToolOutputChars = options.maxToolOutputChars
  }

  // -------------------------------------------------------------------------
  // 单个工具执行
  // -------------------------------------------------------------------------

  /**
   * 根据名称执行单个工具。
   *
   * 错误会被捕获并作为带有 `isError: true` 的 {@link ToolResult} 返回 ——
   * 此方法本身永远不会 reject。
   *
   * @param toolName  已注册的工具名称
   * @param input     原始输入对象（Zod 验证之前）
   * @param context   传递给工具的执行上下文
   */
  async execute(
    toolName: string,                 // 参数：工具名称
    input: Record<string, unknown>,   // 参数：原始输入对象
    context: ToolUseContext,          // 参数：执行上下文
  ): Promise<ToolResult> {           // 返回值：Promise 包装的 ToolResult
    // 根据名称从注册表中获取工具定义
    const tool = this.registry.get(toolName)
    // 如果未找到工具，返回错误结果
    if (tool === undefined) {
      // 返回一个描述“工具未注册”的错误结果
      return this.errorResult(
        `Tool "${toolName}" is not registered in the ToolRegistry.`,
      )
    }

    // 即使尚未开始执行，也要检查中止信号
    if (context.abortSignal?.aborted === true) {
      // 如果已中止，返回“执行前已中止”的错误结果
      return this.errorResult(
        `Tool "${toolName}" was aborted before execution began.`,
      )
    }

    // 调用私有方法实际执行工具（包含校验、执行、截断等完整流程）
    return this.runTool(tool, input, context)
  }

  // -------------------------------------------------------------------------
  // 批量执行
  // -------------------------------------------------------------------------

  /**
   * 并行执行多个工具调用，同时遵守并发限制。
   *
   * 返回一个从调用 ID 到结果的 `Map`。`calls` 中的每个调用都保证会产生一个条目 ——
   * 错误也会被捕获为结果。
   *
   * @param calls    要执行的工具调用数组
   * @param context  此批次中所有调用共享的执行上下文
   */
  async executeBatch(
    calls: BatchToolCall[],           // 参数：批量调用项数组
    context: ToolUseContext,          // 参数：共享的执行上下文
  ): Promise<Map<string, ToolResult>> { // 返回值：Promise 包装的 ID→结果 Map
    // 创建一个空的 Map 用于存储结果
    const results = new Map<string, ToolResult>()

    // 使用 Promise.all 并发处理所有调用，但通过信号量控制实际并发数
    await Promise.all(
      // 将每个调用项映射为一个异步任务
      calls.map(async (call) => {
        // 通过信号量运行：确保同时只有有限数量的工具在执行
        const result = await this.semaphore.run(() =>
          // 内部调用单个执行方法（重复使用 execute 的逻辑）
          this.execute(call.name, call.input, context),
        )
        // 将结果存入 Map，键为调用时指定的 id
        results.set(call.id, result)
      }),
    )

    // 返回填充完成的 Map
    return results
  }

  // -------------------------------------------------------------------------
  // 私有辅助方法
  // -------------------------------------------------------------------------

  /**
   * 使用工具的 Zod schema 验证输入，然后调用 `execute`。
   *
   * 当配置了 `tool.outputSchema` 且工具返回的是 **非错误** 结果时，
   * 会在截断之前根据 schema 验证 `result.data`。错误结果原样转发，
   * 以便 LLM 仍然能看到原始的失败消息。
   *
   * 由工具抛出的任何同步或异步错误都会被捕获并转换为错误 {@link ToolResult}，
   * 而不是向外传播。
   */
  private async runTool(
    // 工具定义（任意输入类型，使用 eslint 忽略 any 警告）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,        // 参数：工具定义对象
    rawInput: Record<string, unknown>, // 参数：原始（未解析）输入
    context: ToolUseContext,           // 参数：执行上下文
  ): Promise<ToolResult> {             // 返回值：Promise 包装的 ToolResult

    // --- Zod 输入验证 ---
    // 调用 runZodSchema 对输入进行校验
    const inputParseResult = this.runZodSchema(tool.inputSchema, rawInput)
    // 如果验证失败（success === false）
    if (!inputParseResult.success) {
      // 返回一个格式化的错误结果，包含所有验证问题描述
      return this.errorResult(
        `Invalid input for tool "${tool.name}":\n${inputParseResult.issuesMessage}`,
      )
    }

    // --- 验证完成后再次检查中止信号（因为验证可能耗时） ---
    if (context.abortSignal?.aborted === true) {
      // 如果已中止，返回“执行前已中止”的错误结果
      return this.errorResult(
        `Tool "${tool.name}" was aborted before execution began.`,
      )
    }

    // --- 执行工具 ---
    try {
      // 调用工具的实际执行函数，传入解析后的数据和上下文
      const result = await tool.execute(inputParseResult.data, context)
      // 如果工具未报告错误，并且工具定义了 outputSchema
      if (!result.isError && tool.outputSchema) {
        // 对输出数据进行 Zod 验证
        const outputParseResult = this.runZodSchema(tool.outputSchema, result.data)
        // 如果输出验证失败
        if (!outputParseResult.success) {
          // 返回一个错误结果，描述输出验证失败的原因
          return this.errorResult(
            `Invalid output for tool "${tool.name}":\n${outputParseResult.issuesMessage}`,
          )
        }
      }
      // 根据配置对输出进行截断（如果需要），然后返回结果
      return this.maybeTruncate(tool, result)
    } catch (err) {
      // 捕获工具执行过程中抛出的任何错误（同步或异步）
      // 将错误转换为字符串形式的消息
      const message =
        err instanceof Error   // 如果是 Error 实例，取其 message
          ? err.message
          : typeof err === 'string'  // 如果是字符串，直接使用
            ? err
            : JSON.stringify(err)    // 其他类型，转为 JSON 字符串
      // 返回错误结果（同时可能截断，但错误消息通常不长）
      return this.maybeTruncate(tool, this.errorResult(`Tool "${tool.name}" threw an error: ${message}`))
    }
  }

  /**
   * 运行 Zod schema 并返回解析结果；如果失败，附加一个扁平的问题字符串。
   * @param schema - Zod schema 对象
   * @param rawInput - 要验证的原始输入
   * @returns 如果成功：{ success: true, data: T }；如果失败：{ success: false, error: ZodError, issuesMessage: string }
   */
  private runZodSchema<T>(schema: ZodSchema<T>, rawInput: T) {
    // 调用 safeParse 进行安全解析（不抛出异常）
    const parseResult = schema.safeParse(rawInput)
    // 如果解析失败
    if (!parseResult.success) {
      // 将 Zod 错误问题列表格式化为人类可读的字符串
      const issuesMessage = parseResult.error.issues
        .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`) // 每个问题一行，缩进 + 路径 + 消息
        .join('\n')  // 用换行符连接所有问题
      // 返回原始 parseResult 的扩展，增加 issuesMessage 字段
      return {
        ...parseResult,
        issuesMessage,
      }
    }
    // 如果成功，直接返回 parseResult（它包含 success: true 和 data）
    return parseResult
  }

  /**
   * 如果配置了字符限制，对工具结果进行截断。
   * 优先级：工具自身的 `maxOutputChars` > 代理级别的 `maxToolOutputChars`。
   *
   * @param tool    工具定义（可能包含工具级别的 maxOutputChars）
   * @param result  原始的工具结果
   * @returns 可能被截断后的工具结果
   */
  private maybeTruncate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: ToolDefinition<any>,  // 参数：工具定义
    result: ToolResult,         // 参数：原始工具结果
  ): ToolResult {               // 返回值：截断后（或未截断）的结果
    // 决定最大字符数：优先使用工具级别，否则使用代理级别
    const maxChars = tool.maxOutputChars ?? this.maxToolOutputChars
    // 如果没有限制，或限制 ≤0，或结果数据的长度未超过限制，则直接返回原结果
    if (maxChars === undefined || maxChars <= 0 || result.data.length <= maxChars) {
      return result
    }
    // 否则，返回一个新的结果对象，其中 data 字段被截断
    return { ...result, data: truncateToolOutput(result.data, maxChars) }
  }

  /**
   * 构造一个错误类型的 ToolResult。
   * @param message - 错误消息（会放入 data 字段）
   * @returns 一个 isError 为 true 的 ToolResult 对象
   */
  private errorResult(message: string): ToolResult {
    return {
      data: message,    // 错误消息作为数据
      isError: true,    // 标记为错误
    }
  }
}

// ---------------------------------------------------------------------------
// 截断辅助函数
// ---------------------------------------------------------------------------

/**
 * 将工具输出截断以适应 `maxChars` 字符限制，保留开头（约70%）和结尾（约30%），
 * 并添加一个标记，指示有多少字符被移除。
 *
 * 标记本身也会计入预算，因此返回的字符串永远不会超过 `maxChars`。
 * 当 `maxChars` 太小以至于无法容纳任何内容与标记同时存在时，将返回仅包含标记的字符串。
 *
 * @param data - 要截断的原始字符串
 * @param maxChars - 允许的最大字符数
 * @returns 截断后的字符串
 */
export function truncateToolOutput(data: string, maxChars: number): string {
  // 如果原始数据长度已经 ≤ 限制，直接返回原始数据，无需截断
  if (data.length <= maxChars) return data

  // 估算标记的长度（数字位数可能在减去内容后减少，
  // 但使用原始 data.length 给出的数字位数是一个安全的上限）。
  const markerTemplate = '\n\n[...truncated  characters...]\n\n'  // 标记模板，其中留有数字占位符
  const markerOverhead = markerTemplate.length + String(data.length).length  // 标记总开销 = 模板长度 + 原始数据长度数字的字符数

  // 当最大字符数太小，无法容纳任何内容与标记一起时，
  // 回退到硬切片，以确保结果永远不会超过 maxChars。
  if (maxChars <= markerOverhead) {
    return data.slice(0, maxChars)  // 直接截取前 maxChars 个字符，不添加标记
  }

  const available = maxChars - markerOverhead  // 扣除标记开销后，可用于内容的字符数
  const headChars = Math.floor(available * 0.7)  // 保留开头部分占可用字符的 70%（向下取整）
  const tailChars = available - headChars         // 保留结尾部分占剩余可用字符（约30%）
  const truncatedCount = data.length - headChars - tailChars  // 实际被截断移除的字符数（原始长度 - 开头保留 - 结尾保留）

  // 返回由三部分组成的字符串：开头部分 + 标记（含被截断的字符数） + 结尾部分
  return `${data.slice(0, headChars)}\n\n[...truncated ${truncatedCount} characters...]\n\n${data.slice(-tailChars)}`
}