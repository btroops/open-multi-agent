// 从 Zod 库导入 z 对象，用于定义和验证数据模式
import { z } from 'zod'
// 从框架中导入 defineTool 函数，用于创建符合框架规范的工具定义
import { defineTool } from './framework.js'
// 从框架类型中导入 ToolDefinition 类型，用于类型标注
import type { ToolDefinition } from '../types.js'

/**
 * MCP 工具描述符接口
 * 描述从 MCP 服务器获取的单个工具的信息
 */
interface MCPToolDescriptor {
  name: string                    // 工具名称
  description?: string            // 可选的工具描述
  /** MCP 工具的 JSON Schema；与 LLM API 期望的参数对象形状相同 */
  inputSchema?: Record<string, unknown>  // 输入参数的 JSON Schema
}

/**
 * MCP 服务器响应 listTools 请求的格式
 */
interface MCPListToolsResponse {
  tools?: MCPToolDescriptor[]      // 工具描述符数组（可选）
  nextCursor?: string              // 分页游标，用于获取下一页
}

/**
 * MCP 服务器响应 callTool 请求的格式
 */
interface MCPCallToolResponse {
  content?: Array<Record<string, unknown>>  // 返回的内容块数组
  structuredContent?: unknown               // 结构化内容（可选）
  isError?: boolean                         // 是否错误
  toolResult?: unknown                      // 工具结果（某些 MCP 实现使用）
}

/**
 * MCP 客户端应该实现的接口（最小化子集，仅包含本模块使用的方法）
 */
interface MCPClientLike {
  // 连接方法：连接到传输层（如 stdio）
  connect(transport: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>
  // 列出工具：支持游标分页和超时/取消信号
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<MCPListToolsResponse>
  // 调用工具：发送工具名称和参数，可选的 resultSchema 和选项
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<MCPCallToolResponse>
  // 关闭连接（可选方法，某些实现可能没有）
  close?: () => Promise<void>
}

/**
 * MCP Client 类的构造函数类型
 * 接收客户端信息（名称、版本）和选项（能力声明）
 */
type MCPClientConstructor = new (
  info: { name: string; version: string },
  options: { capabilities: Record<string, unknown> },
) => MCPClientLike

/**
 * stdio 传输层构造函数的类型
 * 接收配置：命令、参数、环境变量、工作目录
 */
type StdioTransportConstructor = new (config: {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}) => { close?: () => Promise<void> }

/**
 * MCP 模块集合接口，包含 Client 和 StdioClientTransport 构造函数
 */
interface MCPModules {
  Client: MCPClientConstructor
  StdioClientTransport: StdioTransportConstructor
}

// 默认的 MCP 请求超时时间：60 秒（毫秒）
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000

/**
 * 动态加载 MCP SDK 模块
 * 使用异步导入以避免在不需要 MCP 功能时强制依赖
 * @returns 包含 Client 和 StdioClientTransport 构造函数的对象
 */
async function loadMCPModules(): Promise<MCPModules> {
  // 并行导入 Client 和 StdioClientTransport 模块
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    // 导入客户端主模块
    import('@modelcontextprotocol/sdk/client/index.js') as Promise<{
      Client: MCPClientConstructor
    }>,
    // 导入 stdio 传输模块
    import('@modelcontextprotocol/sdk/client/stdio.js') as Promise<{
      StdioClientTransport: StdioTransportConstructor
    }>,
  ])
  // 返回模块集合
  return { Client, StdioClientTransport }
}

/**
 * 连接 MCP 工具的配置接口
 */
export interface ConnectMCPToolsConfig {
  command: string                      // 启动 MCP 服务器的命令（如 "node"）
  args?: string[]                      // 命令参数数组
  env?: Record<string, string | undefined>  // 环境变量
  cwd?: string                         // 工作目录
  /**
   * 可选的前缀，会添加到框架工具名称（也作为 LLM 工具名称）的前面。
   * 示例：前缀 `github` + MCP 工具 `search_issues` → `github_search_issues`
   */
  namePrefix?: string
  /**
   * MCP 连接和每次 `tools/list` 分页的超时时间（毫秒）。默认为 60000。
   */
  requestTimeoutMs?: number
  /**
   * 发送给 MCP 服务器的客户端元数据
   */
  clientName?: string
  clientVersion?: string
}

/**
 * 已连接的 MCP 工具集返回结果接口
 */
export interface ConnectedMCPTools {
  tools: ToolDefinition[]      // 转换后的工具定义数组
  disconnect: () => Promise<void>  // 断开连接并清理资源的函数
}

/**
 * 构建对 LLM 安全的工具名称：MCP 和先前示例使用 `prefix/name`，但
 * Anthropic 和其他提供商拒绝工具名中包含 `/`。
 * 此函数将原始名称规范化，将 '/' 替换为 '_'，并可选添加前缀。
 * @param rawName - MCP 原始工具名称
 * @param namePrefix - 可选的前缀
 * @returns 规范化后的工具名称
 */
