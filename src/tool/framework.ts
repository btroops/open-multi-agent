/**
 * 开放多智能体框架的工具定义模块。
 *
 * 提供用于声明、注册工具，并将其转换为 LLM API 所期望的 JSON Schema 格式的核心原语。
 *
 * 与框架其他部分共享的类型（`ToolDefinition`、`ToolResult`、`ToolUseContext`）
 * 从 `../types` 导入，确保单一事实来源。
 * 本文件重新导出这些类型，方便下游调用者只需从 `tool/framework` 导入即可。
 */

import { type ZodSchema } from 'zod'
import type {
  ToolDefinition,
  ToolResult,
  ToolUseContext,
  LLMToolDef,
} from '../types.js'

// 重新导出，以便消费者可以 `import { ToolDefinition } from './framework.js'`
export type { ToolDefinition, ToolResult, ToolUseContext }

// ---------------------------------------------------------------------------
// 面向 LLM 的 JSON Schema 类型
// ---------------------------------------------------------------------------

/**
 * 单个属性的最小 JSON Schema 描述。
 * 支持常见的 JSON Schema 类型以及 anyOf、const 等组合约束。
 * 用于在将 Zod schema 转换为 LLM 可接受的格式时，描述输入参数的形状。
 */
export type JSONSchemaProperty =
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; items: JSONSchemaProperty; description?: string }
  | {
      type: 'object'
      properties: Record<string, JSONSchemaProperty>
      required?: string[]
      description?: string
    }
  | { anyOf: JSONSchemaProperty[]; description?: string }
  | { const: unknown; description?: string }
  // 对于未显式建模的类型的回退（例如复杂组合）
  | Record<string, unknown>

// ---------------------------------------------------------------------------
// defineTool
// ---------------------------------------------------------------------------

/**
 * 定义一个类型安全的工具。
 * 这是创建可注册到 {@link ToolRegistry} 的工具的唯一入口。
 *
 * 返回的对象满足从 `../types` 导入的 {@link ToolDefinition} 接口。
 *
 * @example
 * ```ts
 * const echoTool = defineTool({
 *   name: 'echo',
 *   description: '将输入消息原样返回给调用者。',
 *   inputSchema: z.object({ message: z.string() }),
 *   execute: async ({ message }) => ({
 *     data: message,
 *     isError: false,
 *   }),
 * })
 * ```
 *
 * @typeParam TInput - 工具的输入类型，由 `inputSchema` 推导得出。
 * @param config - 工具配置对象。
 * @returns 一个满足 ToolDefinition<TInput> 接口的工具对象。
 */
export function defineTool<TInput>(config: {
  /**
   * 工具的唯一名称。
   * 在调用 LLM 时用于标识哪个工具被调用。
   */
  name: string

  /**
   * 工具的描述信息。
   * 会被发送给 LLM，帮助模型决定何时以及如何使用该工具。
   */
  description: string

  /**
   * 定义工具输入参数的 Zod schema。
   * 用于运行时校验输入数据，并自动生成 JSON Schema 供 LLM 使用。
   */
  inputSchema: ZodSchema<TInput>

  /**
   * 可选的输出校验 schema。
   * 当提供时，会在 `execute` 返回后对 `ToolResult.data`（必须是字符串）进行校验。
   * 由于 `ToolResult.data` 固定为 `string` 类型，因此该 schema 必须是 `ZodSchema<string>`。
   * 可以使用 `z.string().refine(...)` 或 `z.string().regex(...)` 等方式强制约束序列化后的输出格式。
   *
   * 若不提供，则跳过输出校验。
   */
  outputSchema?: ZodSchema<string>

  /**
   * 可选的显式 JSON Schema，用于直接提供给 LLM。
   * 当提供时，框架会使用此 schema 而不是从 `inputSchema` 自动转换的结果。
   * 适用于需要精确控制 LLM 看到的参数描述的场合。
   */
  llmInputSchema?: Record<string, unknown>

  /**
   * 工具级别的最大输出字符数。
   * 当工具返回的字符串超过此限制时，会被截断（保留开头和结尾，中间插入标记）。
   * 该值优先于 agent 级别的 `maxToolOutputChars` 配置。
   */
  maxOutputChars?: number

  /**
   * 工具的核心执行逻辑。
   * 当 LLM 决定调用该工具时，会调用此函数。
   *
   * @param input - 经过 `inputSchema` 解析和校验后的输入参数。
   * @param context - 工具执行上下文，包含会话 ID、取消信号等辅助信息。
   * @returns 一个 Promise，解析为 {@link ToolResult} 对象。
   */
  execute: (input: TInput, context: ToolUseContext) => Promise<ToolResult>
}): ToolDefinition<TInput> {
  // 返回一个符合 ToolDefinition 接口的对象。
  // 使用展开运算符有条件地添加可选字段，避免产生 undefined 属性。
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.outputSchema !== undefined
      ? { outputSchema: config.outputSchema }
      : {}),
    ...(config.llmInputSchema !== undefined
      ? { llmInputSchema: config.llmInputSchema }
      : {}),
    ...(config.maxOutputChars !== undefined
      ? { maxOutputChars: config.maxOutputChars }
      : {}),
    execute: config.execute,
  }
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

