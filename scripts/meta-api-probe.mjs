/** 0910 接口 12 接口健康普查（UTF-8 干净通道；凭据走环境变量）。 */
const base = process.env.AGP_API_BASE ?? 'https://www.openagp.top:9080/s1M6_uE9'
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'WT-TOKEN': process.env.AGP_API_TOKEN,
  'WT-OPENID': process.env.AGP_API_OPENID,
  'WT-APPID': '10462',
  'WT-PROJECTID': '10462',
  'WT-ROUTER': '#/',
}
const get = async (p, params) => {
  const r = await fetch(`${base}${p}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(15000) })
  return r.json()
}
const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  return r.json()
}
const brief = (j) => JSON.stringify(j)?.slice(0, 260)

console.log('=== 2.1 getModelDataMeta GET (模拟量模型):')
console.log(brief(await get('/wz/meta/getModelDataMeta', { modelName: '模拟量模型', searchStr: '*', pageSize: '2' })))
console.log('=== 2.2 postModelDataMeta POST:')
console.log(brief(await post('/wz/meta/postModelDataMeta', { modelName: '模拟量模型', searchStr: '*', whereStr: '', pageNum: 1, pageSize: 2, orderByStr: '', groupByStr: '' })))
console.log('=== 2.3 getModelBasAttributes GET:')
console.log(brief(await get('/wz/meta/getModelBasAttributes', { modelName: '模拟量模型' })))
console.log('=== 2.4 getRelationDataMeta GET (组织和用户的关系):')
console.log(brief(await get('/wz/meta/getRelationDataMeta', { relationName: '组织和用户的关系', searchStr: '*', pageSize: '2' })))
console.log('=== 2.6 getRelationBasAttributes GET:')
console.log(brief(await get('/wz/meta/getRelationBasAttributes', { relationName: '组织和用户的关系' })))
console.log('=== 2.5 postRelationDataMeta POST:')
console.log(brief(await post('/wz/meta/postRelationDataMeta', { relationName: '组织和用户的关系', searchStr: '*', whereStr: '', orderByStr: '', groupByStr: '', pageNum: 1, pageSize: 2, leftModelName: '', rightModelName: '' })))