function normalizeToolName(rawName: string, namePrefix?: string): string {
  // 去除前缀首尾空白
  const trimmedPrefix = namePrefix?.trim()
  // 如果有非空前缀，则拼接前缀和下划线，否则直接用原始名称
  const base =
    trimmedPrefix !== undefined && trimmedPrefix !== ''
      ? `${trimmedPrefix}_${rawName}`
      : rawName
  // 将所有 '/' 替换为 '_'，确保 LLM 接受
  return base.replace(/\//g, '_')
}

/**
 * MCP `tools/list` 返回的 JSON Schema；原样转发给 LLM（运行时验证仍使用 `z.any()`）。
 * 如果提供的 schema 是一个非数组对象，则直接返回；否则返回默认的空对象 schema。
 * @param schema - MCP 工具提供的 inputSchema
 * @returns 适合 LLM 的 JSON Schema 对象
 */
function mcpLlmInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // 如果 schema 存在且是对象且不是数组，则原样使用
  if (schema !== undefined && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema
  }
  // 否则返回一个基本 object 类型的 schema
  return { type: 'object' }
}

/**
 * 将 MCP 内容块转换为文本表示
 * @param block - 单个内容块对象
 * @returns 转换后的字符串，如果无法转换则返回 undefined
 */
function contentBlockToText(block: Record<string, unknown>): string | undefined {
  const typ = block.type  // 获取内容块类型
  // 文本类型
  if (typ === 'text' && typeof block.text === 'string') {
    return block.text
  }
  // 图片类型：返回一个摘要，包含 MIME 和 base64 长度
  if (typ === 'image' && typeof block.data === 'string') {
    const mime =
      typeof block.mimeType === 'string' ? block.mimeType : 'image/*'
    return `[image ${mime}; base64 length=${block.data.length}]`
  }
  // 音频类型：返回摘要
  if (typ === 'audio' && typeof block.data === 'string') {
    const mime =
      typeof block.mimeType === 'string' ? block.mimeType : 'audio/*'
    return `[audio ${mime}; base64 length=${block.data.length}]`
  }
  // 资源类型（包含文本或 blob）
  if (
    typ === 'resource' &&
    block.resource !== null &&
    typeof block.resource === 'object'
  ) {
    const r = block.resource as Record<string, unknown>
    const uri = typeof r.uri === 'string' ? r.uri : ''
    // 如果资源包含文本，则返回 URI + 文本内容
    if (typeof r.text === 'string') {
      return `[resource ${uri}]\n${r.text}`
    }
    // 如果资源包含 blob（二进制），返回摘要
    if (typeof r.blob === 'string') {
      const mime = typeof r.mimeType === 'string' ? r.mimeType : ''
      return `[resource ${uri}; mimeType=${mime}; blob base64 length=${r.blob.length}]`
    }
    // 只有 URI 的资源
    return `[resource ${uri}]`
  }
  // resource_link 类型
  if (typ === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : ''
    const name = typeof block.name === 'string' ? block.name : ''
    const desc =
      typeof block.description === 'string' ? block.description : ''
    const head = `[resource_link name=${JSON.stringify(name)} uri=${JSON.stringify(uri)}]`
    return desc === '' ? head : `${head}\n${desc}`
  }
  // 无法识别的类型返回 undefined
  return undefined
}

/**
 * 将 MCP callTool 响应转换为字符串数据，以便放入 ToolResult.data
 * @param result - MCP 调用工具的响应
 * @returns 转换后的字符串
 */
function toToolResultData(result: MCPCallToolResponse): string {
  // 如果响应中包含 toolResult 字段且不为 undefined，优先使用
  if ('toolResult' in result && result.toolResult !== undefined) {
    try {
      return JSON.stringify(result.toolResult, null, 2)  // 格式化为 JSON
    } catch {
      return String(result.toolResult)  // 回退到字符串转换
    }
  }

  const lines: string[] = []  // 存储转换后的文本行
  // 遍历 content 数组中的每个块
  for (const block of result.content ?? []) {
    if (block === null || typeof block !== 'object') continue  // 跳过无效块
    const rec = block as Record<string, unknown>
    const line = contentBlockToText(rec)  // 尝试转换为文本
    if (line !== undefined) {
      lines.push(line)  // 成功转换，添加到结果
      continue
    }
    // 无法转换的块：尝试序列化为 JSON，失败则用占位符
    try {
      lines.push(
        `[${String(rec.type ?? 'unknown')}]\n${JSON.stringify(rec, null, 2)}`,
      )
    } catch {
      lines.push('[mcp content block]')
    }
  }

  // 如果有任何内容块转换成功，则用换行符连接返回
  if (lines.length > 0) {
    return lines.join('\n')
  }

  // 如果没有 content，尝试使用 structuredContent
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2)
    } catch {
      return String(result.structuredContent)
    }
  }

  // 最后回退：序列化整个 result
  try {
    return JSON.stringify(result)
  } catch {
    return 'MCP tool completed with non-text output.'
  }
}