/**
 * 工具注册表。
 * 持有一组命名的工具，并能够生成 LLM API（如 Anthropic、OpenAI）期望的 JSON Schema 表示。
 *
 * 该类是框架中管理工具的核心组件：支持注册、查询、注销工具，并将它们转换为
 * 适合不同 LLM 供应商的格式（如 OpenAI 的 function calling 或 Anthropic 的 tool use）。
 */
export class ToolRegistry {
  // 内部存储：工具名称 -> 工具定义（任意输入类型）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDefinition<any>>()
  // 记录哪些工具是在运行时动态添加的（例如通过 agent.addTool()）
  private readonly runtimeToolNames = new Set<string>()

  /**
   * 向注册表中添加一个工具。
   * 如果已存在同名工具，则抛出错误——防止静默覆盖。
   *
   * @param tool - 要注册的工具定义（通过 defineTool 创建）
   * @param options - 可选配置
   * @param options.runtimeAdded - 如果为 true，标记该工具为运行时动态添加
   * @throws 如果同名工具已存在
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(
    tool: ToolDefinition<any>,  // 参数：工具定义，支持任意输入类型
    options?: { runtimeAdded?: boolean },  // 可选参数：标记是否为运行时添加的工具
  ): void {  // 无返回值
    // 检查是否已存在同名工具
    if (this.tools.has(tool.name)) {
      // 抛出错误，包含明确的错误信息，提示用户使用唯一名称或先注销已存在的工具
      throw new Error(
        `ToolRegistry: a tool named "${tool.name}" is already registered. ` +
          'Use a unique name or deregister the existing one first.',
      )
    }
    // 将工具存入 Map，键为工具名称，值为工具定义
    this.tools.set(tool.name, tool)
    // 如果选项中标记了 runtimeAdded 为 true，则将该工具名称加入运行时工具集合
    if (options?.runtimeAdded === true) {
      this.runtimeToolNames.add(tool.name)
    }
  }

  /**
   * 根据名称获取工具定义。
   *
   * @param name - 工具名称
   * @returns 工具定义，如果未找到则返回 undefined
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): ToolDefinition<any> | undefined {  // 参数：工具名称；返回值：工具定义或 undefined
    // 直接从 Map 中根据键名获取值
    return this.tools.get(name)
  }

  /**
   * 返回所有已注册的工具定义数组。
   *
   * 如果只需要名称，可以写 `registry.list().map(t => t.name)`。
   * 该方法与 agent 的 `getTools()` 模式相匹配。
   *
   * @returns 工具定义数组
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): ToolDefinition<any>[] {  // 返回值：工具定义数组
    // 将 Map 中所有的值（工具定义）转换为数组并返回
    return Array.from(this.tools.values())
  }

  /**
   * 返回所有已注册的工具定义数组。
   * {@link list} 的别名 —— 供偏好显式命名的调用者使用。
   *
   * @returns 工具定义数组
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAll(): ToolDefinition<any>[] {  // 返回值：工具定义数组
    // 内部直接调用 list 方法，保持行为一致
    return Array.from(this.tools.values())
  }

  /**
   * 判断是否存在指定名称的工具。
   *
   * @param name - 工具名称
   * @returns 存在返回 true，否则 false
   */
  has(name: string): boolean {  // 参数：工具名称；返回值：布尔值
    // 委托给 Map 的 has 方法
    return this.tools.has(name)
  }

