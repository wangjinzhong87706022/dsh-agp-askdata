/**
 * RAGFlow 知识面客户端单测：契约对齐（code≠0、取消/超时、多数据集合并）。
 * 全部 mock fetch，不触网。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { RagflowClient, RagflowApiError, entitySlug, slugName } from '../src/clients/ragflow.ts'
import { resolveKnowledgeConfig } from '../src/config.ts'

function client(overrides?: Partial<Parameters<typeof resolveKnowledgeConfig>[0]>, fetchImpl?: typeof fetch) {
  const config = resolveKnowledgeConfig({
    ragflowBaseUrl: 'https://ragflow.example.com',
    ragflowApiKey: 'test-key',
    datasetIds: ['ds1', 'ds2'],
    ...overrides,
  })
  return new RagflowClient(config, fetchImpl)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 取 mock fetch 第 n 次调用的请求体（JSON.parse 后）。 */
function callBody(fetchImpl: unknown, n: number): Record<string, unknown> {
  const calls = (fetchImpl as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
  return JSON.parse(String(calls[n]![1].body)) as Record<string, unknown>
}

describe('RagflowClient.searchChunks（POST /datasets/search）', () => {
  it('业务失败（HTTP 200 + code≠0）抛 RagflowApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 100, message: 'dataset not found' }))
    await expect(client(undefined, fetchImpl as never).searchChunks('问题')).rejects.toThrow(RagflowApiError)
  })

  it('投影 chunks：content_with_weight 优先、相似度数值化、空正文过滤', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        chunks: [
          { content_with_weight: '主汛期汛限水位 786.8m', doc_id: 'doc1', docnm_kwd: '调度规程.pdf', similarity: '0.9123', chunk_id: 'ck1', positions: [[18, 108, 255, 221, 236]] },
          { content: '   ', doc_id: 'doc2' },
        ],
      },
    }))
    const { chunks } = await client(undefined, fetchImpl as never).searchChunks('汛限水位')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      content: '主汛期汛限水位 786.8m',
      documentId: 'doc1',
      documentName: '调度规程.pdf',
      similarity: 0.9123,
      chunkId: 'ck1',
    })
    expect(chunks[0]!.positions).toEqual([[18, 108, 255, 221, 236]])
  })

  it('出处字段双契约：线上 doc_id/docnm_kwd 与旧版 document_id/document_keyword 都认', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: 'x', document_id: 'legacyDoc', document_keyword: 'legacy.pdf' }] },
    }))
    const { chunks } = await client(undefined, fetchImpl as never).searchChunks('q')
    expect(chunks[0]).toMatchObject({ documentId: 'legacyDoc', documentName: 'legacy.pdf' })
  })

  it('top_k 客户端封顶：服务端返回 30 条也只取 topK（预算真实生效）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: Array.from({ length: 30 }, (_, i) => ({ content_with_weight: `片段${i}`, doc_id: 'd', docnm_kwd: 'n.pdf' })) },
    }))
    const { chunks } = await client(undefined, fetchImpl as never).searchChunks('q', { topK: 3 })
    expect(chunks).toHaveLength(3)
  })

  it('labels 标签分布透传（标签库软重排命中计数）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: 'x', doc_id: 'd', docnm_kwd: 'n' }], labels: { '2021-09': 2, '洪水资料': 1 } },
    }))
    const { labels } = await client(undefined, fetchImpl as never).searchChunks('q')
    expect(labels).toEqual({ '2021-09': 2, '洪水资料': 1 })
  })

  it('labels 缺失/非对象 → 空对象', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const { labels } = await client(undefined, fetchImpl as never).searchChunks('q')
    expect(labels).toEqual({})
  })

  it('请求体带 dataset_ids / question / top_k，Authorization 头带 Bearer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    await client(undefined, fetchImpl as never).searchChunks('问题', { topK: 5 })
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ragflow.example.com/api/v1/datasets/search')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ dataset_ids: ['ds1', 'ds2'], question: '问题', top_k: 5 })
  })

  it('meta_filter 归一：裸数组/conditions 两种形态 → meta_data_filter（method/logic/conditions）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    // 裸数组
    await client(undefined, fetchImpl as never).searchChunks('q', {
      metaFilter: [{ key: 'flood_event', op: '=', value: '2021-09' }],
    })
    let body = callBody(fetchImpl, 0)
    expect(body.meta_data_filter).toEqual({ method: 'manual', logic: 'and', conditions: [{ key: 'flood_event', op: '=', value: '2021-09' }] })
    // conditions 形态 + logic=or
    await client(undefined, fetchImpl as never).searchChunks('q', {
      metaFilter: { conditions: [{ key: 'doc_type', op: '=', value: '表格' }], logic: 'or' },
    })
    body = callBody(fetchImpl, 1)
    expect(body.meta_data_filter).toMatchObject({ method: 'manual', logic: 'or' })
  })

  it('meta_filter 非法条件（空 key / 非标量 value）整体忽略', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    await client(undefined, fetchImpl as never).searchChunks('q', {
      metaFilter: [{ key: '', op: '=', value: 'x' }, { key: 'k', op: '=', value: { nested: 1 } }],
    })
    const body = callBody(fetchImpl, 0)
    expect(body.meta_data_filter).toBeUndefined()
  })

  it('未配置 datasetIds 时 INVALID_PARAM（不触网）', async () => {
    const fetchImpl = vi.fn()
    const c = client({ datasetIds: [] }, fetchImpl as never)
    await expect(c.searchChunks('x')).rejects.toMatchObject({ code: 'INVALID_PARAM' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('HTTP 非 2xx → BACKEND_DOWN', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0 }, 502))
    await expect(client(undefined, fetchImpl as never).searchChunks('x')).rejects.toMatchObject({ code: 'BACKEND_DOWN' })
  })
})

