/**
 * 知识面工具单测：knowledge_search / knowledge_graph / knowledge_wiki_page。
 * 全部 mock fetch（经 RagflowClient.fetchImpl 注入），不触网。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { RagflowClient } from '../src/clients/ragflow.ts'
import type { ToolContext } from '../tools/types.ts'
import type { AuditRow } from '../src/audit.ts'
import { knowledgeSearchTool } from '../tools/knowledge-search.ts'
import { knowledgeGraphTool } from '../tools/knowledge-graph.ts'
import { knowledgeWikiPageTool } from '../tools/knowledge-wiki-page.ts'
import { knowledgeMindmapTool } from '../tools/knowledge-mindmap.ts'
import { askdataDeepAnalysisTool } from '../tools/deep-analysis.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 取 mock fetch 第 n 次调用的请求体（JSON.parse 后）。 */
function callBody(fetchImpl: unknown, n: number): Record<string, unknown> {
  const calls = (fetchImpl as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
  return JSON.parse(String(calls[n]![1].body)) as Record<string, unknown>
}

/** 装配带 mock fetch 的知识面 ToolContext（审计开，收集审计行）。 */
function knowledgeCtx(fetchImpl: typeof fetch, audits: AuditRow[] = []): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    knowledge: { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' },
    audit: { enabled: true },
  })
  const executor = { execute: async () => ({ columns: [], rows: [] }) }
  return {
    config,
    executor,
    mysqlExecutor: executor,
    knowledge: new RagflowClient(config.knowledge, fetchImpl),
    prevAuditHash: '',
    onAudit: (row) => audits.push(row as AuditRow),
  }
}

describe('knowledge_search', () => {
  it('命中：证据行带出处/相关度/内容，审计落行带 apiUrl', async () => {
    const audits: AuditRow[] = []
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        chunks: [
          { content_with_weight: '主汛期汛限水位为 786.8m。', document_id: 'd1', document_keyword: '调度规程', similarity: 0.93 },
          { content_with_weight: '防洪标准 100 年一遇。', document_id: 'd2', document_keyword: '预案', similarity: 0.81 },
        ],
      },
    }))
    const r = await knowledgeSearchTool.run({ query: '主汛期汛限水位是多少' }, knowledgeCtx(fetchImpl as never, audits))
    expect(r.success).toBe(true)
    expect(r.rowCount).toBe(2)
    expect(r.data[0]).toMatchObject({ rank: 1, document: '调度规程', similarity: 0.93 })
    expect(String(r.data[0]!.content)).toContain('786.8m')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.apiUrl).toContain('/api/v1/datasets/search')
    expect(audits[0]!.sqlText).toContain('/datasets/search')
  })

  it('空结果：成功返回一行指引（不是错误）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const r = await knowledgeSearchTool.run({ query: '无人知晓的问题' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data).toHaveLength(1)
    expect(String(r.data[0]!.content)).toContain('没有检索到')
  })

  it('query 为空 → INVALID_PARAM', async () => {
    const fetchImpl = vi.fn()
    const r = await knowledgeSearchTool.run({ query: '  ' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('INVALID_PARAM')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('知识面未装配：明确失败（不抛异常逃出工具边界）', async () => {
    const config = resolveConfig({ connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' } })
    const ctx: ToolContext = { config, executor: { execute: async () => ({ columns: [], rows: [] }) }, mysqlExecutor: { execute: async () => ({ columns: [], rows: [] }) } }
    const r = await knowledgeSearchTool.run({ query: 'x' }, ctx)
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('BACKEND_DOWN')
    expect(r.errorMessage).toContain('知识面')
  })

  it('出处文档来自线上 doc_id/docnm_kwd 契约', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: '主汛期限制水位786.80m', doc_id: 'd1', docnm_kwd: '03-汛期调度运用计划.pdf', similarity: 0.9 }] },
    }))
    const r = await knowledgeSearchTool.run({ query: '汛限水位' }, knowledgeCtx(fetchImpl as never))
    expect(r.data[0]).toMatchObject({ document: '03-汛期调度运用计划.pdf' })
  })

  it('labels 标签分布渲染为汇总行（rank=0）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        chunks: [{ content_with_weight: '证据', doc_id: 'd', docnm_kwd: 'n', similarity: 0.9 }],
        labels: { '2021-09': 2, '洪水资料': 1 },
      },
    }))
    const r = await knowledgeSearchTool.run({ query: '降雨' }, knowledgeCtx(fetchImpl as never))
    expect(r.data).toHaveLength(2)
    expect(r.data[0]).toMatchObject({ rank: 0, document: '（命中标签）' })
    expect(String(r.data[0]!.content)).toContain('2021-09×2')
  })

  it('meta_filter 透传服务端 meta_data_filter', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: '证据', doc_id: 'd', docnm_kwd: 'n', similarity: 0.9 }] },
    }))
    const r = await knowledgeSearchTool.run(
      { query: '2021年9月洪水降雨量', meta_filter: [{ key: 'flood_event', op: '=', value: '2021-09' }] },
      knowledgeCtx(fetchImpl as never),
    )
    expect(r.success).toBe(true)
    expect(r.apiOrSql).toContain('meta=')
    const body = callBody(fetchImpl, 0)
    const filter = body.meta_data_filter as { logic: string; conditions: Array<Record<string, unknown>> }
    expect(filter).toMatchObject({ method: 'manual', logic: 'and' })
    expect(filter.conditions[0]).toMatchObject({ key: 'flood_event', value: '2021-09' })
  })

  it('top_k 封顶生效：服务端返回 30 条，top_k=2 只出 2 行', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: Array.from({ length: 30 }, (_, i) => ({ content_with_weight: `片段${i}`, doc_id: 'd', docnm_kwd: 'n' })) },
    }))
    const r = await knowledgeSearchTool.run({ query: 'q', top_k: 2 }, knowledgeCtx(fetchImpl as never))
    expect(r.rowCount).toBe(2)
  })
})