  /**
   * 移除指定名称的工具。
   * 如果工具未注册，则不进行任何操作 —— 这符合 agent 预期中 `removeTool` 的优雅行为。
   *
   * @param name - 要移除的工具名称
   */
  unregister(name: string): void {  // 参数：工具名称；无返回值
    // 从 Map 中删除工具
    this.tools.delete(name)
    // 同时从运行时工具集合中删除该名称（如果存在）
    this.runtimeToolNames.delete(name)
  }

  /**
   * {@link unregister} 的别名 —— 与 `register` 保持对称性。
   *
   * @param name - 要注销的工具名称
   */
  deregister(name: string): void {  // 参数：工具名称；无返回值
    // 直接调用 unregister 方法
    this.unregister(name)
  }

  /**
   * 将所有已注册的工具转换为 LLM 适配器所需的 {@link LLMToolDef} 格式。
   * 这是 agent 运行器在每次 LLM API 调用前调用的主要方法。
   *
   * 转换过程：
   * - 如果工具定义了 `llmInputSchema`，则直接使用它（跳过 Zod → JSON Schema 转换）。
   * - 否则，使用 `zodToJsonSchema` 将 `inputSchema` 转换为 JSON Schema。
   *
   * @returns LLM 工具定义数组（包含 name, description, inputSchema）
   */
  toToolDefs(): LLMToolDef[] {  // 返回值：LLM 工具定义数组
    // 将 Map 中所有工具定义映射为 LLMToolDef 格式
    return Array.from(this.tools.values()).map((tool) => {
      // 决定使用的 JSON Schema：优先使用显式提供的 llmInputSchema，否则自动转换
      const schema =
        tool.llmInputSchema ?? zodToJsonSchema(tool.inputSchema)
      // 返回符合 LLMToolDef 接口的对象
      return {
        name: tool.name,          // 工具名称
        description: tool.description,  // 工具描述
        inputSchema: schema,      // 输入参数的 JSON Schema
      } satisfies LLMToolDef      // 使用 satisfies 确保类型正确
    })
  }

  /**
   * 仅返回那些在运行时动态添加的工具（例如通过 `agent.addTool()` 添加），
   * 格式为 LLM 工具定义。
   *
   * @returns 运行时工具的 LLM 定义数组
   */
  toRuntimeToolDefs(): LLMToolDef[] {  // 返回值：LLM 工具定义数组（仅包含运行时添加的工具）
    // 先获取所有工具的 LLM 定义，然后过滤出那些名称在 runtimeToolNames 集合中的工具
    return this.toToolDefs().filter(tool => this.runtimeToolNames.has(tool.name))
  }

