import { writeFileSync } from 'fs'
const base = 'https://www.openagp.top:9080/s1M6_uE9'
const token = process.env.AGP_API_TOKEN
const openid = process.env.AGP_API_OPENID
const headers = { 'Content-Type': 'application/json', 'WT-TOKEN': token, 'WT-OPENID': openid, 'WT-PROJECTID': '10462' }

async function get(path) { const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) }); return r.json() }
async function post(path, body) { const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); return r.json() }

const models = ['资产基础模型', '组织基础模型']
const result = {}

for (const m of models) {
  console.log(`\n=== ${m} ===`)
  // 查属性
  const attrs = await get('/wz/meta/getModelBasAttributes', { modelName: m })
  console.log('属性:', attrs.data?.field?.map(f => `${f.field_name}(${f.field_description})`).join(', '))

  // 查数据（前 5 条）
  const data = await post('/wz/meta/postModelDataMeta', {
    modelName: m, searchStr: '*', whereStr: '',
    pageNum: 1, pageSize: 5, orderByStr: '', groupByStr: '',
  })
  if (data.code === 0) {
    const fields = data.data.field.map(f => ({ name: f.name, title: f.title, type: f.type }))
    const rows = data.data.data
    console.log('字段数:', fields.length, '总行数:', data.data.page.itemTotal)
    console.log('字段:', fields.map(f => f.name).join(', '))
    console.log('样本:')
    for (const row of rows) {
      const summary = {}
      for (const f of fields) {
        if (row[f.name] !== null && row[f.name] !== undefined && row[f.name] !== '') {
          summary[f.name] = row[f.name]
        }
      }
      console.log(JSON.stringify(summary).slice(0, 300))
    }
    result[m] = { fields, sampleRows: rows, total: data.data.page.itemTotal }
  }
}

writeFileSync('E:/git/dsh-agp-askdata-schema-validation/docs/models-detail.json', JSON.stringify(result, null, 2))
console.log('\n已保存到 docs/models-detail.json')