describe('RagflowClient.subgraph（GET /artifacts/graph）', () => {
  it('node 模式：合并多数据集实体/关系，悬空边过滤', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/ds1/artifacts/graph')) {
        return jsonResponse({
          code: 0,
          data: {
            entities: [{ slug: 'entity/桃曲坡水库', name: '桃曲坡水库', description: '中型水库', source_chunk_ids: ['c1'] }],
            relations: [{ from: 'entity/桃曲坡水库', to: 'entity/未知X' }],
          },
        })
      }
      return jsonResponse({
        code: 0,
        data: {
          entities: [{ slug: 'entity/沮河', name: '沮河', description: '河流' }],
          relations: [{ from: 'entity/沮河', to: 'entity/桃曲坡水库' }],
        },
      })
    })
    const sub = await client(undefined, fetchImpl as never).subgraph({ node: '桃曲坡水库' })
    expect(sub.entities.map((e) => e.name).sort()).toEqual(['桃曲坡水库', '沮河'])
    expect(sub.center).toBe('entity/桃曲坡水库')
    // 未知X 无实体行 → 悬空边被过滤，沮河→桃曲坡水库 两端齐全被保留
    expect(sub.relations).toEqual([{ from: 'entity/沮河', to: 'entity/桃曲坡水库', predicate: '', weight: 0, description: '', datasetId: 'ds2' }])
  })

  it('node 参数自动补 entity/ 前缀；top_n 透传', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { entities: [], relations: [] } }))
    await client(undefined, fetchImpl as never).subgraph({ node: '桃曲坡水库', topN: 10 })
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('node=entity%2F')
    expect(url).toContain('top_n=10')
  })

  it('keywords 模式：请求带 keywords 不带 node', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { entities: [], relations: [] } }))
    await client(undefined, fetchImpl as never).subgraph({ keywords: '防洪调度' })
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('keywords=')
    expect(url).not.toContain('node=')
  })

  it('全部数据集失败才抛错；部分失败返回已合并结果', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/ds1/')) return jsonResponse({ code: 0, data: { entities: [{ slug: 'entity/A', name: 'A', description: '' }], relations: [] } })
      throw new Error('network down')
    })
    const sub = await client(undefined, fetchImpl as never).subgraph({ keywords: 'x' })
    expect(sub.entities).toHaveLength(1)
    const fetchImpl2 = vi.fn(async () => { throw new Error('network down') })
    await expect(client(undefined, fetchImpl2 as never).subgraph({ keywords: 'x' })).rejects.toMatchObject({ code: 'BACKEND_DOWN' })
  })
})

