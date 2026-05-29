# 工具系统

日期: 2026-05-29 / 更新: 2026-05-30

基于 `src/tool/framework.ts`、`executor.ts`、`mcp.ts`、`text-tool-extractor.ts`、`built-in/` 总结。

## 分层结构

```
tool/framework.ts             — 定义工具 + 注册中心
tool/executor.ts              — 并行批量执行器
tool/built-in/                — 7 个内置工具
tool/mcp.ts                   — MCP 协议桥接
tool/text-tool-extractor.ts   — 本地模型回退（文本→tool_call）
```

### 三层模型

```text
┌─────────────────────────────────────────────────┐
│             1. 工具定义层 (defineTool)             │
│          返回类型安全的 ToolDefinition<TInput>     │
└───────────────────┬─────────────────────────────┘
                    │ 注册
                    ▼
┌─────────────────────────────────────────────────┐
│             2. 工具管理层 (ToolRegistry)            │
│      register / get / list / unregister           │
│      toToolDefs() → LLMToolDef[]                  │
└───────────────────┬─────────────────────────────┘
                    │ 转换
                    ▼
┌─────────────────────────────────────────────────┐
│          3. Schema 转换层 (zodToJsonSchema)         │
│          将 Zod 类型 → JSON Schema（LLM 可理解）    │
└─────────────────────────────────────────────────┘
```

---

## framework.ts — 定义与注册

### defineTool() — 工具的"构造函数"

定义一个新工具的唯一方式：

```typescript
const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the input message back.',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.string().optional(),     // optional 输出校验
  llmInputSchema: { ... },                 // optional 绕过 Zod→JSON Schema
  maxOutputChars: 2000,                    // optional 输出截断阈值
  execute: async ({ message }) => ({
    data: message,
    isError: false,
  }),
})
```

它封装了：
- **名称 & 描述** — 让 LLM 知道工具用途
- **输入 Schema（Zod）** — 定义参数类型，用于运行时校验 + 自动生成 JSON Schema
- **执行函数 `execute`** — 真正的业务逻辑
- 可选：输出校验、工具级长度限制、显式 JSON Schema

`execute` 接收 `(input, context)`，其中 `context: ToolUseContext` 包含：
- `abortSignal` — 取消信号
- `agent` — 当前 Agent 信息
- `team` — 团队信息（含 `runDelegatedAgent`）
- `logger` — 日志

### ToolRegistry — 工具的"容器"

管理多个工具的注册表，是连接"工具定义"和"LLM 调用"的桥梁。

| 方法 | 作用 |
|------|------|
| `register(tool)` | 注册，重名抛错（防止静默覆盖） |
| `get(name)` / `has(name)` | 查工具 |
| `list()` / `getAll()` | 列出所有 |
| `unregister(name)` / `deregister(name)` | 移除 |
| `toToolDefs()` | 全部转 `LLMToolDef[]`（LLM API 格式） |
| `toRuntimeToolDefs()` | 仅运行时动态添加的（`addTool()`） |
| `toLLMTools()` | Anthropic `input_schema` 格式 |

`runtimeToolNames` Set 跟踪哪些工具是运行时通过 `agent.addTool()` 动态加入的，和静态注册的工具区分开。

### zodToJsonSchema — Schema 转换器

把 Zod schema 转成纯 JSON Schema 对象（`type`, `properties`, `required`...）。LLM API（如 OpenAI function calling）只认 JSON Schema，不认 Zod。

手写（非第三方库）减少依赖，支持 20+ Zod 类型：

| 类别 | 类型 |
|------|------|
| 基础 | string, number, bigint, boolean, null, undefined, date |
| 字面量 | literal |
| 枚举 | enum, nativeEnum |
| 容器 | array, tuple, object, record |
| 组合 | union, discriminatedUnion, intersection, optional, nullable, default |
| 包装 | effects, branded, readonly, catch, pipeline |
| 通配 | any, unknown → `{}`, never → `{ not: {} }`, void → `null` |

不支持的 fallback 到 `{}`（any），仍为合法 JSON Schema。

内部通过 Zod 的 `_def.typeName` 做 switch 分发（访问 Zod 内部结构，Zod v3 没有一级 JSON Schema 导出）。

### 次要但实用的设计细节