  /**
   * 将所有已注册的工具转换为 Anthropic 风格的 `input_schema` 格式。
   * 正常情况下优先使用 {@link toToolDefs}；此方法暴露给需要自行构造 API 载荷的调用者。
   *
   * Anthropic 工具格式要求：
   * - 每个工具对象包含 `name`, `description`, `input_schema`
   * - `input_schema` 必须包含 `type: "object"`，以及 `properties` 和可选的 `required` 字段。
   *
   * @returns Anthropic 风格的工具定义数组
   */
  toLLMTools(): Array<{  // 返回值：对象数组
    name: string         // 工具名称
    description: string  // 工具描述
    /** Anthropic 风格的工具输入 JSON Schema（`type` 通常为 `"object"`） */
    input_schema: Record<string, unknown>  // 输入 schema 对象
  }> {
    // 将 Map 中所有工具定义映射为 Anthropic 风格格式
    return Array.from(this.tools.values()).map((tool) => {
      // 如果工具提供了显式的 llmInputSchema（优先使用）
      if (tool.llmInputSchema !== undefined) {
        // 返回 Anthropic 格式，确保包含 type: "object"，并展开用户提供的 schema
        return {
          name: tool.name,                          // 工具名称
          description: tool.description,            // 工具描述
          input_schema: {                           // 输入 schema
            type: 'object' as const,                // 固定 type 为 "object"
            ...(tool.llmInputSchema as Record<string, unknown>),  // 合并用户提供的额外字段
          },
        }
      }
      // 否则从 Zod schema 自动转换得到 JSON Schema
      const schema = zodToJsonSchema(tool.inputSchema)
      // 返回 Anthropic 格式，从 schema 中提取 properties 和 required
      return {
        name: tool.name,                            // 工具名称
        description: tool.description,              // 工具描述
        input_schema: {                             // 输入 schema
          type: 'object' as const,                  // 固定 type 为 "object"
          properties:                               // 属性定义
            (schema.properties as Record<string, JSONSchemaProperty>) ?? {},  // 如果没有 properties 则使用空对象
          ...(schema.required !== undefined         // 如果 schema 中定义了 required 字段
            ? { required: schema.required as string[] }  // 则将其添加到 input_schema 中
            : {}),                                  // 否则不加 required 字段
        },
      }
    })
  }
}

// ---------------------------------------------------------------------------
// zodToJsonSchema
// ---------------------------------------------------------------------------

/**
 * 将 Zod schema 转换为普通的 JSON Schema 对象，适用于 LLM API 调用。
 *
 * 支持的 Zod 类型：
 *   z.string(), z.number(), z.boolean(), z.enum(), z.array(), z.object(),
 *   z.optional(), z.union(), z.literal(), z.describe(), z.nullable(),
 *   z.default(), z.intersection(), z.discriminatedUnion(), z.record(),
 *   z.tuple(), z.any(), z.unknown(), z.never(), z.effects() (transforms)
 *
 * 不支持的类型会回退为 `{}`（任意类型），这在 JSON Schema 中依然是有效的。
 *
 * @param schema - 要转换的 Zod schema
 * @returns 对应的 JSON Schema 对象（Record<string, unknown>）
 */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  // 直接调用内部递归转换函数
  return convertZodType(schema)
}

