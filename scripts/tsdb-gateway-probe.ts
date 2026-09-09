/**
 * TSDB HTTP 网关连通性冒烟：三候选 base × 三 API。
 * 凭据从 pvConfig.json 进程内读取，不打印 token。
 */
import { readFileSync } from 'node:fs'

const pv = JSON.parse(readFileSync('D:/svn/WISETao_custom_demo/src/main/resources/pvConfig.json', 'utf8'))
const HEADERS = {
  'WT-APPID': '10062',
  'WT-OPENID': pv.wtOpenid,
  'WT-TOKEN': pv.wtToken,
}

const BASES = [
  'http://192.168.101.54/s1M6_uE9/wz/iot-etl/iot',
  'http://192.168.101.54:8040/iot-etl/iot',
  'http://192.168.101.54/s1M6_uE9/wz',
]

const TAG = 'HWNBYC174_1O_100620000001001'
const CALLS = [
  { name: 'iotRealTimeValue', q: `tagNames=${TAG}` },
  { name: 'getWideHistory', q: `tagNames=${TAG}&startTime=2024-08-10 00:00:00&endTime=2024-08-12 00:00:00&interval=86400` },
  { name: 'getTagAggrigateHistory', q: `tagNames=${TAG}&startTime=2024-08-10 00:00:00&endTime=2024-08-11 00:00:00&methods=max,min,mean` },
]

function mask(s, n = 240) {
  const t = String(s)
  return t.length <= n ? t : t.slice(0, n) + `…(${t.length}B)`
}

for (const base of BASES) {
  for (const call of CALLS) {
    const url = `${base}/${call.name}?${encodeURI(call.q)}`
    const started = Date.now()
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
      const body = await res.text()
      console.log(`\n=== ${base} / ${call.name}`)
      console.log(`HTTP ${res.status} ${res.headers.get('content-type') ?? ''} ${Date.now() - started}ms`)
      console.log(mask(body))
    } catch (err) {
      console.log(`\n=== ${base} / ${call.name}`)
      console.log(`FAIL ${Date.now() - started}ms: ${err.cause?.code ?? err.message}`)
    }
  }
}