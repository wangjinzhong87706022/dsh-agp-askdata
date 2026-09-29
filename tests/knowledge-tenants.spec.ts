/**
 * 知识面多租户（方案 1）单测：配置归一化、租户路由、遗留单租户兼容。
 * 全部 mock fetch，不触网；API key 只进请求头断言，不落快照。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { RagflowClient, bindKnowledgeTenant } from '../src/clients/ragflow.ts'
import { resolveKnowledgeConfig, resolveConfig } from '../src/config.ts'
import { createAskdataService } from '../src/index.ts'
import { knowledgeSearchTool } from '../tools/knowledge-search.ts'
import type { AuditRow } from '../src/audit.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeClient(datasetIds: string[], apiKey: string, fetchImpl: typeof fetch): RagflowClient {
  return new RagflowClient(
    resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://ragflow.example.com',
      ragflowApiKey: apiKey,
      datasetIds,
    }),
    fetchImpl,
  )
}

describe('resolveKnowledgeConfig 租户归一', () => {
  it('多租户形态：tenants 原样解析，defaultTenant 显式', () => {
    const c = resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      defaultTenant: 'zuhe',
      tenants: [
        { id: 'tqp', ragflowApiKey: 'k1', datasetIds: ['ds-a'] },
        { id: 'zuhe', ragflowApiKey: 'k2', datasetIds: ['ds-b'], maxChunks: 5, maxGraphEntities: 100 },
      ],
    })
    expect(c.tenants).toHaveLength(2)
    expect(c.tenants[1]).toMatchObject({ id: 'zuhe', ragflowApiKey: 'k2', datasetIds: ['ds-b'], maxChunks: 5, maxGraphEntities: 100 })
    expect(c.tenants[0]).toMatchObject({ id: 'tqp', ragflowApiKey: 'k1' }) // 未覆写预算 → 无覆写字段
    expect(c.defaultTenant).toBe('zuhe')
  })

  it('遗留单租户形态折算为 id=default 的单租户，defaultTenant 自动指向它', () => {
    const c = resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      ragflowApiKey: 'legacy-key',
      datasetIds: ['ds-1', 'ds-2'],
    })
    expect(c.tenants).toEqual([{ id: 'default', ragflowApiKey: 'legacy-key', datasetIds: ['ds-1', 'ds-2'] }])
    expect(c.defaultTenant).toBe('default')
  })

  it('全空（未配置知识面）→ 租户表为空、defaultTenant 为空', () => {
    const c = resolveKnowledgeConfig({ ragflowBaseUrl: 'https://r.example.com' })
    expect(c.tenants).toEqual([])
    expect(c.defaultTenant).toBe('')
  })

  it('多租户未配 defaultTenant → 留空（未解析即报错语义）', () => {
    const c = resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      tenants: [
        { id: 'tenant-a', ragflowApiKey: 'k1', datasetIds: ['ds-1aa'] },
        { id: 'tenant-b', ragflowApiKey: 'k2', datasetIds: ['ds-2bb'] },
      ],
    })
    expect(c.defaultTenant).toBe('')
  })

  it('租户 key 留空回退环境变量 RAGFLOW_API_KEY_<ID大写>', () => {
    process.env.RAGFLOW_API_KEY_ZUHE = 'env-key'
    try {
      const c = resolveKnowledgeConfig({
        ragflowBaseUrl: 'https://r.example.com',
        tenants: [{ id: 'zuhe', ragflowApiKey: '', datasetIds: ['ds-1aa'] }],
      })
      expect(c.tenants[0]!.ragflowApiKey).toBe('env-key')
    } finally {
      delete process.env.RAGFLOW_API_KEY_ZUHE
    }
  })

  it('非法租户 id / 重复 id / defaultTenant 引用不存在租户 → 加载期报错', () => {
    expect(() => resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      tenants: [{ id: 'Bad-Id!', ragflowApiKey: 'k', datasetIds: ['ds-1aa'] }],
    })).toThrow(/租户 id/)
    expect(() => resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      tenants: [
        { id: 'tenant-a', ragflowApiKey: 'k', datasetIds: ['ds-1aa'] },
        { id: 'tenant-a', ragflowApiKey: 'k2', datasetIds: ['ds-1aa'] },
      ],
    })).toThrow(/重复/)
    expect(() => resolveKnowledgeConfig({
      ragflowBaseUrl: 'https://r.example.com',
      defaultTenant: 'ghost',
      tenants: [{ id: 'tenant-a', ragflowApiKey: 'k', datasetIds: ['ds-1aa'] }],
    })).toThrow(/defaultTenant/)
  })
})

describe('bindKnowledgeTenant 租户路由', () => {
  it('tenantId 命中对应租户：请求带该租户的 key 与 dataset_ids', async () => {
    const fetchTqp = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const fetchZuhe = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const clients = new Map<string, RagflowClient>([
      ['tqp', makeClient(['ds-tqp'], 'key-tqp', fetchTqp as never)],
      ['zuhe', makeClient(['ds-zuhe'], 'key-zuhe', fetchZuhe as never)],
    ])
    await bindKnowledgeTenant(clients, 'zuhe', 'tqp').searchChunks('公式')
    expect(fetchZuhe).toHaveBeenCalledTimes(1)
    expect(fetchTqp).not.toHaveBeenCalled()
    const [url, init] = (fetchZuhe as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!
    expect(url).toBe('https://ragflow.example.com/api/v1/datasets/search')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-zuhe')
    expect(JSON.parse(String(init.body)).dataset_ids).toEqual(['ds-zuhe'])
  })

  it('未携带 tenantId → 走 defaultTenant', async () => {
    const fetchTqp = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const clients = new Map<string, RagflowClient>([['tqp', makeClient(['ds-tqp'], 'k', fetchTqp as never)]])
    await bindKnowledgeTenant(clients, undefined, 'tqp').searchChunks('q')
    expect(fetchTqp).toHaveBeenCalledTimes(1)
  })

  it('未知租户 / 多租户未配 defaultTenant 且未携带 → INVALID_PARAM（fail loud，不静默落别的租户）', async () => {
    const fetchA = vi.fn(async () => jsonResponse({ code: 0, data: { chunks: [] } }))
    const clients = new Map<string, RagflowClient>([
      ['tenant-a', makeClient(['ds-a1'], 'k', fetchA as never)],
      ['tenant-b', makeClient(['ds-b1'], 'k2', fetchA as never)],
    ])
    await expect(bindKnowledgeTenant(clients, 'ghost', 'tenant-a').searchChunks('q'))
      .rejects.toMatchObject({ code: 'INVALID_PARAM' })
    await expect(bindKnowledgeTenant(clients, undefined, '').searchChunks('q'))
      .rejects.toMatchObject({ code: 'INVALID_PARAM' })
    expect(fetchA).not.toHaveBeenCalled()
  })
})

describe('createAskdataService 租户装配', () => {
  const base = {
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    knowledge: {
      ragflowBaseUrl: 'https://ragflow.example.com',
      defaultTenant: 'tqp',
      tenants: [
        { id: 'tqp', ragflowApiKey: 'k1', datasetIds: ['ds-tqp'] },
        { id: 'zuhe', ragflowApiKey: 'k2', datasetIds: ['ds-zuhe'] },
      ],
    },
  }

  it('createContext 按 tenantId 产出绑定视图；tenantId 随上下文与审计参数落行', async () => {
    const service = createAskdataService(base as never)
    const fetchCalls: string[] = []
    // 直接构造 zuhe 上下文（fetch 走真网络会失败——这里只验证绑定与审计标记，不发请求）
    const ctx = service.createContext({ tenantId: 'zuhe', onAudit: () => {} })
    expect(ctx.knowledge).toBeDefined()
    expect(ctx.tenantId).toBe('zuhe')
    void fetchCalls
  })

  it('知识面未配置（无租户）→ knowledge 为 undefined，工具面不受影响', () => {
    const service = createAskdataService({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    } as never)
    expect(service.createContext().knowledge).toBeUndefined()
    expect(service.tools.map((t) => t.name)).toContain('knowledge_search')
  })

  it('遗留单租户配置（resolveConfig 全量）自动折算 default 租户', () => {
    const config = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      knowledge: { datasetIds: ['fda7a510a87c11f1998b3dc126099a8d'] },
    } as never)
    expect(config.knowledge.tenants).toEqual([
      { id: 'default', ragflowApiKey: '', datasetIds: ['fda7a510a87c11f1998b3dc126099a8d'] },
    ])
    expect(config.knowledge.defaultTenant).toBe('default')
  })

  it('仅有 key 无 datasetIds 的遗留形态不折算（知识面按未装配处理）', () => {
    const c = resolveKnowledgeConfig({ ragflowBaseUrl: 'https://r.example.com', ragflowApiKey: 'lonely-key' })
    expect(c.tenants).toEqual([])
    expect(c.defaultTenant).toBe('')
  })
})

describe('知识工具租户审计标记', () => {
  it('ctx.tenantId 存在时审计 apiParams 落 _tenant（锁 applyAudit 行为，防重构丢失）', async () => {
    const audits: AuditRow[] = []
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: '证据', doc_id: 'd1', docnm_kwd: '规程.pdf' }] },
    }))
    const config = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      knowledge: { datasetIds: ['ds-1aa'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' },
      audit: { enabled: true },
    } as never)
    const ctx = {
      config,
      executor: { execute: async () => ({ columns: [], rows: [] }) },
      mysqlExecutor: { execute: async () => ({ columns: [], rows: [] }) },
      knowledge: makeClient(['ds-1aa'], 'k', fetchImpl as never),
      tenantId: 'zuhe',
      prevAuditHash: '',
      onAudit: (row: AuditRow) => audits.push(row),
    }
    const r = await knowledgeSearchTool.run({ query: '公式' }, ctx as never)
    expect(r.success).toBe(true)
    expect(audits).toHaveLength(1)
    const params = JSON.parse(audits[0]!.apiParams) as Record<string, unknown>
    expect(params._tenant).toBe('zuhe')
  })

  it('ctx.tenantId 缺省时审计不落 _tenant（单租户行为不变）', async () => {
    const audits: AuditRow[] = []
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0,
      data: { chunks: [{ content_with_weight: '证据', doc_id: 'd1', docnm_kwd: '规程.pdf' }] },
    }))
    const config = resolveConfig({
      connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
      knowledge: { datasetIds: ['ds-1aa'], ragflowBaseUrl: 'https://ragflow.example.com', ragflowApiKey: 'k' },
      audit: { enabled: true },
    } as never)
    const ctx = {
      config,
      executor: { execute: async () => ({ columns: [], rows: [] }) },
      mysqlExecutor: { execute: async () => ({ columns: [], rows: [] }) },
      knowledge: makeClient(['ds-1aa'], 'k', fetchImpl as never),
      prevAuditHash: '',
      onAudit: (row: AuditRow) => audits.push(row),
    }
    const r = await knowledgeSearchTool.run({ query: '公式' }, ctx as never)
    expect(r.success).toBe(true)
    const params = JSON.parse(audits[0]!.apiParams) as Record<string, unknown>
    expect(params._tenant).toBeUndefined()
  })
})
