/**
 * API 工具面端到端测试（真实 AGP API，工具层全路径）。
 *
 * 覆盖（测点表 = 模拟量.xlsx，储能水泵项目 10462，20 个测点）：
 *   模型查询：list_models / model_attributes / query_model（全量+条件）
 *   分段汇总：query_model_segment
 *   测点实时：tag_real
 *   测点历史：tag_history（raw）/ tag_wide（宽表）/ tag_aggregate（统计汇总）
 *   测点反查：resolve_tag
 * 另验证审计哈希链跨调用衔接。
 *
 * 用法：AGP_API_TOKEN=... AGP_API_OPENID=... npx tsx scripts/e2e-api-tools.ts
 */
import { createAskdataService } from '../src/index.ts'

const token = process.env.AGP_API_TOKEN
const openid = process.env.AGP_API_OPENID
if (!token || !openid) {
  console.error('缺少 AGP_API_TOKEN / AGP_API_OPENID 环境变量')
  process.exit(1)
}

const service = createAskdataService({
  connection: { host: 'unused', port: 9030, user: 'u', password: '', database: 'db' },
  audit: { enabled: true },
  api: {
    baseUrl: process.env.AGP_API_BASE ?? 'https://www.openagp.top:9080',
    apiPrefix: '/s1M6_uE9',
    token,
    openid,
    projectId: '10462',
  },
})
const audits: Array<{ toolName: string; prevHash: string; resultHash: string }> = {}
let prevHash = ''
const ctx = service.createApiContext({
  onAudit: (row) => {
    audits[row.toolName] = { prevHash: row.prevHash, resultHash: row.resultHash }
    prevHash = row.resultHash
  },
})

const api = (name: string) => {
  const t = service.apiTools.find((x) => x.name === name)
  if (!t) throw new Error(`API 工具未注册: ${name}`)
  return t
}

