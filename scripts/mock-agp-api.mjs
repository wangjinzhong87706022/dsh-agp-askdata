/**
 * Mock AGP API 网关（值班报告面 E2E 专用）。
 *
 * 实现两个端点（与 src/clients/tsdb-rest.ts 的调用形态对齐）：
 *   POST /tag/realtime           — MetaTagValueController 官方形态 {tagNames:[…]} → {code:0,data:[…]}
 *   GET  /iotRealTimeValue       — 老网关形态 ?tagNames=a,b → 顶层数组
 *
 * 鉴权三头缺失时返回 401（可测凭据回退）。数据为桃曲坡演示水情：
 * 坝上水位 787.62m（超警戒 787.5 → 橙色）、时段降雨 32.5mm（未超）、入库流量 128.4 m³/s。
 *
 * 用法：node scripts/mock-agp-api.mjs [port=8410] [waterLevel]
 */

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8410)
const waterLevel = Number(process.argv[3] ?? 787.62)
const observedAt = '2024-08-14 08:00:00'

const DATA = [
  { tagName: 'TQPSW001_1O_100620000030001', value: waterLevel, timestamp: observedAt },
  { tagName: 'TQPRN001_1O_100620000030002', value: 32.5, timestamp: observedAt },
  { tagName: 'TQPQF001_1O_100620000030003', value: 128.4, timestamp: observedAt },
]

function checkAuth(headers) {
  const appId = headers['wt-appid']
  const openid = headers['wt-openid']
  const token = headers['wt-token']
  if (!appId || !openid || !token) return 'missing WT-APPID/WT-OPENID/WT-TOKEN'
  return null
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const authError = checkAuth(req.headers)
  console.log(`[mock-agp] ${req.method} ${url.pathname}`)

  if (req.method === 'POST' && url.pathname.endsWith('/tag/realtime')) {
    if (authError) return send(res, 401, { code: 1, message: authError })
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let requested = null
      try { requested = JSON.parse(body)?.tagNames ?? null } catch { /* 形态坏 → 全量返回 */ }
      const rows = Array.isArray(requested) ? DATA.filter((d) => requested.includes(d.tagName)) : DATA
      console.log(`[mock-agp]   tagNames=${JSON.stringify(requested)} → ${rows.length} 行`)
      send(res, 200, { code: 0, data: rows })
    })
    return
  }

  if (req.method === 'GET' && url.pathname.endsWith('/iotRealTimeValue')) {
    if (authError) return send(res, 401, { code: 1, message: authError })
    const names = (url.searchParams.get('tagNames') ?? '').split(',').filter(Boolean)
    const rows = names.length > 0 ? DATA.filter((d) => names.includes(d.tagName)) : DATA
    send(res, 200, rows)
    return
  }

  send(res, 404, { code: 1, message: `mock-agp: no route ${req.method} ${url.pathname}` })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-agp] listening on http://127.0.0.1:${port} (水位=${waterLevel}m @ ${observedAt})`)
})
