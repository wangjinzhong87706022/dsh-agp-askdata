/**
 * meta 查询接口健康普查（20260910 接口版）。
 *
 * 注意：数据行查询类接口要求**参数全传（值可空）**，缺任一参数报
 * `-1 系统内部出现错误`（2026-09-11 实测，与 commit 118108f 的
 * postModelDataMeta 教训一致）。本脚本按全参数调用。
 *
 * 用法（凭据走环境变量，不落盘）：
 *   AGP_API_TOKEN=... AGP_API_OPENID=... node scripts/meta-api-probe.mjs
 *
 * 另：Windows curl 命令行发中文参数会 GBK 乱码产生"没有找到模型"假错误，
 * 探测请用本脚本（Node UTF-8）。
 */

const base = `${process.env.AGP_API_BASE ?? 'https://www.openagp.top:9080'}/s1M6_uE9`
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'WT-TOKEN': process.env.AGP_API_TOKEN,
  'WT-OPENID': process.env.AGP_API_OPENID,
  'WT-APPID': '10462',
  'WT-PROJECTID': '10462',
  'WT-ROUTER': '#/',
}
if (!headers['WT-TOKEN'] || !headers['WT-OPENID']) {
  console.error('缺少 AGP_API_TOKEN / AGP_API_OPENID 环境变量')
  process.exit(1)
}
const get = async (path, params) => {
  const r = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(20000) })
  return r.json()
}
const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  return r.json()
}

let pass = 0, fail = 0
function report(name, ok, detail) {
  if (ok) pass++; else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '\n    ' + String(detail).slice(0, 300) : ''}`)
}
const brief = (j) => JSON.stringify(j?.data)?.slice(0, 260)

const MODEL = '模拟量模型'
const RELATION = '组织和用户的关系'

// 2.1 查询模型数据 GET（7 参数全传）
{
  const j = await get('/wz/meta/getModelDataMeta', {
    modelName: MODEL, searchStr: '*', whereStr: '',
    pageNum: '1', pageSize: '3', orderByStr: '', groupByStr: '',
  })
  report('getModelDataMeta GET(7参数全传)', j.code === 0, brief(j))
}

// 2.2 查询模型数据 POST
{
  const j = await post('/wz/meta/postModelDataMeta', {
    modelName: MODEL, searchStr: '*', whereStr: '',
    pageNum: 1, pageSize: 3, orderByStr: '', groupByStr: '',
  })
  report('postModelDataMeta POST', j.code === 0, brief(j))
}

// 2.3 模型基本属性 GET
{
  const j = await get('/wz/meta/getModelBasAttributes', { modelName: MODEL })
  report('getModelBasAttributes GET', j.code === 0, brief(j))
}

// 2.4 关系数据 GET（9 参数全传）
{
  const j = await get('/wz/meta/getRelationDataMeta', {
    relationName: RELATION, searchStr: '*', whereStr: '',
    pageNum: '1', pageSize: '3', orderByStr: '', groupByStr: '',
    leftModelName: '', rightModelName: '',
  })
  report('getRelationDataMeta GET(9参数全传)', j.code === 0, brief(j))
}

// 2.5 关系数据 POST
{
  const j = await post('/wz/meta/postRelationDataMeta', {
    relationName: RELATION, searchStr: '*', whereStr: '',
    orderByStr: '', groupByStr: '', pageNum: 1, pageSize: 3,
    leftModelName: '', rightModelName: '',
  })
  report('postRelationDataMeta POST', j.code === 0, brief(j))
}

// 2.6 关系基本属性 GET
{
  const j = await get('/wz/meta/getRelationBasAttributes', { relationName: RELATION })
  report('getRelationBasAttributes GET', j.code === 0, brief(j))
}

// 2.7 模型分段聚合 POST
{
  const j = await post('/wz/meta/postModelAggrigateData', {
    modelName: MODEL, searchStr: 'count(*) as 测点数',
    orderByStr: '', groupByStr: '',
    segment: [
      { whereStr: '有效 = 1', title: '有效测点' },
      { whereStr: "类型 = '模拟量'", title: '模拟量测点' },
    ],
  })
  report('postModelAggrigateData 模型分段聚合', j.code === 0, brief(j))
}

// 2.7b 关系分段聚合 POST
{
  const j = await post('/wz/meta/postRelationAggrigateData', {
    relationName: RELATION, searchStr: 'count(*) as 计数',
    orderByStr: '', groupByStr: '', leftModelName: '', rightModelName: '',
    pageNum: 1, pageSize: 100,
    segment: [{ whereStr: '1=1', title: '全部' }],
  })
  report('postRelationAggrigateData 关系分段聚合', j.code === 0, brief(j))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