// 内部递归转换器。
// 我们访问 Zod 内部的 `_def` 结构，因为 Zod v3 没有内置的 JSON Schema 导出器。
// 注意：以下代码依赖 Zod 的内部实现细节，需谨慎适配未来版本。
function convertZodType(schema: ZodSchema): Record<string, unknown> {
  // 禁用 ESLint 的 any 警告，因为我们必须访问 Zod 私有的 `_def` 属性
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def as ZodTypeDef  // 获取 schema 的定义对象

  const description: string | undefined = def.description  // 提取描述信息（如果有）

  // 辅助函数：如果存在 description 则将其添加到结果对象中
  const withDesc = (result: Record<string, unknown>): Record<string, unknown> =>
    description !== undefined ? { ...result, description } : result  // 浅拷贝并添加 description 字段

  // 根据 Zod 内部类型名称进行分发处理
  switch (def.typeName) {
    // -----------------------------------------------------------------------
    // 原始类型
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodString:   // 字符串类型
      return withDesc({ type: 'string' })   // 返回 JSON Schema 的 type: 'string'

    case ZodTypeName.ZodNumber:   // 数字类型
      return withDesc({ type: 'number' })   // 返回 type: 'number'

    case ZodTypeName.ZodBigInt:   // BigInt 类型
      return withDesc({ type: 'integer' })  // 在 JSON Schema 中通常映射为 integer

    case ZodTypeName.ZodBoolean:  // 布尔类型
      return withDesc({ type: 'boolean' })  // 返回 type: 'boolean'

    case ZodTypeName.ZodNull:     // null 字面量类型
      return withDesc({ type: 'null' })     // 返回 type: 'null'

    case ZodTypeName.ZodUndefined: // undefined 类型
      return withDesc({ type: 'null' })     // 将 undefined 映射为 null（JSON Schema 无 undefined）

    case ZodTypeName.ZodDate:     // 日期类型
      return withDesc({ type: 'string', format: 'date-time' })  // 转为 ISO 日期时间字符串

    // -----------------------------------------------------------------------
    // 字面量
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodLiteral: { // 字面量类型（例如 z.literal("foo")）
      const literalDef = def as ZodLiteralDef  // 转为具体的字面量定义类型
      return withDesc({ const: literalDef.value })  // 使用 const 关键字表示固定的值
    }

    // -----------------------------------------------------------------------
    // 枚举
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodEnum: {   // Zod 枚举（z.enum(["a","b"])）
      const enumDef = def as ZodEnumDef       // 转为枚举定义
      return withDesc({ type: 'string', enum: enumDef.values })  // 字符串类型 + 枚举值列表
    }

    case ZodTypeName.ZodNativeEnum: { // TypeScript 原生枚举（z.nativeEnum(Enum)）
      const nativeEnumDef = def as ZodNativeEnumDef  // 转为原生枚举定义
      // 获取枚举的所有值，过滤出字符串或数字（忽略符号等）
      const values = Object.values(nativeEnumDef.values as object).filter(
        (v) => typeof v === 'string' || typeof v === 'number',
      )
      return withDesc({ enum: values })  // 注意：原生枚举可能混合类型，JSON Schema 允许 enum 包含不同基本类型
    }

    // -----------------------------------------------------------------------
    // 数组
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodArray: {  // 普通数组类型
      const arrayDef = def as ZodArrayDef  // 转为数组定义
      return withDesc({
        type: 'array',                      // JSON Schema 类型为数组
        items: convertZodType(arrayDef.type), // 递归转换数组元素的类型
      })
    }

    case ZodTypeName.ZodTuple: {  // 元组类型（固定长度、类型可异）
      const tupleDef = def as ZodTupleDef  // 转为元组定义
      return withDesc({
        type: 'array',                            // 类型为数组
        prefixItems: tupleDef.items.map(convertZodType), // 每个位置独立类型（JSON Schema 2019-09 的 prefixItems）
      })
    }

    // -----------------------------------------------------------------------
    // 对象
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodObject: { // 对象类型
      const objectDef = def as ZodObjectDef  // 转为对象定义
      const properties: Record<string, unknown> = {}  // 存储属性名到子 schema 的映射
      const required: string[] = []           // 存储必需属性名

      // 遍历对象的所有字段（shape 返回一个 Record<string, ZodTypeAny>）
      for (const [key, value] of Object.entries(objectDef.shape())) {
        properties[key] = convertZodType(value as ZodSchema)  // 递归转换每个字段的类型

        // 获取字段的内部定义，以判断是否为可选、默认值或可空
        const innerDef = ((value as ZodSchema) as unknown as { _def: ZodTypeDef })._def
        const isOptional =
          innerDef.typeName === ZodTypeName.ZodOptional ||   // 显式 optional
          innerDef.typeName === ZodTypeName.ZodDefault ||    // 有默认值的字段
          innerDef.typeName === ZodTypeName.ZodNullable      // 可空字段
        if (!isOptional) {   // 如果不是上述任何一种可选形式，则视为必需字段
          required.push(key)
        }
      }

      const result: Record<string, unknown> = { type: 'object', properties }  // 构造基本对象
      if (required.length > 0) result.required = required  // 仅在存在必需字段时添加 required 数组
      return withDesc(result)  // 附加描述后返回
    }

    case ZodTypeName.ZodRecord: { // 记录类型（z.record(keySchema, valueSchema)）
      const recordDef = def as ZodRecordDef  // 转为记录定义
      return withDesc({
        type: 'object',                                       // 类型为对象
        additionalProperties: convertZodType(recordDef.valueType),  // 值类型的 JSON Schema 用于 additionalProperties
      })
    }

    // -----------------------------------------------------------------------
    // 可选 / 可空 / 默认值
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodOptional: { // 可选类型
      const optionalDef = def as ZodOptionalDef  // 转为可选定义
      const inner = convertZodType(optionalDef.innerType)  // 递归转换内部类型
      // 可选类型不改变 inner 的结构，只可能附加 description（如果原 schema 有描述）
      return description !== undefined ? { ...inner, description } : inner
    }

    case ZodTypeName.ZodNullable: { // 可空类型（z.nullable()）
      const nullableDef = def as ZodNullableDef  // 转为可空定义
      const inner = convertZodType(nullableDef.innerType)  // 递归转换内部类型
      const type = inner.type  // 获取内部类型的 type 字段（可能是字符串）
      if (typeof type === 'string') {  // 如果内部类型是单一简单类型（如 "string"）
        // 将其改为联合类型：['string', 'null']
        return withDesc({ ...inner, type: [type, 'null'] })
      }
      // 对于复杂内部类型，使用 anyOf 组合
      return withDesc({ anyOf: [inner, { type: 'null' }] })
    }

    case ZodTypeName.ZodDefault: { // 带默认值的类型（z.default()）
      const defaultDef = def as ZodDefaultDef  // 转为默认值定义
      const inner = convertZodType(defaultDef.innerType)  // 递归转换内部类型
      // 添加 default 字段，值为默认值的计算结果（注意：defaultValue 是一个函数）
      return withDesc({ ...inner, default: defaultDef.defaultValue() })
    }

    // -----------------------------------------------------------------------
    // 联合 / 交叉 / 可辨识联合
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodUnion: {   // 联合类型（z.union([...])）
      const unionDef = def as ZodUnionDef  // 转为联合定义
      const options = (unionDef.options as ZodSchema[]).map(convertZodType)  // 转换每个成员
      return withDesc({ anyOf: options })  // JSON Schema 使用 anyOf 表示联合
    }

    case ZodTypeName.ZodDiscriminatedUnion: { // 可辨识联合（z.discriminatedUnion(key, ...)）
      const duDef = def as ZodDiscriminatedUnionDef  // 转为可辨识联合定义
      const options = (duDef.options as ZodSchema[]).map(convertZodType)  // 转换每个成员
      return withDesc({ anyOf: options })  // 同样使用 anyOf，但通常外部会利用 discriminator 优化，这里简化处理
    }

    case ZodTypeName.ZodIntersection: { // 交叉类型（z.intersection(A, B)）
      const intDef = def as ZodIntersectionDef  // 转为交叉定义
      return withDesc({
        allOf: [convertZodType(intDef.left), convertZodType(intDef.right)],  // 使用 allOf 组合
      })
    }

    // -----------------------------------------------------------------------
    // 包装器类型（透传内部类型）
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodEffects: { // 效果类型（z.transform, z.preprocess 等）
      const effectsDef = def as ZodEffectsDef  // 转为效果定义
      const inner = convertZodType(effectsDef.schema)  // 转换内部 schema（忽略变换逻辑）
      // 效果类型本身可能有描述，需要附加
      return description !== undefined ? { ...inner, description } : inner
    }

    case ZodTypeName.ZodBranded: { // 品牌类型（z.brand()）
      const brandedDef = def as ZodBrandedDef  // 转为品牌定义
      // 品牌只是名义上的，底层类型不变
      return withDesc(convertZodType(brandedDef.type))
    }

    case ZodTypeName.ZodReadonly: { // 只读类型（z.readonly()）
      const readonlyDef = def as ZodReadonlyDef  // 转为只读定义
      // 只读不影响 JSON Schema
      return withDesc(convertZodType(readonlyDef.innerType))
    }

    case ZodTypeName.ZodCatch: { // 捕获类型（z.catch()）
      const catchDef = def as ZodCatchDef  // 转为捕获定义
      // 捕获提供默认值，但 schema 仍以内层为准
      return withDesc(convertZodType(catchDef.innerType))
    }

    case ZodTypeName.ZodPipeline: { // 管道类型（z.pipe()）
      const pipelineDef = def as ZodPipelineDef  // 转为管道定义
      // 管道由多个 schema 顺序处理，取第一个（输入）即可
      return withDesc(convertZodType(pipelineDef.in))
    }

    // -----------------------------------------------------------------------
    // Any / Unknown – JSON Schema 通配符
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodAny:      // 任意类型
    case ZodTypeName.ZodUnknown:  // 未知类型
      return withDesc({})          // 空对象表示允许任意值

    case ZodTypeName.ZodNever:    // 永不存在的类型
      return withDesc({ not: {} }) // JSON Schema 中 not: {} 表示没有任何值满足

    case ZodTypeName.ZodVoid:     // void 类型（通常表示无返回值）
      return withDesc({ type: 'null' }) // 映射为 null

    // -----------------------------------------------------------------------
    // 回退：未知类型，返回空对象（允许任意值）
    // -----------------------------------------------------------------------
    default:
      return withDesc({})
  }
}

