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

/** 装配带 mock fetch 的知识面 ToolContext（审计开，收集审计行；overrides 直传 resolveConfig）。 */
function knowledgeCtx(
  fetchImpl: typeof fetch,
  audits: AuditRow[] = [],
  overrides: Partial<Parameters<typeof resolveConfig>[0]> = {},
): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    knowledge: { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' },
    audit: { enabled: true },
    ...overrides,
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
  it('命中：证据行带出处/相关度/内容与溯源锚（documentId/positions），审计落行带 apiUrl', async () => {
    const audits: AuditRow[] = []
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        chunks: [
          { content_with_weight: '主汛期汛限水位为 786.8m。', document_id: 'd1', document_keyword: '调度规程', similarity: 0.93, positions: [[18, 108, 255, 221, 236]], image_id: 'img-abc123' },
          { content_with_weight: '防洪标准 100 年一遇。', document_id: 'd2', document_keyword: '预案', similarity: 0.81 },
        ],
      },
    }))
    const r = await knowledgeSearchTool.run({ query: '主汛期汛限水位是多少' }, knowledgeCtx(fetchImpl as never, audits))
    expect(r.success).toBe(true)
    expect(r.rowCount).toBe(2)
    expect(r.data[0]).toMatchObject({ rank: 1, document: '调度规程', documentId: 'd1', similarity: 0.93 })
    expect(String(r.data[0]!.content)).toContain('786.8m')
    // 溯源锚原样透出：positions 为 JSON 数组（模型照抄进 citations 围栏），缺失整体省略
    expect(r.data[0]!.positions).toEqual([[18, 108, 255, 221, 236]])
    expect(r.data[0]!.imageId).toBe('img-abc123')
    expect(r.data[1]).not.toHaveProperty('positions')
    expect(r.data[1]).not.toHaveProperty('imageId')
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
  it('node 模式：实体行 + 关联串带方向与谓词，中心实体排第一', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        entities: [
          { slug: 'entity/沮河', name: '沮河', description: '河流' },
          { slug: 'entity/桃曲坡水库', name: '桃曲坡水库', description: '中型水库，总库容 5720 万 m³' },
          { slug: 'entity/水库管理局', name: '水库管理局', description: '管理机构' },
        ],
        relations: [
          { from: 'entity/桃曲坡水库', to: 'entity/沮河', predicate: '位于' },
          { from: 'entity/水库管理局', to: 'entity/桃曲坡水库', predicate: '管理' },
        ],
      },
    }))
    const r = await knowledgeGraphTool.run({ entity: '桃曲坡水库' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    expect(r.data[0]).toMatchObject({ entity: '桃曲坡水库', relations: '→沮河(位于)、←水库管理局(管理)' })
    expect(String(r.data[0]!.description)).toContain('5720')
    // 沮河行：入边来自中心实体，方向反向
    const rowJu = r.data.find((row) => row.entity === '沮河')
    expect(String(rowJu!.relations)).toBe('←桃曲坡水库(位于)')
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

  it('部分数据集失败：apiOrSql 标注 N/M 数据集失败（审计可见）', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/ds1/')) {
        return jsonResponse({ code: 0, data: { entities: [{ slug: 'entity/A', name: 'A', description: '' }], relations: [] } })
      }
      return jsonResponse({ code: 100, message: 'boom' })
    })
    const r = await knowledgeGraphTool.run(
      { keywords: 'x' },
      knowledgeCtx(fetchImpl as never, [], { knowledge: { datasetIds: ['ds1', 'ds2'] } }),
    )
    expect(r.success).toBe(true)
    expect(r.apiOrSql).toContain('1/2 数据集失败')
  })

  it('单实体关联边超 30 条：截断并标注总数', async () => {
    const entities = [
      { slug: 'entity/A', name: 'A', description: '枢纽实体' },
      ...Array.from({ length: 31 }, (_, i) => ({ slug: `entity/T${i}`, name: `T${i}`, description: '' })),
    ]
    const relations = Array.from({ length: 31 }, (_, i) => ({ from: 'entity/A', to: `entity/T${i}` }))
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { entities, relations } }))
    const r = await knowledgeGraphTool.run({ entity: 'A' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    const rowA = r.data.find((row) => row.entity === 'A')
    expect(String(rowA!.relations)).not.toContain('T30')
    expect(String(rowA!.relations)).toContain('共 31 条关联')
    expect(String(rowA!.relations)).toContain('仅列前 30 条')
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

  it('全部数据集业务失败：工具返回失败（不冒充"页面不存在"）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 100, message: 'Authentication failed' }))
    const r = await knowledgeWikiPageTool.run({ slug: 'entity/桃曲坡水库' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('BACKEND_DOWN')
    expect(r.errorMessage).toContain('code=100')
  })

  it('正文超长截断带原文长度注记；出链超 30 条带计数', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        slug: 'entity/桃曲坡水库', title: '桃曲坡水库', page_type: 'entity', topic: 't', summary: 's',
        content_md_rendered: '长'.repeat(5000),
        outlinks: Array.from({ length: 35 }, (_, i) => `entity/L${i}`),
        related_kb_pages: ['沮河'],
      },
    }))
    const r = await knowledgeWikiPageTool.run({ slug: 'entity/桃曲坡水库' }, knowledgeCtx(fetchImpl as never))
    expect(r.success).toBe(true)
    const content = String(r.data[0]!.content)
    expect(content).toContain('截断')
    expect(content).toContain('共 5000 字')
    expect(String(r.data[0]!.outlinks)).toContain('共 35 条')
    expect(String(r.data[0]!.outlinks)).toContain('entity/L29')
    expect(String(r.data[0]!.outlinks)).not.toContain('entity/L30、')
  })
})

describe('知识工具 previewLimit 声明', () => {
  it('预算旋钮即截断旋钮：知识工具自声明 previewLimit，不落 system.defaultPreviewLimit=20', () => {
    expect(knowledgeSearchTool.previewLimit).toBe(51)
    expect(knowledgeGraphTool.previewLimit).toBe(1024)
    expect(knowledgeMindmapTool.previewLimit).toBe(1024)
    expect(knowledgeWikiPageTool.previewLimit).toBe(5)
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

  it('节点预算截断：apiOrSql 注明仅展开 N/M 节点', async () => {
    const entities = Array.from({ length: 10 }, (_, i) => ({ name: `N${i}`, type: 'sub_branch', description: '', mention_count: 1, aliases: [], source_chunk_ids: [] }))
    const relations = entities.slice(0, -1).map((e, i) => ({ from: e.name, to: `N${i + 1}`, type: 'has_branch' }))
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { kind: 'mindmap', templates: [{ entities, relations }] } }))
    const r = await knowledgeMindmapTool.run(
      {},
      knowledgeCtx(fetchImpl as never, [], { knowledge: { datasetIds: ['ds1'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k', maxGraphEntities: 4 } }),
    )
    expect(r.success).toBe(true)
    expect(r.apiOrSql).toContain('仅展开 4/10 节点')
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