describe('RagflowClient.getPage / listPages', () => {
  it('slug 直取：page_type/slug 拆分 + content_md_rendered 投影', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/ds1/artifacts/entity/')) {
        return jsonResponse({
          code: 0,
          data: {
            slug: 'entity/桃曲坡水库', title: '桃曲坡水库', page_type: 'entity', topic: '水库',
            summary: '综合利用中型水库', content_md_rendered: '桃曲坡[水库](artifact/x)位于…',
            outlinks: ['entity/沮河'], related_kb_pages: ['沮河'],
            source_chunk_ids: ['c1', 'c2'], source_doc_ids: ['d1'],
          },
        })
      }
      return jsonResponse({ code: 0, data: null })
    })
    const page = await client(undefined, fetchImpl as never).getPage('entity/桃曲坡水库')
    expect(page).toMatchObject({
      title: '桃曲坡水库',
      contentMd: '桃曲坡[水库](artifact/x)位于…',
      outlinks: ['entity/沮河'],
      relatedPages: ['沮河'],
      datasetId: 'ds1',
    })
  })

  it('关键词定位：先 list 再取详情', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/artifacts?') || url.includes('keywords=')) {
        return jsonResponse({ code: 0, data: { total: 1, items: [{ slug: 'entity/桃曲坡水库', title: '桃曲坡水库', page_type: 'entity', summary: 's' }] } })
      }
      return jsonResponse({ code: 0, data: { slug: 'entity/桃曲坡水库', title: '桃曲坡水库', page_type: 'entity', summary: 's', content_md_rendered: '正文' } })
    })
    const page = await client(undefined, fetchImpl as never).getPage('桃曲坡水库')
    expect(page?.contentMd).toBe('正文')
  })

  it('页面不存在（data=null）返回 null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: null }))
    await expect(client(undefined, fetchImpl as never).getPage('entity/不存在')).resolves.toBeNull()
  })

  it('listPages 合并多数据集并按 limit 截断', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const ds = url.includes('/ds1/') ? 'ds1' : 'ds2'
      return jsonResponse({
        code: 0,
        data: {
          total: 2,
          items: [
            { slug: `entity/${ds}页A`, title: `${ds}页A`, page_type: 'entity', topic: 't', summary: 's' },
            { slug: `entity/${ds}页B`, title: `${ds}页B`, page_type: 'entity', topic: 't', summary: 's' },
          ],
        },
      })
    })
    const items = await client(undefined, fetchImpl as never).listPages({ keywords: '页', limit: 3 })
    expect(items).toHaveLength(3)
    expect(new Set(items.map((i) => i.datasetId))).toEqual(new Set(['ds1', 'ds2']))
  })
})