describe('knowledge_graph', () => {
  it('node 模式：实体行 + 关联串，中心实体排第一', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        entities: [
          { slug: 'entity/沮河', name: '沮河', description: '河流' },
          { slug: 'entity/桃曲坡水库', name: '桃曲坡水库', description: '中型水库，总库容 5720 万 m³' },
        ],
        relations: [{ from: 'entity/桃曲坡水库', to: 'entity/沮河' }],
      },
    }))
    const r = await knowledgeGraphTool.run({ entity: '桃曲坡水库' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data[0]).toMatchObject({ entity: '桃曲坡水库', relations: '沮河' })
    expect(String(r.data[0]!.description)).toContain('5720')
  })

  it('entity 与 keywords 都缺 → INVALID_PARAM', async () => {
    const r = await knowledgeGraphTool.run({}, knowledgeCtx(vi.fn() as never))
    expect(r.errorCode).toBe('INVALID_PARAM')
  })

  it('空图谱：成功返回一行指引', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { entities: [], relations: [] } }))
    const r = await knowledgeGraphTool.run({ entity: '不存在的实体' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(String(r.data[0]!.description)).toContain('没有检索到相关实体')
  })
})

describe('knowledge_wiki_page', () => {
  it('slug 直取：标题/正文/出链投影', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        slug: 'entity/桃曲坡水库', title: '桃曲坡水库', page_type: 'entity', topic: '水库运行管理',
        summary: '综合利用中型水库', content_md_rendered: '**桃曲坡水库**位于陕西省…',
        outlinks: ['entity/沮河', 'entity/铜川市'], related_kb_pages: ['沮河'],
        source_chunk_ids: ['c1'], source_doc_ids: ['d1'],
      },
    }))
    const r = await knowledgeWikiPageTool.run({ slug: 'entity/桃曲坡水库' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data[0]).toMatchObject({
      title: '桃曲坡水库',
      topic: '水库运行管理',
      outlinks: 'entity/沮河、entity/铜川市',
    })
  })

  it('页面不存在：成功返回一行指引', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: null }))
    const r = await knowledgeWikiPageTool.run({ slug: 'entity/不存在' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(String(r.data[0]!.summary)).toContain('没有该 wiki 页面')
  })
})

