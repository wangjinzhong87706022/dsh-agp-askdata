/**
 * TSDB 查询接口实测脚本（20260910 接口版）。
 *
 * 用法（凭据走环境变量，不落盘）：
 *   AGP_API_TOKEN=... AGP_API_OPENID=... node scripts/tsdb-api-probe.mjs
 *
 * 覆盖：实时值（新 getIOTTagRealValues）/ 历史原始值 / 宽格式 / 统计值 /
 * 模型分段聚合（postModelAggrigateData）。测点取自储能水泵项目（模拟量.xlsx）。
 */

const base = `${process.env.AGP_API_BASE ?? 'https://www.openagp.top:9080'}/s1M6_uE9`
const token = process.env.AGP_API_TOKEN
const openid = process.env.AGP_API_OPENID
if (!token || !openid) {
  console.error('缺少 AGP_API_TOKEN / AGP_API_OPENID 环境变量')
  process.exit(1)
}
const headers = {
  'Content-Type': 'application/json',
  'WT-TOKEN': token,
  'WT-OPENID': openid,
  'WT-APPID': '10462',
  'WT-PROJECTID': '10462',
  'WT-ROUTER': '#/',
}

async function get(path, params) {
  const qs = '?' + new URLSearchParams(params).toString()
  const r = await fetch(base + path + qs, { headers, signal: AbortSignal.timeout(20000) })
  return r.json()
}
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  return r.json()
}

let pass = 0, fail = 0
function report(name, ok, detail) {
  if (ok) pass++; else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '\n    ' + detail : ''}`)
}
function brief(json) {
  const d = json?.data
  if (d == null) return `data=null code=${json?.code} message=${json?.message}`
  if (d && Array.isArray(d.field)) {
    const rows = (d.data ?? []).slice(0, 3).map((r) => JSON.stringify(r).slice(0, 160))
    return `field=[${d.field.map((f) => `${f.name}(${f.type})`).join(', ')}] rows=${d.data?.length}${d.page ? ` page=${JSON.stringify(d.page)}` : ''}\n    ${rows.join('\n    ')}`
  }
  return JSON.stringify(d).slice(0, 300)
}

const TAGS = ['current_1O_pump0001', 'current_1O_pump0002', 'voltage_1O_pump0001']

// 1. 实时值（20260910：getTagRealValues → getIOTTagRealValues，QueryResult 形态）
{
  const j = await get('/wz/iot-etl/iot/getIOTTagRealValues', { tagNames: TAGS.join(',') })
  const rows = j?.data?.data ?? []
  report('getIOTTagRealValues 实时值', j.code === 0 && rows.length > 0, brief(j))
}

// 2. 历史原始值（sample 模式）
{
  const j = await get('/wz/iot-etl/iot/getTagRawHistory', {
    tagNames: 'current_1O_pump0001',
    startTime: '2026-09-09 00:00:00',
    sample: '10',
  })
  report('getTagRawHistory 历史原始值(sample=10)', j.code === 0, brief(j))
}

// 3. 历史原始值（endTime 模式）
{
  const j = await get('/wz/iot-etl/iot/getTagRawHistory', {
    tagNames: 'current_1O_pump0001',
    startTime: '2026-09-09 00:00:00',
    endTime: '2026-09-10 00:00:00',
  })
  report('getTagRawHistory 历史原始值(endTime)', j.code === 0, brief(j))
}

// 4. 宽格式历史（等间距）
{
  const j = await get('/wz/iot-etl/iot/getWideHistory', {
    tagNames: TAGS.join(','),
    startTime: '2026-09-09 00:00:00',
    endTime: '2026-09-10 00:00:00',
    interval: '3600',
  })
  report('getWideHistory 宽格式(interval=3600s)', j.code === 0, brief(j))
}

// 5. 历史统计值（网关要求 6 参数全传：endTime+sample 并存以 endTime 为准，params 空串占位）
{
  const j = await get('/wz/iot-etl/iot/getTagAggrigateHistory', {
    tagNames: 'current_1O_pump0001',
    startTime: '2026-09-09 00:00:00',
    endTime: '2026-09-10 00:00:00',
    sample: '10',
    methods: 'max,min,mean,count',
    params: '',
  })
  report('getTagAggrigateHistory 统计值(6参数全传)', j.code === 0, brief(j))
}

// 6. 模型分段聚合（20260910 新增 §2.7）
{
  const j = await post('/wz/meta/postModelAggrigateData', {
    modelName: '模拟量模型',
    searchStr: 'count(*) as 测点数',
    orderByStr: '',
    groupByStr: '',
    segment: [
      { whereStr: '有效 = 1', title: '有效测点' },
      { whereStr: "类型 = '模拟量'", title: '模拟量测点' },
    ],
  })
  report('postModelAggrigateData 模型分段聚合', j.code === 0, brief(j))
}

// 7. 关系分段聚合（20260910 新增；无真实关系名，验证错误路径可达）
{
  const j = await post('/wz/meta/postRelationAggrigateData', {
    relationName: '组织和用户的关系',
    searchStr: 'count(*) as 计数',
    leftModelName: '',
    rightModelName: '',
    segment: [{ whereStr: '1=1', title: '全部' }],
  })
  report('postRelationAggrigateData 关系分段聚合（可达性）', 'code' in j, `code=${j.code} message=${j.message}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