describe('RagflowClient.structure / mindmap', () => {
  it('kind 透传 + entities/relations 归一', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        kind: 'graph',
        templates: [{
          template_id: 't1', template_name: 'tmpl', kind: 'graph',
          entities: [
            { name: '王鹏', type: 'person', aliases: [], description: '总经理', mention_count: 2, source_chunk_ids: [] },
            { name: '飞龙公司', type: 'organization', aliases: [], description: '公司', mention_count: 1, source_chunk_ids: [] },
          ],
          relations: [{ from: '王鹏', to: '飞龙公司', predicate: '任职于' }],
        }],
      },
    }))
    const sub = await client(undefined, fetchImpl as never).structure('graph')
    expect(sub.entities[0]).toMatchObject({ name: '王鹏', type: 'person', weight: 2 })
    expect(sub.relations[0]).toMatchObject({ from: '王鹏', to: '飞龙公司', predicate: '任职于' })
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('kind=graph')
  })

  it('mindmap 关系谓词回退 type（has_branch/has_sub_branch）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        kind: 'mindmap',
        templates: [{
          entities: [
            { name: '应急预案', type: 'central_topic', description: '中心主题', mention_count: 1, aliases: [], source_chunk_ids: [] },
            { name: '应急响应', type: 'branch', description: '分支', mention_count: 1, aliases: [], source_chunk_ids: [] },
            { name: 'I级响应', type: 'sub_branch', description: '子分支', mention_count: 1, aliases: [], source_chunk_ids: [] },
          ],
          relations: [
            { from: '应急预案', to: '应急响应', type: 'has_branch' },
            { from: '应急响应', to: 'I级响应', type: 'has_sub_branch' },
          ],
        }],
      },
    }))
    const sub = await client(undefined, fetchImpl as never).structure('mindmap')
    expect(sub.relations[0]).toMatchObject({ from: '应急预案', to: '应急响应', predicate: 'has_branch' })

    const forest = await client(undefined, fetchImpl as never).mindmap()
    expect(forest).toHaveLength(1)
    expect(forest[0]).toMatchObject({ name: '应急预案', type: 'central_topic' })
    expect(forest[0]!.children[0]).toMatchObject({ name: '应急响应' })
    expect(forest[0]!.children[0]!.children[0]).toMatchObject({ name: 'I级响应' })
  })

  it('mindmap 环/悬空边安全：自环与未知目标跳过，无 central_topic 时无父节点为根', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        kind: 'mindmap',
        templates: [{
          entities: [
            { name: 'A', type: 'branch', description: '', mention_count: 1, aliases: [], source_chunk_ids: [] },
            { name: 'B', type: 'sub_branch', description: '', mention_count: 1, aliases: [], source_chunk_ids: [] },
          ],
          relations: [
            { from: 'A', to: 'B', type: 'has_branch' },
            { from: 'B', to: 'A', type: 'has_branch' },
            { from: 'A', to: 'A', type: 'has_branch' },
            { from: 'B', to: '未知X', type: 'has_branch' },
          ],
        }],
      },
    }))
    const forest = await client(undefined, fetchImpl as never).mindmap()
    expect(forest).toHaveLength(1)
    expect(forest[0]!.name).toBe('A')
    expect(forest[0]!.children.map((c) => c.name)).toEqual(['B'])
    expect(forest[0]!.children[0]!.children).toEqual([])
  })

  it('mindmap keywords 透传服务端', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { kind: 'mindmap', templates: [] } }))
    const forest = await client(undefined, fetchImpl as never).mindmap({ keywords: '应急响应' })
    expect(forest).toEqual([])
    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string]
    expect(url).toContain('kind=mindmap')
    expect(url).toContain('keywords=')
  })

  it('mindmap 节点预算封顶（maxGraphEntities）', async () => {
    const entities = Array.from({ length: 10 }, (_, i) => ({ name: `N${i}`, type: 'sub_branch', description: '', mention_count: 1, aliases: [], source_chunk_ids: [] }))
    const relations = entities.slice(0, -1).map((e, i) => ({ from: e.name, to: `N${i + 1}`, type: 'has_branch' }))
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { kind: 'mindmap', templates: [{ entities, relations }] } }))
    const forest = await client({ maxGraphEntities: 4 }, fetchImpl as never).mindmap()
    const count = (nodes: Array<{ children: unknown[] }>): number =>
      nodes.reduce((sum, n) => sum + 1 + count(n.children as Array<{ children: unknown[] }>), 0)
    expect(count(forest)).toBe(4)
  })
})

describe('slug 工具函数', () => {
  it('entitySlug：裸名补前缀，slug 原样', () => {
    expect(entitySlug('桃曲坡水库')).toBe('entity/桃曲坡水库')
    expect(entitySlug('concept/水位')).toBe('concept/水位')
  })
  it('slugName：去前缀', () => {
    expect(slugName('entity/桃曲坡水库')).toBe('桃曲坡水库')
    expect(slugName('裸名')).toBe('裸名')
  })
})

describe('取消与超时', () => {
  it('调用方 signal 已取消 → 合并信号中断在途请求，收敛为 BACKEND_DOWN', async () => {
    const controller = new AbortController()
    controller.abort()
    // 真实 fetch 对已取消 signal 直接拒绝；mock 复刻该行为
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new Error('The operation was aborted')
      return jsonResponse({ code: 0, data: { chunks: [] } })
    })
    await expect(
      client(undefined, fetchImpl as never).searchChunks('x', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'BACKEND_DOWN' })
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('超时预算来自 knowledge.timeoutMs（AbortSignal.timeout）', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return jsonResponse({ code: 0, data: { chunks: [] } })
    })
    await client({ timeoutMs: 5000 }, fetchImpl as never).searchChunks('x')
    expect(fetchImpl).toHaveBeenCalled()
  })
})