// ---------------------------------------------------------------------------
// 内部 Zod 类型名称枚举（镜像 Zod 内部的 ZodFirstPartyTypeKind）
// 用于识别 Zod schema 的具体类型，从而在 zodToJsonSchema 中正确转换。
// ---------------------------------------------------------------------------

// 常量枚举：编译后会被内联，不生成独立对象，提升性能
const enum ZodTypeName {
  ZodString = 'ZodString',              // 字符串类型
  ZodNumber = 'ZodNumber',              // 数字类型
  ZodBigInt = 'ZodBigInt',              // BigInt 类型
  ZodBoolean = 'ZodBoolean',            // 布尔类型
  ZodDate = 'ZodDate',                  // 日期类型
  ZodUndefined = 'ZodUndefined',        // undefined 类型
  ZodNull = 'ZodNull',                  // null 类型
  ZodAny = 'ZodAny',                    // 任意类型（绕过类型检查）
  ZodUnknown = 'ZodUnknown',            // 未知类型（比 any 更安全）
  ZodNever = 'ZodNever',                // 永不存在的类型
  ZodVoid = 'ZodVoid',                  // void 类型（通常表示无返回值）
  ZodArray = 'ZodArray',                // 数组类型
  ZodObject = 'ZodObject',              // 对象类型
  ZodUnion = 'ZodUnion',                // 联合类型（|）
  ZodDiscriminatedUnion = 'ZodDiscriminatedUnion', // 可辨识联合（带有判别字段）
  ZodIntersection = 'ZodIntersection',  // 交叉类型（&）
  ZodTuple = 'ZodTuple',                // 元组类型（固定长度，各位置类型可不同）
  ZodRecord = 'ZodRecord',              // 记录类型（键为 string/symbol，值为固定模式）
  ZodMap = 'ZodMap',                    // Map 类型（此处未实现转换，仅留作占位）
  ZodSet = 'ZodSet',                    // Set 类型（未实现转换）
  ZodFunction = 'ZodFunction',          // 函数类型（未实现转换）
  ZodLazy = 'ZodLazy',                  // 惰性类型（用于递归定义）
  ZodLiteral = 'ZodLiteral',            // 字面量类型（固定值）
  ZodEnum = 'ZodEnum',                  // Zod 枚举（z.enum(['a','b'])）
  ZodEffects = 'ZodEffects',            // 效果类型（transform, preprocess 等）
  ZodNativeEnum = 'ZodNativeEnum',      // TypeScript 原生枚举
  ZodOptional = 'ZodOptional',          // 可选类型（z.optional()）
  ZodNullable = 'ZodNullable',          // 可空类型（z.nullable()）
  ZodDefault = 'ZodDefault',            // 带默认值的类型（z.default()）
  ZodCatch = 'ZodCatch',                // 捕获异常的类型（z.catch()）
  ZodPromise = 'ZodPromise',            // Promise 类型（JSON Schema 无法表示）
  ZodBranded = 'ZodBranded',            // 品牌类型（z.brand()，名义上的新类型）
  ZodPipeline = 'ZodPipeline',          // 管道类型（z.pipe()，顺序处理）
  ZodReadonly = 'ZodReadonly',          // 只读类型（z.readonly()）
}