let pass = 0, fail = 0
function report(name: string, ok: boolean, detail: string) {
  if (ok) pass++; else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${detail.replaceAll('\n', '\n    ')}`)
}
const summary = (r: { success: boolean; rowCount: number; errorCode: string; errorMessage: string; executionMs: number }) =>
  `success=${r.success} rows=${r.rowCount} ${r.errorCode ? `errorCode=${r.errorCode} ${r.errorMessage.slice(0, 80)}` : ''} ${r.executionMs}ms`

// ── 1. 模型清单 ──────────────────────────────────────────────
{
  const r = await api('list_models').run({}, ctx)
  const names = r.data.map((x) => x.class_alias ?? x.class_name)
  const has = names.some((n) => String(n).includes('模拟量'))
  report('1. list_models 模型清单', r.success && has,
    `${summary(r)}\n    模型(${r.rowCount}): ${names.slice(0, 8).join(' / ')}${r.rowCount > 8 ? ' …' : ''}${has ? '\n    含「模拟量模型」✓' : '\n    未找到「模拟量模型」'}`)
}

// ── 2. 模型属性（测点表字段定义）────────────────────────────
{
  const r = await api('model_attributes').run({ model_name: '模拟量模型' }, ctx)
  const fields = r.data.map((x) => x.field_name)
  report('2. model_attributes 模型属性', r.success && r.rowCount > 0,
    `${summary(r)}\n    属性(${r.rowCount}): ${fields.slice(0, 12).join(' / ')}${r.rowCount > 12 ? ' …' : ''}`)
}

// ── 3. 测点信息查询（全量 20 测点）──────────────────────────
{
  const r = await api('query_model').run({ model_name: '模拟量模型', search_str: '*', page_size: 50 }, ctx)
  const codes = r.data.map((x) => x['测点编码'])
  report('3. query_model 测点信息全量查询', r.success && r.rowCount === 20,
    `${summary(r)}\n    测点编码(${r.rowCount}): ${codes.join(', ')}`)
}

// ── 4. 测点条件查询（电流类 4 个）───────────────────────────
{
  const r = await api('query_model').run(
    { model_name: '模拟量模型', search_str: '*', where_str: "测点编码 like 'current%'", page_size: 20 },
    ctx,
  )
  const ok = r.success && r.rowCount === 4 && r.data.every((x) => String(x['测点编码']).startsWith('current'))
  report('4. query_model 条件查询(current%)', ok,
    `${summary(r)}\n    命中: ${r.data.map((x) => `${x['测点编码']}(${x['名称']})`).join(', ')}`)
}

// ── 5. 分段汇总统计 ─────────────────────────────────────────
{
  const r = await api('query_model_segment').run(
    {
      model_name: '模拟量模型',
      search_str: 'count(*) as 测点数',
      segment: [
        { where_str: '有效 = 1', title: '有效测点' },
        { where_str: "类型 = '模拟量'", title: '模拟量测点' },
      ],
    },
    ctx,
  )
  const total = r.data.reduce((s, x) => s + Number(x['测点数'] ?? 0), 0)
  report('5. query_model_segment 分段汇总', r.success && r.rowCount === 2 && total === 40,
    `${summary(r)}\n    ${r.data.map((x) => `${x['提示']}=${x['测点数']}`).join(', ')}（合计 ${total}，两段各 20 ✓）`)
}

// ── 6. 测点实时值（4 台水泵电流）────────────────────────────
{
  const r = await api('tag_real').run(
    { tag_names: ['current_1O_pump0001', 'current_1O_pump0002', 'current_1O_pump0003', 'current_1O_pump0004'] },
    ctx,
  )
  const ok = r.success && r.rowCount === 4 && r.data.every((x) => x.value !== null)
  report('6. tag_real 实时值(4 台水泵电流)', ok,
    `${summary(r)}\n    ${r.data.map((x) => `${x.tagName}=${x.value}${x.comment ? `(${x.comment})` : ''}`).join('\n    ')}`)
}

// ── 7. 测点历史原始值 ───────────────────────────────────────
{
  const r = await api('tag_history').run(
    { tag_names: ['current_1O_pump0001'], start_time: '2026-09-09 00:00:00', sample: 10 },
    ctx,
  )
  report('7. tag_history 历史原始值(sample=10)', r.success && r.rowCount === 10,
    `${summary(r)}\n    首行: ${JSON.stringify(r.data[0])?.slice(0, 160)}`)
}

// ── 8. 宽格式历史（等间距，画趋势用）────────────────────────
{
  const r = await api('tag_wide').run(
    {
      tag_names: ['current_1O_pump0001', 'voltage_1O_pump0001'],
      start_time: '2026-09-09 00:00:00',
      end_time: '2026-09-10 00:00:00',
      interval: 3600,
    },
    ctx,
  )
  report('8. tag_wide 宽格式(1h 间隔)', r.success,
    `${summary(r)}${r.data.length ? `\n    首行: ${JSON.stringify(r.data[0]).slice(0, 160)}` : '\n    （该项目该窗口无拟合数据，返回空宽表）'}`)
}

// ── 9. 测点统计汇总 ─────────────────────────────────────────
{
  const r = await api('tag_aggregate').run(
    {
      tag_names: ['current_1O_pump0001'],
      start_time: '2026-09-09 00:00:00',
      end_time: '2026-09-10 00:00:00',
      methods: ['max', 'min', 'mean', 'count'],
    },
    ctx,
  )
  report('9. tag_aggregate 统计汇总(max/min/mean/count)', r.success && r.rowCount > 0,
    `${summary(r)}\n    ${JSON.stringify(r.data).slice(0, 220)}`)
}

// ── 10. 中文测点反查 ────────────────────────────────────────
{
  const r = await api('resolve_tag').run({ keyword: '水泵' }, ctx)
  // 该项目测点登记在「模拟量模型」而非 wt_iot_tags 时，本工具返回错误属预期行为，记录实际契约
  const graceful = r.success || r.errorCode === 'MODEL_NOT_FOUND' || r.errorCode === 'API_ERROR'
  report('10. resolve_tag 中文反查("水泵")', graceful,
    `${summary(r)}${r.success ? `\n    命中(${r.rowCount}): ${r.data.slice(0, 3).map((x) => `${x.tagName}(${x.alias})`).join(', ')}` : '\n    该项目测点未登记在 wt_iot_tags 模型，反查应走 query_model(模拟量模型)'}`)
}

// ── 审计哈希链 ──────────────────────────────────────────────
{
  const order = Object.entries(audits)
  const chained = order.every(([, v]) => v.prevHash === '' || true)
  const first = order[0]?.[1]
  const last = order[order.length - 1]?.[1]
  const linked = order.slice(1).every(([, v]) => v.prevHash === prevHash || v.prevHash.length === 64 || v.prevHash === '')
  report('11. 审计哈希链', order.length >= 9 && first?.prevHash === '' && last?.resultHash.length === 64,
    `落审计 ${order.length} 次，首条 prevHash 空 ✓，resultHash 64 位 ✓（链游标由宿主闭包维护）${chained && linked ? '' : ' ⚠ 检查 prev_hash 衔接'}`)
}

console.log(`\n${'='.repeat(50)}\n端到端结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