| 模块 | 关键点 | 作用 |
|------|--------|------|
| `defineTool` | `llmInputSchema` 可选参数 | 绕过 Zod 自动转换，直接提供自定义 JSON Schema（高级场景） |
| `defineTool` | `maxOutputChars` 可选 | 工具返回文本太长时可截断，优先级高于全局配置 |
| `ToolRegistry` | `toLLMTools()` 方法 | 专门给 Anthropic 的 `input_schema` 格式（兼容不同厂商） |
| `ToolRegistry` | `runtimeToolNames` Set | 记录哪些工具是运行时动态添加的，可实现"会话级临时工具" |
| `zodToJsonSchema` | `withDesc` 辅助函数 | 把 Zod 的 `.describe()` 转成 JSON Schema 的 `description` 字段 |
| `zodToJsonSchema` | 对 `ZodOptional` / `ZodNullable` / `ZodDefault` 的处理 | 正确推断字段是否为 `required`，避免把可选字段也标记为必需 |

### 容易被忽略但重要的细节

1. **`zodToJsonSchema` 依赖 Zod 内部 `_def` 结构** — 通过 `(schema as any)._def` 实现。Zod 大版本升级可能需要同步更新。

2. **`toToolDefs` 优先使用 `llmInputSchema`** — 如果提供了 `llmInputSchema`，直接使用，不再调用 `zodToJsonSchema`。用于需要精细控制 JSON Schema（如添加 `pattern` 或 `minimum`）的场景。

3. **`required` 字段推断规则** — 只有字段不是 `ZodOptional`、`ZodDefault`、`ZodNullable` 时才加入 `required` 数组。

4. **`ZodEffects`（如 `.transform`）只取内部 schema** — 转换时只取 `effectsDef.schema`，LLM 不需要知道转换逻辑。

### 典型使用流程

```typescript
// 1. 定义工具
const weatherTool = defineTool({
  name: 'get_weather',
  description: '获取某个城市的天气',
  inputSchema: z.object({
    city: z.string().describe('城市名，如北京'),
    unit: z.enum(['celsius', 'fahrenheit']).optional()
  }),
  execute: async ({ city, unit }) => {
    const temp = await fetchWeather(city, unit);
    return { data: `当前温度：${temp}`, isError: false };
  }
});

// 2. 注册工具
const registry = new ToolRegistry();
registry.register(weatherTool);

// 3. 生成 LLM 可用的工具定义列表
const llmTools = registry.toToolDefs();

// 4. 在 Agent 执行中调用工具
const toolImpl = registry.get('get_weather');
const result = await toolImpl.execute({ city: '上海' }, context);
```

### 数据流向

> 开发者调用 `defineTool` → 得到 `ToolDefinition` → 注册到 `ToolRegistry` → Agent 运行时调用 `registry.toToolDefs()` → 得到 `LLMToolDef[]` → 发给 LLM → LLM 返回工具调用请求 → Agent 从 registry 拿到 `execute` 函数 → 执行并返回结果。

---

## executor.ts — 并行执行

### 整体定位

**输入**：LLM 返回的工具调用请求（工具名 + 原始参数）

**职责**：
1. 根据工具名从 `ToolRegistry` 找到工具定义
2. 用 Zod schema 校验参数
3. 执行工具的 `execute` 函数
4. 可选地校验工具输出（`outputSchema`）
5. 截断过长的输出（按配置）
6. 捕获所有错误，封装成 `ToolResult`（不抛异常）

**输出**：`ToolResult`（包含 `data` 和 `isError` 标志），直接返回给 Agent，再由 Agent 送回 LLM

### ToolExecutor

持有 `ToolRegistry` + `Semaphore`（默认并发 4）：

```
execute(name, input, context)
  → 查 registry
  → Zod 校验输入
  → abortSignal 检查
  → tool.execute()
  → outputSchema 校验（可选）
  → 截断
  → ToolResult

executeBatch(calls, context)
  → Promise.all(calls.map(c => semaphore.run(() => execute(...))))
  → Map<callId, ToolResult>
```

### 执行流程

```
1. 从 registry 获取工具 → 不存在则返回 errorResult
2. 检查 abortSignal（如果已中止，直接返回）
3. 调用 runTool（私有方法）
   ├─ 3.1 runZodSchema 验证输入 → 失败则 errorResult
   ├─ 3.2 再次检查 abortSignal（验证可能耗时，期间可能被取消）
   ├─ 3.3 try { 调用 tool.execute(...) }
   │      ├─ 如果工具返回非错误且有 outputSchema → 验证输出
   │      └─ 调用 maybeTruncate 截断
   └─ 3.4 catch → 将任何异常转为 errorResult
```

### 核心概念

