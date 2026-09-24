/**
 * 值班报告工具单测：generate_duty_report / list_duty_stations。
 * AGP API 与 RAGFlow 全部 mock fetch；产物落 vitest 临时目录（用后清理）。
 * @module
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { RagflowClient } from '../src/clients/ragflow.ts'
import type { ToolContext } from '../tools/types.ts'
import type { AuditRow } from '../src/audit.ts'
import { dutyReportTool } from '../tools/duty-report.ts'
import { dutyStationsTool } from '../tools/duty-stations.ts'

const STATION_ARGS = {
  duty: {
    project: '桃曲坡水库',
    stations: [
      {
        id: 'TQP-DAM-SW',
        name: '桃曲坡水库坝上水位站',
        metrics: [{
          metric: 'water_level', label: '坝上水位', unit: 'm',
          tagName: 'TQPSW001_1O_1001', decimals: 2,
          thresholds: [{ level: '汛限', value: 786.8 }, { level: '警戒', value: 787.5 }],
        }],
      },
      {
        id: 'TQP-RAIN',
        name: '桃曲坡水库雨量站',
        metrics: [{
          metric: 'rainfall', label: '时段降雨量', unit: 'mm',
          tagName: 'TQPRN001_1O_1002', decimals: 1,
          thresholds: [{ level: '警戒雨量', value: 50 }],
        }],
      },
    ],
    reporting: [{ object: '市防指', channel: '专报', frequency: '每 2 小时' }],
  },
  query: {
    rest: {
      baseUrl: 'http://agp-gateway.example.com/iot-etl/iot',
      wtAppid: '10062',
      wtOpenid: 'openid-x',
      wtToken: 'token-y',
      fallbackToSql: false,
      maxPageSize: 1000,
    },
  },
}

const SHIFT = { shift_start: '2024-08-14T08:00', shift_end: '2024-08-14T20:00', shift_name: '白班' }

/** AGP API mock 响应（{code,data:[…]} 包装；POST /tag/realtime 主路形态）。 */
function agpRealtimeResponse(): Response {
  return new Response(JSON.stringify({
    code: 0,
    data: [
      { tagName: 'TQPSW001_1O_1001', value: 787.62, timestamp: '2024-08-14 08:00:00' },
      { tagName: 'TQPRN001_1O_1002', value: 32.5, timestamp: '2024-08-14 08:00:00' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface TestRig {
  ctx: ToolContext
  fetchImpl: ReturnType<typeof vi.fn>
  audits: AuditRow[]
  outputDir: string
  dispose(): Promise<void>
}

/** 装配一整套值班报告测试上下文（临时输出目录 + mock fetch）。 */
async function rig(options?: {
  agpFetch?: typeof fetch
  knowledgeFetch?: typeof fetch
  configOverrides?: Record<string, unknown>
}): Promise<TestRig> {
  const outputDir = await mkdtemp(join(tmpdir(), 'duty-report-test-'))
  const audits: AuditRow[] = []
  const fetchImpl = (options?.agpFetch ?? vi.fn(async () => agpRealtimeResponse())) as ReturnType<typeof vi.fn>
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    knowledge: options?.knowledgeFetch
      ? { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' }
      : { datasetIds: [] },
    ...STATION_ARGS,
    // configOverrides 最后展开：显式给出的 query/duty 段整体覆盖演示台账
    ...(options?.configOverrides ?? {}),
  })
  const executor = { execute: async () => ({ columns: [], rows: [] }) }
  const ctx: ToolContext = {
    config,
    executor,
    mysqlExecutor: executor,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(options?.knowledgeFetch
      ? { knowledge: new RagflowClient(config.knowledge, options.knowledgeFetch) }
      : {}),
    prevAuditHash: '',
    onAudit: (row) => audits.push(row as AuditRow),
    log: () => {},
  }
  return {
    ctx,
    fetchImpl,
    audits,
    outputDir,
    dispose: async () => { await rm(outputDir, { recursive: true, force: true }) },
  }
}

const DISPOSERS: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(DISPOSERS.map((d) => d()))
})

async function tracked(rigPromise: Promise<TestRig>): Promise<TestRig> {
  const r = await rigPromise
  DISPOSERS.push(r.dispose)
  return r
}

/** 输出目录改写到临时目录（配置仍走 duty.outputDir 正式链路）。 */
function withOutput(r: TestRig): void {
  r.ctx.config.duty.outputDir = r.outputDir
}

describe('generate_duty_report', () => {
  it('主链：AGP API 取数 → 超警戒命中 → 报告落盘 → 返回 pack_hash 与统计', async () => {
    const r = await tracked(rig())
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    expect(res.success).toBe(true)

    // 走 AGP API：POST /tag/realtime 主路（不做 SQL——executor 全程零调用）
    const calls = (r.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]!
    expect(String(url)).toBe('http://agp-gateway.example.com/iot-etl/iot/tag/realtime')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ tagNames: ['TQPSW001_1O_1001', 'TQPRN001_1O_1002'] })
    expect(init.headers).toMatchObject({ 'WT-APPID': '10062', 'WT-OPENID': 'openid-x', 'WT-TOKEN': 'token-y' })

    const row = res.data[0]!
    expect(row.telemetryCount).toBe(2)
    expect(row.ruleHitCount).toBe(1) // 水位 787.62 超警戒（787.5），雨量 32.5 未超
    expect(String(row.packHash)).toMatch(/^[0-9a-f]{16}$/)
    expect(String(row.validation)).toContain('通过')
    expect(String(row.filename)).toMatch(/^duty-report-桃曲坡水库-20240814-0800-白班\.html$/)

    const html = await readFile(String(row.path), 'utf8')
    expect(html).toContain('id="sec-telemetry"')
    expect(html).toContain('787.62')
    expect(html).toContain(String(row.packHash))
    expect(r.audits).toHaveLength(1)
    expect(r.audits[0]!.toolName).toBe('generate_duty_report')
  })

  it('AGP API 失败：不抛错、全部测点记缺口，报告按全缺口渲染（缺测不编造）', async () => {
    const r = await tracked(rig({
      agpFetch: vi.fn(async () => new Response('gateway down', { status: 503 })) as unknown as typeof fetch,
    }))
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    expect(res.success).toBe(true)
    const row = res.data[0]!
    expect(row.telemetryCount).toBe(0)
    expect(row.abstentionCount).toBe(4) // 1 条整体拉取失败 + 2 条逐测点缺测 + 1 条知识面未装配
    expect(row.ruleHitCount).toBe(0)
    const html = await readFile(String(row.path), 'utf8')
    expect(html).toContain('BACKEND_DOWN')
    expect(html).toContain('本班次无可用观测')
  })

  it('citations 入参优先（不走知识面）；未传且知识面装配时自动检索一次', async () => {
    const kbFetch = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        chunks: [
          { content_with_weight: '主汛期限制水位 786.80m。', doc_id: 'd1', docnm_kwd: '03-汛期调度运用计划.pdf', similarity: 0.9, page_num: 18 },
        ],
      },
    })) as unknown as typeof fetch
    const r = await tracked(rig({ knowledgeFetch: kbFetch }))
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    const row = res.data[0]!
    expect(row.citationCount).toBe(1)
    const html = await readFile(String(row.path), 'utf8')
    expect(html).toContain('03-汛期调度运用计划.pdf')
    expect(html).toContain('786.80')

    // citations 入参直通：不再调知识面
    const r2 = await tracked(rig({ knowledgeFetch: kbFetch }))
    withOutput(r2)
    const kbCallsBefore = (kbFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const res2 = await dutyReportTool.run({
      ...SHIFT,
      citations: [{ document: '规程X.pdf', snippet: '保证水位 788.40m', page: 3 }],
    }, r2.ctx)
    expect(res2.data[0]!.citationCount).toBe(1)
    expect((kbFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(kbCallsBefore)
  })

  it('知识面未装配：报告照常产出，缺口段记录 KNOWLEDGE_UNAVAILABLE', async () => {
    const r = await tracked(rig())
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    expect(res.success).toBe(true)
    const html = await readFile(String(res.data[0]!.path), 'utf8')
    expect(html).toContain('KNOWLEDGE_UNAVAILABLE')
    expect(String(res.data[0]!.limitations)).toContain('未引用规程条文')
  })

  it('POST 主路 404 → 回落 GET iotRealTimeValue（同 header、宽容解析）', async () => {
    const agpFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/tag/realtime')) return new Response('not found', { status: 404 })
      return jsonResponse([
        { tagName: 'TQPSW001_1O_1001', value: 785.1, timestamp: '2024-08-14 08:00:00' },
        { tagName: 'TQPRN001_1O_1002', value: 1.2, timestamp: '2024-08-14 08:00:00' },
      ])
    }) as unknown as typeof fetch
    const r = await tracked(rig({ agpFetch }))
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    expect(res.success).toBe(true)
    const calls = (r.fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    expect(calls).toHaveLength(2)
    expect(String(calls[1]![0])).toContain('/iotRealTimeValue?tagNames=')
    expect(res.data[0]!.telemetryCount).toBe(2)
    expect(res.data[0]!.ruleHitCount).toBe(0)
  })

  it('凭据环境变量回退：config 三头留空时用 AGP_API_OPENID/AGP_API_TOKEN', async () => {
    const prevOpenid = process.env.AGP_API_OPENID
    const prevToken = process.env.AGP_API_TOKEN
    process.env.AGP_API_OPENID = 'env-openid'
    process.env.AGP_API_TOKEN = 'env-token'
    try {
      const r = await tracked(rig({
        configOverrides: {
          query: { rest: { baseUrl: 'http://agp-gateway.example.com/iot-etl/iot', wtAppid: '', wtOpenid: '', wtToken: '', fallbackToSql: false, maxPageSize: 1000 } },
        },
      }))
      withOutput(r)
      await dutyReportTool.run({ ...SHIFT }, r.ctx)
      const headers = (r.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].headers
      expect(headers).toMatchObject({ 'WT-APPID': '10062', 'WT-OPENID': 'env-openid', 'WT-TOKEN': 'env-token' })
    } finally {
      if (prevOpenid === undefined) delete process.env.AGP_API_OPENID
      else process.env.AGP_API_OPENID = prevOpenid
      if (prevToken === undefined) delete process.env.AGP_API_TOKEN
      else process.env.AGP_API_TOKEN = prevToken
    }
  })

  it('未配置 baseUrl：报告按全缺口产出（缺测不编造），缺口段带 AGP API 未配置指引', async () => {
    const r = await tracked(rig({
      configOverrides: {
        query: { rest: { baseUrl: '', wtAppid: '', wtOpenid: '', wtToken: '', fallbackToSql: false, maxPageSize: 1000 } },
      },
    }))
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT }, r.ctx)
    expect(res.success).toBe(true)
    expect(res.data[0]!.telemetryCount).toBe(0)
    const html = await readFile(String(res.data[0]!.path), 'utf8')
    expect(html).toContain('AGP API 未配置')
    expect(html).toContain('本班次无可用观测')
  })

  it('台账为空 / 未知 station_ids / 时段非法：INVALID_PARAM', async () => {
    const noStations = await tracked(rig({
      configOverrides: { duty: { project: 'X', stations: [], reporting: [] } },
    }))
    const r1 = await dutyReportTool.run({ ...SHIFT }, noStations.ctx)
    expect(r1.errorCode).toBe('INVALID_PARAM')

    const r = await tracked(rig())
    const r2 = await dutyReportTool.run({ ...SHIFT, station_ids: ['NOPE'] }, r.ctx)
    expect(r2.errorCode).toBe('INVALID_PARAM')
    expect(r2.errorMessage).toContain('TQP-DAM-SW')

    const r3 = await dutyReportTool.run({ shift_start: 'bad', shift_end: '2024-08-14T20:00' }, r.ctx)
    expect(r3.errorCode).toBe('INVALID_PARAM')
  })

  it('station_ids 子集生效：只拉所选测点的 tagName', async () => {
    const r = await tracked(rig())
    withOutput(r)
    const res = await dutyReportTool.run({ ...SHIFT, station_ids: ['TQP-RAIN'] }, r.ctx)
    const body = JSON.parse(String((r.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].body))
    expect(body.tagNames).toEqual(['TQPRN001_1O_1002'])
    expect(res.data[0]!.stationCount).toBe(1)
  })
})

describe('list_duty_stations', () => {
  it('台账投影：站/指标/tagName/阈值档（等级映射回显）', async () => {
    const r = await tracked(rig())
    const res = await dutyStationsTool.run({}, r.ctx)
    expect(res.success).toBe(true)
    expect(res.rowCount).toBe(2)
    expect(res.data[0]).toMatchObject({ stationId: 'TQP-DAM-SW', metric: 'water_level', tagName: 'TQPSW001_1O_1001' })
    expect(String(res.data[0]!.thresholds)).toContain('汛限>=786.8')
    expect(String(res.data[0]!.thresholds)).toContain('黄色')
  })

  it('台账未配置：INVALID_PARAM 配置指引', async () => {
    const r = await tracked(rig({
      configOverrides: { duty: { project: '', stations: [], reporting: [] } },
    }))
    const res = await dutyStationsTool.run({}, r.ctx)
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('INVALID_PARAM')
    expect(res.errorMessage).toContain('duty.stations')
  })
})
