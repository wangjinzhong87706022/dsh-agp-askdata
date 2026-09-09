// P0 端到端验证：真实 StarRocks 上跑完整工具链。
// 用法：npx tsx scripts/e2e-p0.ts（可用 SR_HOST/SR_PORT/SR_USER/SR_PASSWORD/SR_DATABASE 覆盖）
import { createAskdataService } from '../src/index.ts'
import type { ToolResult } from '../src/result.ts'

const connection = {
  host: process.env.SR_HOST ?? '192.168.101.54',
  port: Number(process.env.SR_PORT ?? 9030),
  user: process.env.SR_USER ?? 'root',
  password: process.env.SR_PASSWORD ?? '',
  database: process.env.SR_DATABASE ?? 'WT_DB',
}

const service = createAskdataService({
  connection,
  system: { queryTimeoutMs: Number(process.env.SR_TIMEOUT ?? 15_000) },
})
const ctx = service.createContext()
const tool = (name: string) => {
  const t = service.tools.find((t) => t.name === name)
  if (!t) throw new Error(`工具未注册: ${name}`)
  return t
}

function brief(tag: string, r: ToolResult): void {
  const status = r.success ? '✓' : '✗'
  console.log(`\n${status} [${tag}] ${r.executionMs}ms rows=${r.rowCount} errorCode=${r.errorCode || '-'}`)
  console.log(`  sql: ${r.apiOrSql.replaceAll('\n', ' ').slice(0, 160)}`)
  for (const row of r.data.slice(0, 3)) console.log('  ·', JSON.stringify(row))
  if (r.rowCount > 3) console.log(`  ... 共 ${r.rowCount} 行`)
  if (!r.success) console.log('  错误:', r.errorMessage)
}

// 0. 摸底：WT_TAG 样例 + WT_DATA 时间范围
const peek = await ctx.executor.execute('SELECT tagName, `comment` FROM WT_TAG LIMIT 5')
console.log('WT_TAG 样例:')
for (const row of peek.rows) console.log('  ·', JSON.stringify(row))
if (peek.rows.length === 0) {
  console.log('WT_TAG 为空，无法继续工具链验证（库连通性已确认）')
  process.exit(0)
}
// 时间窗：锚定真实数据的最新时间（latest_value 返回），避免"现在"附近无数据 + 不做全表 min/max。
// peek 的前几个 tag 不保证在 WT_DATA 有行（状态量可能从无变位），逐个找第一个有数据的。
let lv: ToolResult | undefined
let sample: { tagName?: string | null; comment?: string | null } | undefined
for (const row of peek.rows) {
  const r = await tool('latest_value').run({ tag_names: [row.tagName!] }, ctx)
  if (r.success && r.rowCount > 0) {
    lv = r
    sample = row
    break
  }
}
if (!lv || lv.rowCount === 0) {
  console.log('peek 的样例 tag 均无 WT_DATA 行，无法构造时间窗（库连通性已确认）；可改用已知有数据的 tagName 重跑')
  process.exit(0)
}
const prefix = sample.tagName!.split('_')[0]!
const latestTime = String(lv.data[0]!.latestTime)
console.log(`\n数据锚点: ${sample.tagName} 最新值 @ ${latestTime}`)
const end = new Date(latestTime.replace(' ', 'T'))
// 该库数据密度约 4 亿行/天，1 小时窗口约 1600 万行，位于 1 亿护栏之内
const start = new Date(end.getTime() - 3600 * 1000)
const startTime = start.toISOString()
const endTime = end.toISOString()

// 1. lookup_tag
brief('lookup_tag', await tool('lookup_tag').run({ keyword: prefix }, ctx))

// 2. estimate_count（锚点前一天）
brief('estimate_count', await tool('estimate_count').run({ start_time: startTime, end_time: endTime }, ctx))

// 3. time_series（样例前缀，锚点前一小时，5m 桶）
brief('time_series', await tool('time_series').run(
  { tag_filter: `^${prefix}_`, start_time: startTime, end_time: endTime, bucket: '5m', limit: 48 },
  ctx,
))

// 4. latest_value（上面已跑，此处仅回显结果）
brief('latest_value', lv)

// 5. aggregate（device 分组，锚点前一天）
brief('aggregate', await tool('aggregate').run(
  { tag_filter: `^${prefix}_`, start_time: startTime, end_time: endTime, func: 'AVG', group_by: 'device', limit: 20 },
  ctx,
))

console.log('\n端到端验证完成')
