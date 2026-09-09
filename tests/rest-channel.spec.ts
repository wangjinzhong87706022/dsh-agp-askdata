/**
 * REST 通道（TSDB HTTP 网关）测试：解析器 + latest_value 通道选择/回落。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { parseRealtimeValue, fetchLatestValuesViaRest } from '../src/clients/tsdb-rest.ts'
import { resolveConfig, type AskdataConfig } from '../src/config.ts'
import type { SqlExecutor, ToolContext } from '../tools/types.ts'
import type { QueryOutput } from '../src/clients/starrocks.ts'
import { allTools } from '../tools/index.ts'

function restConfig(restOverrides: Record<string, unknown> = {}): AskdataConfig {
  return resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    query: {
      tsdbChannel: 'rest',
      rest: { baseUrl: 'http://gw.example.com/iot-etl/iot', wtAppid: '10062', wtToken: 't', wtOpenid: 'o', fallbackToSql: true, ...restOverrides },
    },
  })
}

function toolCtx(config: AskdataConfig, respond: (sql: string) => QueryOutput): ToolContext {
  const executor: SqlExecutor = { execute: async (sql) => respond(sql) }
  return {
    config,
    executor,
    mysqlExecutor: executor,
    prevAuditHash: '',
    onAudit: () => {},
  }
}

const latest = allTools.find((t) => t.name === 'latest_value')!

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('parseRealtimeValue（宽容解析）', () => {
  it('顶层数组 + 常见字段名', () => {
    const rows = parseRealtimeValue([
      { tagName: 'T1', value: '12.5', timestamp: '2024-08-14 18:13:38' },
      { tagname: 'T2', val: 3, time: '2024-08-14 18:08:38' },
    ])
    expect(rows).toEqual([
      { tagName: 'T1', latestValue: '12.5', latestTime: '2024-08-14 18:13:38' },
      { tagName: 'T2', latestValue: '3', latestTime: '2024-08-14 18:08:38' },
    ])
  })
  it('{code,data:[...]} 与 {data:{list:[...]}} 包装', () => {
    expect(parseRealtimeValue({ code: 0, data: [{ tagName: 'A', value: 1 }] })).toHaveLength(1)
    expect(parseRealtimeValue({ data: { list: [{ tagName: 'B', value: 2 }] } })).toHaveLength(1)
  })
  it('无可识别行 → BACKEND_DOWN（宁回落不编造）', () => {
    expect(() => parseRealtimeValue({ code: 0, data: [] })).toThrow(/没有可识别/)
    expect(() => parseRealtimeValue('not-json-object')).toThrow(/没有可识别/)
  })
})

describe('fetchLatestValuesViaRest', () => {
  const limits = { queryTimeoutMs: 5000 } as AskdataConfig['system']
  it('成功：URL/鉴权三头正确，行同 SQL 形态', async () => {
    let captured: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      captured = { url: String(url), headers: init?.headers ?? {} }
      return jsonResponse({ code: 0, data: [{ tagName: 'T1', value: '9.9', timestamp: '2024-08-14 18:13:38' }] })
    }) as typeof fetch
    const out = await fetchLatestValuesViaRest(restConfig().query, ['T1'], limits, { fetchImpl })
    expect(captured!.url).toBe('http://gw.example.com/iot-etl/iot/iotRealTimeValue?tagNames=T1')
    expect(captured!.headers['WT-APPID']).toBe('10062')
    expect(out.rows).toEqual([{ tagName: 'T1', latestValue: '9.9', latestTime: '2024-08-14 18:13:38' }])
  })
  it('HTTP 500 / 网络失败 → BACKEND_DOWN', async () => {
    const fail = (async () => new Response('boom', { status: 500 })) as typeof fetch
    await expect(fetchLatestValuesViaRest(restConfig().query, ['T1'], limits, { fetchImpl: fail })).rejects.toMatchObject({ code: 'BACKEND_DOWN' })
    const refused = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }) as unknown as typeof fetch
    await expect(fetchLatestValuesViaRest(restConfig().query, ['T1'], limits, { fetchImpl: refused })).rejects.toMatchObject({ code: 'BACKEND_DOWN' })
  })
})

describe('latest_value 通道选择', () => {
  it('tsdbChannel=rest 且网关成功 → 走 HTTP（apiOrSql 为 URL，channel=rest），不触 SQL', async () => {
    vi.stubGlobal('fetch', (async () => jsonResponse({ code: 0, data: [{ tagName: 'T_1O_1', value: '5', timestamp: '2024-08-14 10:00:00' }] })) as typeof fetch)
    try {
      const config = restConfig()
      const { ctx } = { ctx: toolCtx(config, () => { throw new Error('SQL 执行器不应被触达') }) }
      const result = await latest.run({ tag_names: ['T_1O_1'] }, ctx)
      expect(result.success).toBe(true)
      expect(result.apiOrSql).toContain('iotRealTimeValue')
      expect(result.data[0]).toEqual({ tagName: 'T_1O_1', latestValue: 5, latestTime: '2024-08-14 10:00:00' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rest 失败 + fallbackToSql → 回落 SQL（channel=sql，记录回落日志）', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }) as typeof fetch)
    try {
      const config = restConfig({ fallbackToSql: true })
      const { ctx } = { ctx: toolCtx(config, byIncludes([
        ['SELECT tagName FROM WT_TAG', { columns: ['tagName'], rows: [{ tagName: 'T_1O_1' }] }],
        ['max_by', {
          columns: ['tagName', 'latestValue', 'latestTime'],
          rows: [{ tagName: 'T_1O_1', latestValue: '1', latestTime: '2024-08-14 10:00:00' }],
        }],
      ])) }
      const logs: string[] = []
      const result = await latest.run({ tag_names: ['T_1O_1'] }, { ...ctx, log: (m) => logs.push(m) })
      expect(result.success).toBe(true)
      expect(result.apiOrSql).toContain('max_by')
      expect(logs.some((m) => m.includes('回落 SQL'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rest 失败 + fallbackToSql=false → BACKEND_DOWN，不触 SQL', async () => {
    vi.stubGlobal('fetch', (async () => new Response('x', { status: 503 })) as typeof fetch)
    try {
      const config = restConfig({ fallbackToSql: false })
      const { ctx } = { ctx: toolCtx(config, () => { throw new Error('SQL 执行器不应被触达') }) }
      const result = await latest.run({ tag_names: ['T_1O_1'] }, ctx)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('BACKEND_DOWN')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('useAggregateTable=false → 1H 粒度也不路由 WT_CUBE', async () => {
    const config = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      query: { useAggregateTable: false },
    })
    const { ctx } = { ctx: toolCtx(config, byIncludes([
      ['SELECT COUNT(*)', { columns: ['scanRows'], rows: [{ scanRows: '10' }] }],
      ['SELECT tagIndex', { columns: ['tagIndex'], rows: [{ tagIndex: '1' }] }],
      ['SELECT DISTINCT cubeType', { columns: ['cubeType'], rows: [] }],
      ['AS `aggValue`', {
        columns: ['bucket', 'aggValue', 'sampleCount'],
        rows: [{ bucket: 'all', aggValue: '1', sampleCount: '1' }],
      }],
    ])) }
    const aggregate = allTools.find((t) => t.name === 'aggregate')!
    const result = await aggregate.run(
      {
        tag_filter: '^HWNBYC174_1H_100620000015521',
        start_time: '2024-08-01T00:00:00+08:00',
        end_time: '2024-08-02T00:00:00+08:00',
        func: 'AVG',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.apiOrSql).not.toContain('WT_CUBE')
    expect(result.apiOrSql).not.toContain('SELECT DISTINCT cubeType')
  })
})

function byIncludes(map: Array<[string, QueryOutput]>): (sql: string) => QueryOutput {
  return (sql) => {
    const hit = map.find(([needle]) => sql.includes(needle))
    if (!hit) throw new Error(`fake executor: 未匹配的 SQL: ${sql.slice(0, 80)}`)
    return hit[1]
  }
}
