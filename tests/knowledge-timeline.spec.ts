/**
 * knowledge_timeline 工具单测：时间归一排序、未定时附后、预算截断、keywords
 * 透传、空结果指引。全部 mock fetch（经 RagflowClient.fetchImpl 注入）。
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { RagflowClient } from '../src/clients/ragflow.ts'
import type { ToolContext } from '../tools/types.ts'
import type { AuditRow } from '../src/audit.ts'
import { knowledgeTimelineTool } from '../tools/knowledge-timeline.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 装配带 mock fetch 的 timeline ToolContext。 */
function ctx(fetchImpl: typeof fetch): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    knowledge: { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' },
  })
  const executor = { execute: async () => ({ columns: [], rows: [] }) }
  return {
    config,
    executor,
    mysqlExecutor: executor,
    knowledge: new RagflowClient(config.knowledge, fetchImpl),
    prevAuditHash: '',
    onAudit: () => {},
  }
}

const timelineBody = (entities: unknown[], relations: unknown[] = []) =>
  jsonResponse({ code: 0, data: { kind: 'timeline', templates: [{ entities, relations }] } })

const ent = (name: string, description = '', chunks = 1) => ({
  name, description, type: 'timestamp', mention_count: 1, aliases: [], source_chunk_ids: Array.from({ length: chunks }, (_, i) => `c${i}`),
})

describe('knowledge_timeline', () => {
  it('时间归一升序：年/月/日/时分混排按真实时间排序', async () => {
    const fetchImpl = vi.fn(async () => timelineBody([
      ent('2021-10-05', '洪峰 267 m³/s'),
      ent('1983', '历史洪水'),
      ent('2013-07-22 13:30', '报汛：流量 210'),
      ent('2020-08', '秋汛'),
    ]))
    const r = await knowledgeTimelineTool.run({}, ctx(fetchImpl as never))
    expect(r.success).toBe(true)
    const times = r.data.map(row => row.time)
    expect(times).toEqual(['1983', '2013-07-22 13:30', '2020-08', '2021-10-05'])
  })

  it('非时间名与无年份时刻归"未定时"附后，不混轴', async () => {
    const fetchImpl = vi.fn(async () => timelineBody([
      ent('2021-10-05', '洪峰'),
      ent('红星水库溢洪道进水口受损', '险情描述'),
      ent('09-08 14:00:00', '无年份报汛'),
    ]))
    const r = await knowledgeTimelineTool.run({}, ctx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data).toHaveLength(3)
    const times = r.data.map(row => row.time)
    expect(times[0]).toBe('2021-10-05')
    const undatedRows = r.data.filter(row => row.granularity === '未定时') as Array<Record<string, unknown>>
    expect(undatedRows).toHaveLength(2)
    expect(String(undatedRows[0]!.time)).toContain('红星水库')
    expect(String(undatedRows[0]!.event)).toContain('险情描述')
    expect(String(undatedRows[1]!.time)).toBe('09-08 14:00:00')
  })

  it('keywords 透传服务端；预算封顶时 apiOrSql 标注', async () => {
    const entities = Array.from({ length: 10 }, (_, i) => ent(`2021-09-${String(i + 1).padStart(2, '0')}`, `事件${i}`))
    const fetchImpl = vi.fn(async (_url: string) => timelineBody(entities))
    const configCtx = (() => {
      const config = resolveConfig({
        connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
        knowledge: { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k', maxGraphEntities: 4 },
      })
      const executor = { execute: async () => ({ columns: [], rows: [] }) }
      return {
        config,
        executor,
        mysqlExecutor: executor,
        knowledge: new RagflowClient(config.knowledge, fetchImpl as never),
        prevAuditHash: '',
        onAudit: () => {},
      }
    })()
    const r = await knowledgeTimelineTool.run({ keywords: '2021-09' }, configCtx)
    expect(r.success).toBe(true)
    expect(r.data).toHaveLength(4)
    expect(r.apiOrSql).toContain('仅展开 4/10')
    expect(r.apiOrSql).toContain('keywords="2021-09"')
    const [url] = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]!
    expect(url).toContain('keywords=')
    expect(url).toContain('kind=timeline')
  })

  it('空结果：成功返回指引行（timeline 未编译/无该时段）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { kind: 'timeline', templates: [] } }))
    const r = await knowledgeTimelineTool.run({ keywords: '1983' }, ctx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(String(r.data[0]!.event)).toContain('knowledge_search')
  })
})
