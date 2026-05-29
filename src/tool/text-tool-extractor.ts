/**
 * @fileoverview 本地模型的回退工具调用提取器。
 *
 * 当本地模型（Ollama, vLLM, LM Studio）以纯文本形式返回工具调用，而不是使用 OpenAI 的 `tool_calls` 线格式时，
 * 此模块尝试从文本输出中提取它们。
 *
 * 常见场景：
 * - Ollama 思维模型 bug：工具调用 JSON 最终出现在未闭合的 `<think>` 标签内
 * - 模型输出原始 JSON 工具调用，而服务器未解析它们
 * - 模型将工具调用包裹在 Markdown 代码块中
 * - Hermes 格式的 `<tool_call>` 标签
 *
 * 这是一个 **安全网**，不是首选路径。来自服务器的原生 `tool_calls` 总是优先使用。
 */

// 导入框架中的工具使用块类型（ToolUseBlock）
import type { ToolUseBlock } from '../types.js'

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

// 调用计数器，用于生成唯一的工具调用 ID
let callCounter = 0

/** 为提取出的调用生成一个唯一的工具调用 ID。 */
function generateToolCallId(): string {
  // 格式：extracted_call_时间戳_自增序号
  return `extracted_call_${Date.now()}_${++callCounter}`
}

// ---------------------------------------------------------------------------
// 内部解析器
// ---------------------------------------------------------------------------

/**
 * 尝试将单个 JSON 对象解析为工具调用。
 *
 * 接受的形状：
 * ```json
 * { "name": "bash", "arguments": { "command": "ls" } }
 * { "name": "bash", "parameters": { "command": "ls" } }
 * { "function": { "name": "bash", "arguments": { "command": "ls" } } }
 * ```
 * @param json - 待解析的 JSON 对象（任意类型）
 * @param knownToolNames - 已知工具名称的白名单（Set）
 * @returns 解析成功返回 ToolUseBlock，否则返回 null
 */
function parseToolCallJSON(
  json: unknown,  // 待解析的 JSON 数据
  knownToolNames: ReadonlySet<string>,  // 只读的工具名集合
): ToolUseBlock | null {  // 返回值：工具使用块或 null
  // 如果 json 为 null、不是对象、或者是数组，则直接返回 null
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return null
  }

  // 将 json 断言为 Record<string, unknown> 类型，以便访问属性
  const obj = json as Record<string, unknown>

  // 形状：{ function: { name, arguments } }
  // 如果存在 'function' 字段且它是一个非 null 对象
  if (typeof obj['function'] === 'object' && obj['function'] !== null) {
    const fn = obj['function'] as Record<string, unknown>  // 获取 function 对象
    return parseFlat(fn, knownToolNames)  // 扁平化解析
  }

  // 形状：{ name, arguments|parameters }
  // 直接尝试扁平化解析
  return parseFlat(obj, knownToolNames)
}

/**
 * 解析扁平化的工具调用对象。
 * @param obj - 包含 name 和 arguments/parameters 的对象
 * @param knownToolNames - 已知工具名集合
 * @returns 解析成功返回 ToolUseBlock，否则 null
 */
function parseFlat(
  obj: Record<string, unknown>,  // 待解析的对象
  knownToolNames: ReadonlySet<string>,  // 已知工具名集合
): ToolUseBlock | null {  // 返回值：工具使用块或 null
  const name = obj['name']  // 获取 name 字段
  // 如果 name 不是非空字符串，则无效
  if (typeof name !== 'string' || name.length === 0) return null

  // 白名单检查 — 如果已知工具名集合非空，且当前 name 不在白名单中，则拒绝将其视为工具调用
  if (knownToolNames.size > 0 && !knownToolNames.has(name)) return null

  let input: Record<string, unknown> = {}  // 初始化输入对象（默认为空对象）
  // 获取参数对象：优先级 arguments > parameters > input
  const args = obj['arguments'] ?? obj['parameters'] ?? obj['input']
  // 如果 args 存在且不为 undefined
  if (args !== null && args !== undefined) {
    if (typeof args === 'string') {  // 如果 args 是字符串，尝试 JSON 解析
      try {
        const parsed = JSON.parse(args)  // 解析 JSON 字符串
        // 如果解析结果是对象且非 null 且不是数组，则赋值给 input
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // 格式错误 — 使用空输入（不做处理）
      }
    } else if (typeof args === 'object' && !Array.isArray(args)) {  // 如果 args 已经是对象且不是数组
      input = args as Record<string, unknown>  // 直接使用
    }
  }

  // 返回一个符合 ToolUseBlock 接口的对象
  return {
    type: 'tool_use',                // 固定类型 'tool_use'
    id: generateToolCallId(),        // 生成唯一 ID
    name,                            // 工具名称
    input,                           // 解析后的输入参数
  }
}

// ---------------------------------------------------------------------------
// 从文本中提取 JSON
// ---------------------------------------------------------------------------

/**
 * 通过跟踪花括号深度查找字符串中的所有顶层 JSON 对象。
 * 返回解析后的对象（不包括子对象）。
 * @param text - 输入文本
 * @returns 解析出的 JSON 对象数组
 */
