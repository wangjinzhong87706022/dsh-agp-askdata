// 智能问数冒烟：自然语言 → DeepSeek function-calling → P0 工具（真实 StarRocks）→ 结论合成。
// 用法：DEEPSEEK_API_KEY=sk-xxx npx tsx scripts/ask-smoke.ts "35KVI段装置告警这个测点最新的值是多少？"
// LLM 侧没有任何 SQL 工具——它只能编排 lookup_tag / estimate_count / latest_value / time_series / aggregate。
import { createAskdataService } from '../src/index.ts'
import type { ToolResult } from '../src/result.ts'

const connection = {
  host: process.env.SR_HOST ?? '192.168.101.54',
  port: Number(process.env.SR_PORT ?? 9030),
  user: process.env.SR_USER ?? 'root',
  password: process.env.SR_PASSWORD ?? '',
  database: process.env.SR_DATABASE ?? 'WT_DB',
}
const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}
// 遵循 harness 约定：DEEPSEEK_BASE_URL 可选（默认官方端点；base 已含 /v1）
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')
const model = process.env.LLM_MODEL ?? 'deepseek-chat'
const question = process.argv.slice(2).join(' ') || '35KVI段装置告警这个测点最新的值是多少？'
console.log(`问题: ${question}\n`)

const service = createAskdataService({
  connection,
  system: { queryTimeoutMs: Number(process.env.SR_TIMEOUT ?? 30_000) },
})
const ctx = service.createContext()

const tools = service.tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}))

const SYSTEM = `你是 AGP 光伏电站数据分析员，数据源是 StarRocks TSDB（WT_TAG 测点字典 + WT_DATA 时序主表 + WT_CUBE 预聚合）。
硬性规则：
1. 只能通过提供的工具取数；你没有任何执行 SQL 的工具，也不要尝试。
2. 用户用中文描述测点时，先用 resolve_tag 解析（或 lookup_tag 反查）tagName，再取数。
3. 时间区间查询前先用 estimate_count 估算扫描量；若返回 EXCEED_LIMIT，缩小时间范围或加大聚合粒度后重试。
4. 库里数据最新约为 2024-08-14，不要假设数据是最近的；不确定时间范围时先用 latest_value 锚定。
5. 最终回答用中文，必须引用所用测点全名与时间范围；数据不足时明确说明。`

const messages: Array<Record<string, unknown>> = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: question },
]

let usage = { prompt: 0, completion: 0 }
for (let step = 0; step < 8; step++) {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0 }),
  })
  if (!resp.ok) {
    console.error(`LLM 调用失败 ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const data = (await resp.json()) as {
    choices: Array<{ message: Record<string, unknown>; finish_reason: string }>
    usage: { prompt_tokens: number; completion_tokens: number }
  }
  usage.prompt += data.usage.prompt_tokens
  usage.completion += data.usage.completion_tokens
  const message = data.choices[0]!.message
  messages.push(message)

  const toolCalls = (message.tool_calls ?? []) as Array<{
    id: string
    function: { name: string; arguments: string }
  }>
  if (toolCalls.length === 0) {
    console.log(`\n=== 问数结论（${usage.prompt + usage.completion} tokens）===`)
    console.log(message.content)
    process.exit(0)
  }

  for (const call of toolCalls) {
    console.log(`→ LLM 调用 ${call.function.name}(${call.function.arguments.slice(0, 160)})`)
    const tool = service.tools.find((t) => t.name === call.function.name)
    let result: ToolResult
    if (!tool) {
      result = {
        success: false, toolName: call.function.name, apiOrSql: '', params: {}, fields: [], data: [],
        rowCount: 0, executionMs: 0, auditId: '', citations: {},
        errorMessage: `未知工具 ${call.function.name}`, errorCode: 'INVALID_PARAM',
      }
    } else {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>
      } catch {
        args = {}
      }
      result = await tool.run(args, ctx)
    }
    console.log(`  ← ${result.success ? '成功' : `失败(${result.errorCode})`} rows=${result.rowCount} ${result.executionMs}ms`)
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({ ...result, data: result.data.slice(0, 20) }),
    })
  }
}
console.error('达到最大工具轮次仍未收敛')
process.exit(1)