| 概念 | 代码位置 | 作用 |
|------|----------|------|
| **并发控制** | `Semaphore` + `executeBatch` | 同时执行的工具数量上限（默认 4），防止过载 |
| **错误隔离** | 所有 `try-catch` + `errorResult` | 任何错误都不会中断整个 Agent，而是转为错误结果 |
| **输出截断** | `maybeTruncate` + `truncateToolOutput` | 保证发给 LLM 的字符串不超过限制 |

### 关键设计细节

1. **为什么用 `safeParse` 而不是 `parse`？** — `parse` 抛异常，`safeParse` 让作者能手动构造细粒度 `issuesMessage`（展示哪个字段验证失败）。

2. **`runZodSchema` 的返回值** — 成功 `{ success: true, data: T }`，失败 `{ success: false, error: ZodError, issuesMessage: string }`。

3. **中止信号检查两次** — 第一次在 `execute` 快路径，第二次在输入验证后（因为解析可能耗时，期间可能被外部取消）。

4. **输出验证只针对非错误结果** — 如果工具返回 `{ isError: true }` 则跳过 `outputSchema` 验证。

5. **截断优先级** — 工具级 `maxOutputChars` > 构造函数传入的 `maxToolOutputChars`。如果都没有，不截断。

6. **`truncateToolOutput` 算法** — 保留头 70% + 尾 30%，标记本身占用预算。`maxChars` 小到放不下标记时直接硬截断。

### 校验流程

```
Input Zod 校验 ──失败──→ errorResult("Invalid input for tool ...")
       │
       ↓ 通过
Execute ──异常──→ errorResult("Tool ... threw an error: ...")
       │
       ↓ 成功
Output Zod 校验 ──失败──→ errorResult("Invalid output for tool ...")
       │
       ↓ 通过
截断 → ToolResult
```

### 总结

| 如果你想知道... | 看这里 |
|----------------|--------|
| 如何并发执行多个工具？ | `executeBatch` + `Semaphore` |
| 如何验证输入参数？ | `runZodSchema(tool.inputSchema, rawInput)` |
| 如何验证工具输出？ | `tool.outputSchema` + `runZodSchema`（仅非错误结果） |
| 错误怎么返回？ | 统一封装为 `ToolResult`，`isError: true` |
| 长输出怎么截断？ | `maybeTruncate` → `truncateToolOutput`（70/30 分割 + 标记） |
| 如何支持取消？ | 检查 `context.abortSignal`（两次） |
| 某个工具执行失败会影响其他吗？ | 不会，每个工具独立捕获错误，`Promise.all` 等待所有完成 |

---

## 内置工具（built-in/）

### 索引

| 工具 | 文件 | 行数 | 作用 |
|------|------|------|------|
| `bash` | bash.ts | 188 | spawn 子进程，timeout + abortSignal，无 shell 注入风险 |
| `file_read` | file-read.ts | 106 | 读文件，offset/limit 分片，1-based 行号 |
| `file_write` | file-write.ts | 82 | 写文件，自动 `mkdir -p`，区分创建/更新 |
| `file_edit` | file-edit.ts | 155 | 精确替换，unique 检查防误改，支持 replace_all |
| `grep` | grep.ts | 281 | 优先 ripgrep，回退纯 Node 递归搜索 |
| `glob` | glob.ts | 100 | 列文件，glob 过滤，跳过 SKIP_DIRS |
| `delegate_to_agent` | delegate.ts | 109 | 委派给队友 Agent（仅编排模式下注入） |

### 注册入口

```typescript
registerBuiltInTools(registry, { includeDelegateTool?: boolean })
```

`registerBuiltInTools()` 注册 6 个核心工具（不含 delegate），`includeDelegateTool: true` 时额外注册。

两个预定义数组：
- `BUILT_IN_TOOLS` — 6 个核心工具
- `ALL_BUILT_IN_TOOLS_WITH_DELEGATE` — 全部 7 个

### fs-walk.ts — 共享目录遍历

grep + glob 共享的递归目录遍历器：

```
SKIP_DIRS = [.git, .svn, .hg, node_modules, .next, dist, build]
```

`matchesGlob(filename, glob)` — 简单 glob 匹配，支持 `*.ext` 和 `**/xxx` 模式。

### delegate_to_agent 防护

```typescript
▪ 不自委派          → target === context.agent.name
▪ 未知 agent        → !team.agents.includes(target)
▪ 循环检测          → delegationChain.includes(target)
▪ 深度限制          → depth >= maxDelegationDepth (default 3)
▪ 池死锁检测        → availableRunSlots < 1
```

委派执行结果写入 SharedMemory 做审计（best-effort），tokenUsage 通过 `ToolResult.metadata` 返回给父 runner。