function extractJSONObjects(text: string): unknown[] {
  const results: unknown[] = []  // 存储结果的数组
  let depth = 0                   // 花括号深度计数
  let start = -1                  // 当前 JSON 对象的起始索引
  let inString = false            // 是否在字符串字面量内（避免解析字符串内的花括号）
  let escape = false              // 是否遇到转义字符（如 \"）

  // 遍历文本中的每个字符
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!           // 当前字符（非空断言，因为 i 在范围内）

    // 如果处于转义状态，跳过当前字符（不处理），并重置转义标志
    if (escape) {
      escape = false
      continue
    }

    // 如果当前字符是反斜杠且处于字符串内，标记转义
    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    // 如果遇到双引号，切换字符串内标志
    if (ch === '"') {
      inString = !inString
      continue
    }

    // 如果当前在字符串内，跳过所有处理（直接继续循环）
    if (inString) continue

    // 遇到左花括号 {
    if (ch === '{') {
      if (depth === 0) start = i  // 如果深度为 0，标记这是新 JSON 对象的开始
      depth++                      // 深度增加
    } 
    // 遇到右花括号 }
    else if (ch === '}') {
      // 孤立的 `}` 出现在任何未打开对象之外（例如文字中包含 "${var}" 但 `${` 前缀被截断，或者模型引用了不平衡的文本）
      // 忽略它可以使深度保持非负 — 否则 `depth === 0` 的锚点无法为下一个 `{` 重新触发，
      // 并且后续任何有效的 JSON 工具调用都会被跳过（或它们的内部子对象被错误提取，而子对象没有 `name` 字段，会被静默拒绝）
      if (depth === 0) continue    // 如果深度已经是 0，忽略这个右花括号，防止深度变负
      depth--                      // 深度减少
      // 如果深度归零并且起始索引有效，则提取一个完整的 JSON 对象
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1)  // 从 start 到 i 的子串
        try {
          results.push(JSON.parse(candidate))       // 尝试解析 JSON，成功则加入结果数组
        } catch {
          // 不是有效的 JSON — 跳过
        }
        start = -1  // 重置起始索引
      }
    }
  }

  return results  // 返回所有成功解析的 JSON 对象数组
}

// ---------------------------------------------------------------------------
// Hermes 格式：<tool_call>...</tool_call>
// ---------------------------------------------------------------------------

/**
 * 从文本中提取 Hermes 格式的工具调用。
 * @param text - 模型输出文本
 * @param knownToolNames - 已知工具名集合
 * @returns 工具使用块数组
 */
function extractHermesToolCalls(
  text: string,  // 输入文本
  knownToolNames: ReadonlySet<string>,  // 已知工具名集合
): ToolUseBlock[] {  // 返回工具使用块数组
  const results: ToolUseBlock[] = []  // 存储结果的数组

  // 使用正则表达式匹配所有 <tool_call> 标签，支持多行内容（[\s\S] 表示任意字符包括换行）
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const inner = match[1]!.trim()  // 获取标签内部的内容并去除首尾空白
    try {
      const parsed: unknown = JSON.parse(inner)  // 尝试将内容解析为 JSON
      const block = parseToolCallJSON(parsed, knownToolNames)  // 解析 JSON 为工具调用
      if (block !== null) results.push(block)   // 如果解析成功则加入结果
    } catch {
      // 格式错误的 Hermes 内容 — 跳过
    }
  }

  return results  // 返回所有成功提取的工具调用
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 尝试从模型的文本输出中提取工具调用。
 *
 * 按顺序尝试多种策略：
 * 1. Hermes `<tool_call>` 标签
 * 2. 文本中的 JSON 对象（裸 JSON 或在代码块内）
 *
 * @param text           - 模型的文本输出
 * @param knownToolNames - 已注册工具名称的白名单。当非空时，
 *                         只有 `name` 匹配已知工具名称的 JSON 对象才会被视为工具调用。
 * @returns 提取出的 {@link ToolUseBlock} 数组，如果没有找到则返回空数组。
 */
export function extractToolCallsFromText(
  text: string,                 // 模型输出的文本
  knownToolNames: string[],     // 已知工具名称数组（白名单）
): ToolUseBlock[] {             // 返回工具使用块数组
  // 如果文本为空，直接返回空数组
  if (text.length === 0) return []

  // 将数组转换为 Set 以便快速查找
  const nameSet = new Set(knownToolNames)

  // 策略 1：Hermes 格式
  const hermesResults = extractHermesToolCalls(text, nameSet)
  // 如果找到 Hermes 格式的调用，直接返回（不再尝试其他策略）
  if (hermesResults.length > 0) return hermesResults

  // 策略 2：去除代码块围栏，然后提取 JSON 对象
  // 使用正则去掉 ```json ... ``` 或 ``` ... ``` 代码块，保留内部内容
  const stripped = text.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g, '$1')
  // 从去除围栏后的文本中提取所有顶层 JSON 对象
  const jsonObjects = extractJSONObjects(stripped)

  const results: ToolUseBlock[] = []  // 存储最终结果的数组
  // 遍历每个 JSON 对象
  for (const obj of jsonObjects) {
    const block = parseToolCallJSON(obj, nameSet)  // 尝试解析为工具调用
    if (block !== null) results.push(block)        // 解析成功则加入结果
  }

  return results  // 返回所有提取到的工具调用
}