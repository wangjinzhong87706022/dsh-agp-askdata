/** 0911 新增工具：二号泵实时电流、三号泵昨日温度曲线（tool-layer E2E）。 */
import { createAskdataService } from '../src/index.ts'

const token = process.env.AGP_API_TOKEN
const openid = process.env.AGP_API_OPENID
if (!token || !openid) {
  console.error('缺少 AGP_API_TOKEN / AGP_API_OPENID')
  process.exit(1)
}

const service = createAskdataService({
  connection: { host: 'u', port: 9030, user: 'u', password: '', database: 'd' },
  audit: { enabled: true },
  api: {
    baseUrl: process.env.AGP_API_BASE ?? 'https://www.openagp.top:9080',
    apiPrefix: '/s1M6_uE9',
    token,
    openid,
    projectId: '10462',
  },
})
const ctx = service.createApiContext()
const api = (name) => {
  const t = service.apiTools.find((x) => x.name === name)
  if (!t) throw new Error(`未注册: ${name}`)
  return t
}
const brief = (r) => `success=${r.success} rows=${r.rowCount} ${r.errorCode ? `errorCode=${r.errorCode} ${r.errorMessage.slice(0, 80)}` : ''} ${r.executionMs}ms`

// === 问题 1：二号泵实时电流 ===
// 路径 A：用 object_tags 定位实体（按文档示例 whereStr 风格；预期 -1「内部编码」列限制）
console.log('1A object_tags(模拟量模型, 名称=第二台水泵电流):')
const q1a = await api('object_tags').run({ model_name: '模拟量模型', where_str: "名称 = '第二台水泵电流'" }, ctx)
console.log('   ', brief(q1a))
console.log('   ', JSON.stringify(q1a.data).slice(0, 300))

// 路径 B：直接 tag_real（tagName 已知：current_1O_pump0002）
console.log('\n1B tag_real(current_1O_pump0002):')
const q1b = await api('tag_real').run({ tag_names: ['current_1O_pump0002'] }, ctx)
console.log('   ', brief(q1b))
console.log('   ', JSON.stringify(q1b.data).slice(0, 300))

// === 问题 2：三号泵昨日一天温度曲线 ===
// 路径 A：tag_wide 等间距（昨天 = 2026-09-10）
console.log('\n2A tag_wide(temp_1O_pump0003, 昨天全天, 1h 间隔):')
const q2a = await api('tag_wide').run({
  tag_names: ['temp_1O_pump0003'],
  start_time: '2026-09-10 00:00:00',
  end_time: '2026-09-10 23:59:59',
  interval: 3600,
}, ctx)
console.log('   ', brief(q2a))
console.log('   首行:', JSON.stringify(q2a.data[0])?.slice(0, 200))
console.log('   末行:', JSON.stringify(q2a.data[q2a.data.length - 1])?.slice(0, 200))

// 路径 B：tag_history 原始值（1min 间隔，1440 行）
console.log('\n2B tag_history(temp_1O_pump0003, 昨天全天):')
const q2b = await api('tag_history').run({
  tag_names: ['temp_1O_pump0003'],
  start_time: '2026-09-10 00:00:00',
  end_time: '2026-09-10 23:59:59',
}, ctx)
console.log('   ', brief(q2b))
console.log('   首行:', JSON.stringify(q2b.data[0])?.slice(0, 200))