// ---------------------------------------------------------------------------
// 内部 Zod _def 结构类型定义（仅定义我们在转换函数中实际访问的字段）
// Zod v3 在 schema 对象的 _def 属性中存储其定义，这些接口用于类型安全地访问。
// ---------------------------------------------------------------------------

// 所有 Zod 类型定义的基接口
interface ZodTypeDef {
  typeName: string      // 类型名称字符串，与 ZodTypeName 枚举值对应
  description?: string  // 可选的描述信息（通过 .describe() 添加）
}

// 字面量定义（z.literal(value)）
interface ZodLiteralDef extends ZodTypeDef {
  value: unknown        // 字面量的固定值
}

// Zod 枚举定义（z.enum(['a','b'])）
interface ZodEnumDef extends ZodTypeDef {
  values: string[]      // 枚举允许的字符串列表
}

// TypeScript 原生枚举定义（z.nativeEnum(SomeEnum)）
interface ZodNativeEnumDef extends ZodTypeDef {
  values: object        // 原生枚举对象（包含键值对）
}

// 数组定义（z.array(innerType)）
interface ZodArrayDef extends ZodTypeDef {
  type: ZodSchema       // 数组元素的 schema 类型
}

// 元组定义（z.tuple([schema1, schema2])）
interface ZodTupleDef extends ZodTypeDef {
  items: ZodSchema[]    // 元组中每个位置的 schema 数组
}