/**
 * 递归获取 MCP 服务器所有分页的工具列表
 * @param client - MCP 客户端实例
 * @param requestOpts - 请求选项（超时等）
 * @returns 工具描述符数组
 */
async function listAllMcpTools(
  client: MCPClientLike,
  requestOpts: { timeout: number },
): Promise<MCPToolDescriptor[]> {
  const acc: MCPToolDescriptor[] = []  // 累积结果的数组
  let cursor: string | undefined        // 分页游标，初始无
  do {
    // 调用 listTools，如果有游标则传入
    const page = await client.listTools(
      cursor !== undefined ? { cursor } : {},
      requestOpts,
    )
    // 将本页的工具添加到累积数组
    acc.push(...(page.tools ?? []))
    // 更新游标：如果 nextCursor 是非空字符串则继续循环，否则结束
    cursor =
      typeof page.nextCursor === 'string' && page.nextCursor !== ''
        ? page.nextCursor
        : undefined
  } while (cursor !== undefined)  // 当还有下一页时继续
  return acc
}

/**
 * 通过 stdio 连接到 MCP 服务器，并将 MCP 暴露的工具转换为 open-multi-agent 的 ToolDefinition。
 * 
 * @param config - 连接配置
 * @returns 包含转换后的工具数组和断开连接函数的对象
 */
export async function connectMCPTools(
  config: ConnectMCPToolsConfig,
): Promise<ConnectedMCPTools> {
  // 加载 MCP SDK 模块（动态导入）
  const { Client, StdioClientTransport } = await loadMCPModules()

  // 创建 stdio 传输层实例
  const transport = new StdioClientTransport({
    command: config.command,           // 命令
    args: config.args ?? [],           // 参数，默认为空数组
    env: config.env,                   // 环境变量
    cwd: config.cwd,                   // 工作目录
  })

  // 创建 MCP 客户端实例，提供客户端名称和版本
  const client = new Client(
    {
      name: config.clientName ?? 'open-multi-agent',   // 客户端名称，默认为 open-multi-agent
      version: config.clientVersion ?? '0.0.0',        // 客户端版本，默认为 0.0.0
    },
    { capabilities: {} },  // 本客户端不声明任何特殊能力（可根据需要扩展）
  )

  // 请求选项：超时时间
  const requestOpts = {
    timeout: config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  }

  // 连接客户端到传输层
  await client.connect(transport, requestOpts)

  // 获取 MCP 服务器上所有可用的工具列表（处理分页）
  const mcpTools = await listAllMcpTools(client, requestOpts)

  // 将每个 MCP 工具转换为框架的 ToolDefinition
  const tools: ToolDefinition[] = mcpTools.map((tool) =>
    defineTool({
      // 规范化的工具名称（替换 '/' 并可选添加前缀）
      name: normalizeToolName(tool.name, config.namePrefix),
      // 描述：优先使用 MCP 提供的描述，否则生成默认描述
      description: tool.description ?? `MCP tool: ${tool.name}`,
      // 输入 schema：运行时验证使用 z.any()（不进行强校验），因为 MCP 自身会验证
      inputSchema: z.any(),
      // LLM 可见的 JSON Schema：使用 MCP 提供的 inputSchema，或默认 object
      llmInputSchema: mcpLlmInputSchema(tool.inputSchema),
      // 执行函数：当 LLM 调用此工具时触发
      execute: async (input: Record<string, unknown>) => {
        try {
          // 调用 MCP 服务器的 callTool 方法，传入工具名称和参数
          const result = await client.callTool(
            {
              name: tool.name,          // 原始工具名称（MCP 服务器识别的）
              arguments: input,         // 传入的参数
            },
            undefined,                 // 不使用 resultSchema
            requestOpts,               // 超时等选项
          )
          // 返回框架标准的 ToolResult
          return {
            data: toToolResultData(result),      // 将 MCP 响应转换为字符串
            isError: result.isError === true,    // 根据 MCP 响应的 isError 字段设置错误标志
          }
        } catch (error) {
          // 捕获任何调用过程中的异常
          const message =
            error instanceof Error ? error.message : String(error)
          return {
            data: `MCP tool "${tool.name}" failed: ${message}`,
            isError: true,
          }
        }
      },
    }),
  )

  // 返回已转换的工具数组和一个断开连接的函数
  return {
    tools,
    disconnect: async () => {
      // 如果客户端有 close 方法则调用，否则什么都不做
      await client.close?.()
    },
  }
}