---

## mcp.ts — MCP 集成

### 整体定位

**输入**：MCP 服务器的启动命令（如 `npx`）、参数、环境变量

**职责**：
1. 动态加载 MCP SDK（`@modelcontextprotocol/sdk`）
2. 通过 stdio 启动 MCP 子进程并建立通信
3. 获取 MCP 服务器上所有可用工具列表（支持分页）
4. 将每个 MCP 工具包装成框架的 `ToolDefinition`（兼容 `defineTool` 格式）
5. 提供 `disconnect` 函数清理资源

**输出**：`ConnectedMCPTools` 对象（`{ tools, disconnect }`）

### 核心概念

| 概念 | 位置 | 作用 |
|------|------|------|
| **MCP 协议适配** | `MCPClientLike` + `MCPCallToolResponse` | 标准化的工具调用协议，接入任意 MCP 服务器 |
| **动态模块加载** | `loadMCPModules()` | 仅在需要时导入 MCP SDK，不强制依赖 |
| **工具名规范化** | `normalizeToolName()` | MCP 工具名中的 `/` 替换为 `_`，兼容命名限制 |

### connectMCPTools()

```typescript
const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['@modelcontextprotocol/server-filesystem', '/path'],
  namePrefix: 'fs',         // 可选前缀，加在工具名前
  requestTimeoutMs: 60000,
})
```

### 数据流向

```text
[用户调用 connectMCPTools(config)]
         │
         ▼
动态加载 MCP SDK ──► 创建 StdioClientTransport（子进程 stdio）
         │
         ▼
创建 Client 实例 ──► 调用 connect() 握手
         │
         ▼
listAllMcpTools（分页获取全部工具）──► MCPToolDescriptor[]
         │
         ▼
.map() 每个工具 ──► defineTool({...})
         │
         ├─ name: normalizeToolName(...)
         ├─ description: 使用 MCP 描述或默认
         ├─ inputSchema: z.any()（运行时不做强校验）
         ├─ llmInputSchema: 原样使用 MCP 提供的 JSON Schema
         └─ execute: 内部调用 client.callTool(...)
               │
               ▼
        toToolResultData() 转换 MCP 响应为字符串
               │
               ▼
        返回 { data, isError } 给 Agent
```

### 关键函数

| 函数 | 重要度 | 作用 |
|------|--------|------|
| `normalizeToolName` | ⭐️⭐️⭐️ | 清洗工具名，否则 LLM 拒绝调用 |
| `mcpLlmInputSchema` | ⭐️⭐️⭐️ | 原样转发 MCP JSON Schema 给 LLM |
| `toToolResultData` | ⭐️⭐️⭐️ | 将 MCP content 数组（text/image/audio/resource）统一转为纯文本 |
| `listAllMcpTools` | ⭐️⭐️ | 自动分页遍历全部工具，避免大工具集丢失 |
| `loadMCPModules` | ⭐️⭐️ | 动态导入，按需加载不强制 |

### 响应解析

MCP 响应体解析多种 content block：

| block type | 处理方式 |
|-----------|---------|
| `text` | 直接返回 `block.text` |
| `image` | 返回描述 `[image mimeType; base64 length=N]` |
| `audio` | 同上，`[audio ...]` |
| `resource` | 文本资源返回内容，blob 返回描述 |
| `resource_link` | 返回 URI + name + description |

### 设计要点

| 设计点 | 说明 |
|--------|------|
| **类型安全声明** | `MCPClientLike` 只定义本模块需要的方法，避免与完整 MCP 接口耦合 |
| **超时控制** | 默认 60 秒超时，支持用户配置 |
| **中断信号支持** | `connect`、`listTools`、`callTool` 接口预留 AbortSignal |
| **错误隔离** | 单个 MCP 工具 `execute` 内部 `try-catch`，不因一个工具失败断开连接 |
| **资源清理** | 返回的 `disconnect()` 调用 `client.close?.()`，必须调用否则留下僵尸进程 |

### 总结

| 如果你想知道... | 看这里 |
|----------------|--------|
| 如何连接一个 MCP 服务器？ | `connectMCPTools(config)` |
| MCP 工具名有 `/` 怎么办？ | `normalizeToolName` 替换为 `_` |
| MCP 返回的 content 怎么变成文本？ | `toToolResultData` → `contentBlockToText` |
| 运行时怎么验证 MCP 输入？ | 不验证，用 `z.any()`，信任 MCP 服务器 |
| LLM 怎么知道 MCP 工具的参数？ | `llmInputSchema` 传递 MCP 提供的 JSON Schema |
| 如果工具列表很多怎么办？ | `listAllMcpTools` 自动分页获取全部 |
| 如何断开连接并清理？ | 调用返回的 `disconnect()` |