// 对象定义（z.object({ ... })）
interface ZodObjectDef extends ZodTypeDef {
  shape: () => Record<string, ZodSchema>  // 返回对象形状的函数（延迟求值）
}

// 记录定义（z.record(keySchema, valueSchema)）
interface ZodRecordDef extends ZodTypeDef {
  valueType: ZodSchema  // 记录中值的类型 schema（键通常为 string）
}

// 联合定义（z.union([schema1, schema2])）
interface ZodUnionDef extends ZodTypeDef {
  options: unknown      // 联合的成员列表（类型为 ZodSchema[]，但 unknown 避免循环依赖）
}

// 可辨识联合定义（z.discriminatedUnion(key, [schema1, schema2])）
interface ZodDiscriminatedUnionDef extends ZodTypeDef {
  options: unknown      // 成员 schema 列表
}

// 交叉定义（z.intersection(left, right)）
interface ZodIntersectionDef extends ZodTypeDef {
  left: ZodSchema       // 左侧 schema
  right: ZodSchema      // 右侧 schema
}

// 可选定义（z.optional(innerType)）
interface ZodOptionalDef extends ZodTypeDef {
  innerType: ZodSchema  // 内部实际的类型 schema
}

// 可空定义（z.nullable(innerType)）
interface ZodNullableDef extends ZodTypeDef {
  innerType: ZodSchema  // 内部实际的类型 schema
}

// 默认值定义（z.default(defaultValueFn)）
interface ZodDefaultDef extends ZodTypeDef {
  innerType: ZodSchema        // 内部类型 schema
  defaultValue: () => unknown // 返回默认值的函数
}

// 效果定义（z.transform(), z.preprocess() 等）
interface ZodEffectsDef extends ZodTypeDef {
  schema: ZodSchema     // 效果所作用的内部 schema
}

// 品牌定义（z.brand()）
interface ZodBrandedDef extends ZodTypeDef {
  type: ZodSchema       // 被品牌化的原始类型 schema
}

// 只读定义（z.readonly()）
interface ZodReadonlyDef extends ZodTypeDef {
  innerType: ZodSchema  // 被包装的内部类型 schema
}

// 捕获定义（z.catch()）
interface ZodCatchDef extends ZodTypeDef {
  innerType: ZodSchema  // 捕获后提供默认值的原始 schema
}

// 管道定义（z.pipe(inner)）
interface ZodPipelineDef extends ZodTypeDef {
  in: ZodSchema         // 管道的输入 schema（第一个阶段）
}