describe('knowledge_mindmap', () => {
  const mindmapBody = {
    code: 0,
    data: {
      kind: 'mindmap',
      templates: [{
        entities: [
          { name: '桃曲坡水库防洪抢险应急预案', type: 'central_topic', description: '预案中心主题', mention_count: 1, aliases: [], source_chunk_ids: [] },
          { name: '应急响应', type: 'branch', description: '响应分级', mention_count: 1, aliases: [], source_chunk_ids: [] },
          { name: 'I级响应', type: 'sub_branch', description: '超标准洪水与重大险情', mention_count: 1, aliases: [], source_chunk_ids: [] },
        ],
        relations: [
          { from: '桃曲坡水库防洪抢险应急预案', to: '应急响应', type: 'has_branch' },
          { from: '应急响应', to: 'I级响应', type: 'has_sub_branch' },
        ],
      }],
    },
  }

  it('层级展开：path 带祖先路径，central_topic 排第一', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mindmapBody))
    const r = await knowledgeMindmapTool.run({}, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data).toHaveLength(3)
    expect(r.data[0]).toMatchObject({ level: 0, node: '桃曲坡水库防洪抢险应急预案', path: '桃曲坡水库防洪抢险应急预案' })
    expect(r.data[2]).toMatchObject({ level: 2, node: 'I级响应', path: '桃曲坡水库防洪抢险应急预案 > 应急响应 > I级响应' })
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('kind=mindmap')
  })

  it('keywords 透传服务端过滤分支', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mindmapBody))
    const r = await knowledgeMindmapTool.run({ keywords: '应急响应' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('keywords=')
    expect(r.apiOrSql).toContain('keywords="应急响应"')
  })

  it('空脑图：成功返回一行指引（降级建议 knowledge_search/graph）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { kind: 'mindmap', templates: [] } }))
    const r = await knowledgeMindmapTool.run({ keywords: '不存在' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(String(r.data[0]!.description)).toContain('knowledge_search')
  })
})

describe('askdata_deep_analysis 知识融合', () => {
  it('纯知识问题：流水线只走 knowledge_search，证据行进 data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: '主汛期汛限水位 786.8m', document_id: 'd1', document_keyword: '调度规程', similarity: 0.9 }] },
    }))
    const r = await askdataDeepAnalysisTool.run(
      { question: '桃曲坡水库主汛期的汛限水位是多少？给出规程依据。' },
      knowledgeCtx(fetchImpl as never),
    )
    expect(r.success).toBe(true)
    const tools = (r.data as Record<string, unknown>[]).filter((row) => 'tool' in row).map((row) => row.tool)
    expect(tools).toEqual(['knowledge_search'])
    const evidence = (r.data as Record<string, unknown>[]).find((row) => row._tool === 'knowledge_search')
    expect(String(evidence?.content)).toContain('786.8m')
  })

  it('取数+依据混合问题：knowledge_search 先行，取数步骤照常', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/datasets/search')) {
        return jsonResponse({ code: 0, data: { chunks: [{ content_with_weight: '依据片段', document_id: 'd1', document_keyword: '规程', similarity: 0.9 }] } })
      }
      return jsonResponse({ code: 0, data: { chunks: [] } })
    })
    const r = await askdataDeepAnalysisTool.run(
      { question: '按规程要求，1号逆变器当前功率是多少？' },
      knowledgeCtx(fetchImpl as never),
    )
    expect(r.success).toBe(true)
    const tools = (r.data as Record<string, unknown>[]).filter((row) => 'tool' in row).map((row) => row.tool)
    expect(tools[0]).toBe('knowledge_search')
    expect(tools).toContain('latest_value')
  })

  it('知识面未装配：纯知识问题降级走取数面默认分支（不炸）', async () => {
    const config = resolveConfig({ connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' } })
    const executor = { execute: async () => ({ columns: ['tagName'], rows: [{ tagName: 'X_1D_1' }] }) }
    const ctx: ToolContext = { config, executor, mysqlExecutor: executor, prevAuditHash: '', onAudit: () => {} }
    const r = await askdataDeepAnalysisTool.run({ question: '规程里怎么规定' }, ctx)
    expect(r.success).toBe(true)
    const tools = (r.data as Record<string, unknown>[]).filter((row) => 'tool' in row).map((row) => row.tool)
    expect(tools).toEqual(['lookup_tag'])
  })
})