---

## text-tool-extractor.ts — 本地模型回退

### 整体定位

**安全网而非主路径**。当 Ollama/vLLM/LM Studio 等本地服务器返回文本格式 tool call（非原生 `tool_calls`），尝试从文本提取。

**场景**：
- Ollama 思维模型：tool call JSON 残留在未关闭的 `<think>` 标签内
- 模型输出 JSON 字符串但服务器未解析成 `tool_calls`
- 模型用 Markdown 代码块包裹 JSON
- Hermes 格式的 `<tool_call>` 标签

### 核心概念

| 概念 | 位置 | 作用 |
|------|------|------|
| **多种 JSON 形状兼容** | `parseToolCallJSON` + `parseFlat` | 支持 `{name, arguments}`、`{name, parameters}`、`{name, input}`、`{function: {name, arguments}}` |
| **白名单过滤** | `parseFlat` 中的 `knownToolNames.has(name)` | 防止把无关 JSON 当成工具调用 |
| **JSON 边界探测** | `extractJSONObjects`（深度+字符串状态机） | 在不规范文本中正确提取顶层完整 JSON |

### 执行流程

```text
extractToolCallsFromText(text, knownToolNames)
         │
         ├─ 空文本 → 返回 []
         │
         ├─ 策略1: extractHermesToolCalls
         │     正则匹配 <tool_call>...</tool_call>
         │     └─ 内部 JSON 解析 → parseToolCallJSON
         │          └─ 白名单检查 → 返回 ToolUseBlock
         │     └─ 如果找到至少一个，直接返回
         │
         └─ 策略2: 通用 JSON 提取
                ├─ 移除 Markdown 代码块围栏（```json ... ```）
                ├─ extractJSONObjects（状态机提取所有顶层 JSON）
                └─ 逐个 parseToolCallJSON + 白名单过滤
```

### 设计要点

| 设计点 | 说明 |
|--------|------|
| **多层策略顺序** | Hermes 优先（更明确），通用 JSON 回退，避免误匹配 |
| **白名单机制** | 极大减少误判：只有注册过的工具名才被接受 |
| **代码块移除** | 先去掉 ` ```json ``` 围栏再提取 |
| **状态机处理字符串** | `inString` + `escape` 标志确保字符串内花括号不干扰深度 |
| **孤立 `}` 防御** | `depth === 0` 时遇到 `}` 直接跳过，防止 `${var}` 截断导致深度错乱 |

### 总结

| 如果你想知道... | 看这里 |
|----------------|--------|
| 支持哪些 JSON 形状？ | `{name, arguments}`、`{name, parameters}`、`{name, input}`、`{function: {name, arguments}}` |
| 如何避免误判普通 JSON？ | 白名单检查 + 只提取顶层完整对象 |
| 如何提取被 Markdown 代码块包裹的 JSON？ | 用正则先去掉代码围栏 |
| 如何处理字符串内的花括号？ | 状态机识别字符串边界，忽略内部花括号 |
| 如何防止 `${var}` 截断导致深度错乱？ | 忽略深度为 0 时的右花括号 |
| 什么时候使用这个模块？ | 当模型输出不是标准 OpenAI `tool_calls` 格式时（特别是本地模型） |

---

## 关键设计决策

### 错误处理策略

工具执行中的任何错误（unknown tool、Zod 校验失败、执行抛异常）都返回 `ToolResult(isError: true)` 而非抛出。AgentRunner 收到后以 tool_result 形式送回 LLM，由 LLM 决定如何修正。

### 并发控制

`executeBatch` 通过 Semaphore 限制并行度，每个 tool call 独立 acquire/release，互不阻塞。默认并发 4。

### 输出截断两级配置

`ToolDefinition.maxOutputChars`（per-tool）> `ToolExecutorOptions.maxToolOutputChars`（agent 级）。per-tool 优先。

### MCP 的可选依赖

`@modelcontextprotocol/sdk` 在 `connectMCPTools` 内 `await import()` 懒加载，不使用 MCP 的用户不会加载这个包。

### Zod→JSON Schema 的手写实现

选择手写而非 `zod-to-json-schema` 库，减少一个依赖项。

### 本地模型的安全网

原生 `tool_calls` 永远优先，提取器只在 LLM 返回空 `tool_calls` 时运行。Hermes 格式 > 自由 JSON 的优先级确保规范格式优先命中。
