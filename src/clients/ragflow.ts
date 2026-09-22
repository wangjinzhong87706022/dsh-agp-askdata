/**
 * RAGFlow 知识面客户端（graph / wiki / 原文检索；与 ragflow-import 工具链同源契约）。
 *
 * 覆盖四类只读端点（线上 v0.27.x 实证）：
 *   - `POST /datasets/search`                 原文片段检索（业务失败 HTTP 200 + code≠0）
 *   - `GET  /datasets/{id}/artifacts`         wiki 页面清单（keywords 模糊检索）
 *   - `GET  /datasets/{id}/artifacts/{pt}/{slug}`  wiki 页面全文（content_md_rendered + outlinks）
 *   - `GET  /datasets/{id}/artifacts/graph`   实体关系子图（node 中心扩展 / keywords 概览）
 *   - `GET  /datasets/{id}/artifacts/structure?kind=`  数据集级结构图谱（graph/mindmap/timeline）
 *
 * 契约要点（勿改坏）：
 *   - 全部 GET/POST 检索类调用，无任何写操作（AGENTS.md 只读红线在知识面同样成立）。
 *   - 业务失败一律 HTTP 200 + `{"code": 非0}`，必须检查响应体 code（同 ragflow.ts 契约）。
 *   - API Key 只进 Authorization 头，不进日志、不进错误消息。
 *   - 取消与超时都能中断在途请求：调用方 signal 与本地超时经 AbortSignal.any 合并。
 * @module
 */

import { askdataError } from '../errors.ts'
import type { KnowledgeConfig } from '../config.ts'

/** 检索命中的原文片段。 */
export interface KnowledgeChunk {
  content: string
  documentId: string
  documentName: string
  similarity: number | null
  chunkId?: string
  /** RAGFlow positions：[page, x0, x1, top, bottom]，1-based 页码；未定位为 null。 */
  positions?: number[][] | null
  pageNum?: number | null
  imageId?: string
}

/** wiki 页面清单项。 */
export interface KnowledgePageItem {
  slug: string
  title: string
  pageType: string
  topic: string
  summary: string
  datasetId: string
}

/** wiki 页面全文。 */
export interface KnowledgePage {
  slug: string
  title: string
  pageType: string
  topic: string
  summary: string
  /** 渲染后的 Markdown（站内链接为 artifact/<kb>/<page_type>/<slug> 形态）。 */
  contentMd: string
  /** 出链 slug 列表（<page_type>/<name>）。 */
  outlinks: string[]
  /** 关联页面标题（人类可读）。 */
  relatedPages: string[]
  sourceChunkIds: string[]
  sourceDocIds: string[]
  datasetId: string
}

/** 图谱实体（wiki graph 与 structure 两种端点归一化后的形态）。 */
export interface KnowledgeEntity {
  /** 稳定标识：wiki graph 为 `<page_type>/<name>`，structure 为 name。 */
  slug: string
  name: string
  /** structure 端点特有：person / organization / geo / event / category 等。 */
  type: string
  aliases: string[]
  description: string
  /** wiki graph 的权重（mention 计数）；无则为 0。 */
  weight: number
  sourceChunkIds: string[]
  datasetId: string
}

/** 图谱关系边。 */
export interface KnowledgeRelation {
  from: string
  to: string
  /** structure 端点带谓词；wiki graph 端点为空串。 */
  predicate: string
  weight: number
  description: string
  datasetId: string
}

/** 实体关系子图（多数据集合并去重后）。 */
export interface KnowledgeSubgraph {
  entities: KnowledgeEntity[]
  relations: KnowledgeRelation[]
  /** 中心实体 slug（node 模式时回显）。 */
  center?: string
}

export interface SearchChunksOptions {
  topK?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface SubgraphOptions {
  /** 中心实体（wiki slug 或实体名）；提供时走 node 中心扩展。 */
  node?: string
  /** 概览种子关键词（node 未提供时生效）。 */
  keywords?: string
  topN?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface ListPagesOptions {
  keywords?: string
  pageType?: string
  limit?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** RAGFlow 业务失败（HTTP 200 但 code≠0）——保留原始 code 便于排障。 */
export class RagflowApiError extends Error {
  readonly code: unknown
  constructor(code: unknown, message: string) {
    super(`RAGFlow 返回 code=${String(code)}: ${message}`)
    this.name = 'RagflowApiError'
    this.code = code
  }
}

/** 服务端实体预算硬上限（artifacts/graph 的 top_n 钳位，与服务端一致）。 */
const MAX_GRAPH_TOP_N = 1024

function normalizeCode(code: unknown): unknown {
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return code
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function positionsOf(raw: Record<string, unknown>): number[][] | null {
  if (!Array.isArray(raw.positions)) return null
  const rows = raw.positions
    .filter((p): p is unknown[] => Array.isArray(p))
    .map((p) => p.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : Number(n))))
    .filter((p) => p.every((n) => Number.isFinite(n)))
  return rows.length > 0 ? rows : null
}

/** 实体名 → wiki slug（`<page_type>/<name>`）；已是 slug 形态原样返回。 */
export function entitySlug(name: string): string {
  const trimmed = name.trim()
  return /^(entity|concept|topic)\//.test(trimmed) ? trimmed : `entity/${trimmed}`
}

/** wiki slug → 人类可读名（去掉 `<page_type>/` 前缀）。 */
export function slugName(slug: string): string {
  const idx = slug.indexOf('/')
  return idx >= 0 ? slug.slice(idx + 1) : slug
}

/**
 * RAGFlow 知识面客户端。
 *
 * 每个方法独立可测（`fetchImpl` 注入）；多数据集方法（search/subgraph/listPages）
 * 逐个数据集调用后按 slug/title 合并去重，某个数据集失败不拖垮整体
 * （该数据集贡献为空），全部失败才抛错。
 */
export class RagflowClient {
  constructor(
    private readonly config: KnowledgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 拼 API URL：基址 + /api/v1 + 路径。 */
  private url(path: string): string {
    return `${this.config.ragflowBaseUrl.replace(/\/+$/, '')}/api/v1${path}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.ragflowApiKey) headers.Authorization = `Bearer ${this.config.ragflowApiKey}`
    return headers
  }

  /** 合并调用方取消信号与本地超时；两者任一触发都中断在途请求。 */
  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  private requireDatasets(): string[] {
    if (this.config.datasetIds.length === 0) {
      throw askdataError(
        'INVALID_PARAM',
        '知识面未配置检索目标：请在插件配置 knowledge.datasetIds 填入 RAGFlow 数据集 id',
      )
    }
    return this.config.datasetIds
  }

  /** GET + JSON 解析 + code 检查；网络/HTTP/业务失败统一收敛为 AskdataError。 */
  private async getJson(path: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<unknown> {
    const impl = fetchImpl ?? this.fetchImpl
    let body: unknown
    try {
      const res = await impl(this.url(path), { method: 'GET', headers: this.headers(), signal: this.signal(signal) })
      if (!res.ok) {
        throw askdataError('BACKEND_DOWN', `RAGFlow 返回 HTTP ${res.status}（${path.split('?')[0]}）`)
      }
      body = await res.json()
    } catch (err) {
      if (err instanceof Error && err.name === 'AskdataError') throw err
      throw askdataError('BACKEND_DOWN', `无法访问 RAGFlow（${path.split('?')[0]}）：${String(err instanceof Error ? err.message : err).slice(0, 160)}`)
    }
    return this.checkEnvelope(body, path)
  }

  /** POST + JSON 解析 + code 检查（/datasets/search 用）。 */
  private async postJson(path: string, payload: unknown, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<unknown> {
    const impl = fetchImpl ?? this.fetchImpl
    let body: unknown
    try {
      const res = await impl(this.url(path), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: this.signal(signal),
      })
      if (!res.ok) {
        throw askdataError('BACKEND_DOWN', `RAGFlow 返回 HTTP ${res.status}（${path.split('?')[0]}）`)
      }
      body = await res.json()
    } catch (err) {
      if (err instanceof Error && err.name === 'AskdataError') throw err
      throw askdataError('BACKEND_DOWN', `无法访问 RAGFlow（${path.split('?')[0]}）：${String(err instanceof Error ? err.message : err).slice(0, 160)}`)
    }
    return this.checkEnvelope(body, path)
  }

  /** 业务失败（HTTP 200 + code≠0）→ RagflowApiError；成功返回 data 字段。 */
  private checkEnvelope(body: unknown, path: string): unknown {
    const envelope = body as { code?: unknown; message?: unknown; data?: unknown } | null
    const code = normalizeCode(envelope?.code)
    if (code !== 0 && code !== undefined && code !== null) {
      throw new RagflowApiError(envelope?.code, str(envelope?.message).slice(0, 200))
    }
    if (envelope === null || typeof envelope !== 'object') {
      throw askdataError('BACKEND_DOWN', `RAGFlow 响应不是 JSON 对象（${path.split('?')[0]}）`)
    }
    return envelope.data
  }

  /**
   * 原文片段检索（多数据集一次调用）。
   *
   * 与 dsh-plugins/lingzhi-knowledge-tool 的 searchDatasets 契约一致：
   * dataset_ids 数组 + question + top_k + rerank_candidates_count。
   */
  async searchChunks(question: string, options: SearchChunksOptions = {}): Promise<KnowledgeChunk[]> {
    const datasetIds = this.requireDatasets()
    const topK = Math.min(50, Math.max(1, Math.trunc(options.topK ?? this.config.maxChunks)))
    const data = await this.postJson(
      '/datasets/search',
      {
        dataset_ids: datasetIds,
        question,
        top_k: topK,
        rerank_candidates_count: Math.max(topK * 4, 40),
      },
      options.signal,
      options.fetchImpl,
    )
    const rawChunks = (data as { chunks?: unknown } | null)?.chunks
    if (!Array.isArray(rawChunks)) return []
    const chunks: KnowledgeChunk[] = []
    for (const item of rawChunks) {
      if (item === null || typeof item !== 'object') continue
      const c = item as Record<string, unknown>
      const content = str(c.content_with_weight) || str(c.content)
      if (content.trim().length === 0) continue
      const positions = positionsOf(c)
      chunks.push({
        content,
        documentId: str(c.document_id),
        documentName: str(c.document_keyword) || str(c.document_name),
        similarity: toNumber(c.similarity),
        ...(str(c.chunk_id) || str(c.id) ? { chunkId: str(c.chunk_id) || str(c.id) } : {}),
        ...(positions ? { positions } : {}),
        ...(toNumber(c.page_num) !== null ? { pageNum: toNumber(c.page_num) } : {}),
        ...(str(c.image_id) ? { imageId: str(c.image_id) } : {}),
      })
    }
    return chunks
  }

  /** wiki 页面清单（keywords 命中 title/summary；多数据集合并）。 */
  async listPages(options: ListPagesOptions = {}): Promise<KnowledgePageItem[]> {
    const datasetIds = this.requireDatasets()
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
    const seen = new Set<string>()
    const items: KnowledgePageItem[] = []
    const failures: unknown[] = []
    for (const datasetId of datasetIds) {
      const params = new URLSearchParams({ page: '1', page_size: String(limit) })
      if (options.keywords) params.set('keywords', options.keywords)
      if (options.pageType) params.set('page_type', options.pageType)
      let data: unknown
      try {
        data = await this.getJson(`/datasets/${datasetId}/artifacts?${params.toString()}`, options.signal, options.fetchImpl)
      } catch (err) {
        failures.push(err)
        continue
      }
      const rawItems = (data as { items?: unknown } | null)?.items
      if (!Array.isArray(rawItems)) continue
      for (const item of rawItems) {
        if (item === null || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        const slug = str(row.slug)
        const key = `${datasetId}/${slug}`
        if (!slug || seen.has(key)) continue
        seen.add(key)
        items.push({
          slug,
          title: str(row.title) || slugName(slug),
          pageType: str(row.page_type) || slug.split('/')[0] || 'entity',
          topic: str(row.topic),
          summary: str(row.summary),
          datasetId,
        })
        if (items.length >= limit) return items
      }
    }
    if (items.length === 0 && failures.length === datasetIds.length) throw failures[0]
    return items
  }

  /** wiki 页面全文（按 slug 或关键词定位；slug 需带 `<page_type>/` 前缀）。 */
  async getPage(slugOrKeywords: string, options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<KnowledgePage | null> {
    const datasetIds = this.requireDatasets()
    const trimmed = slugOrKeywords.trim()
    if (!trimmed) throw askdataError('INVALID_PARAM', 'slug 或关键词不能为空')

    if (/^(entity|concept|topic)\//.test(trimmed)) {
      // slug 直取：拆 page_type/slug 逐数据集找第一个命中
      const [pageType, ...rest] = trimmed.split('/')
      const slug = rest.join('/')
      for (const datasetId of datasetIds) {
        try {
          const data = await this.getJson(
            `/datasets/${datasetId}/artifacts/${encodeURIComponent(pageType!)}/${encodeURIComponent(slug)}`,
            options.signal,
            options.fetchImpl,
          )
          const page = this.toPage(data, datasetId)
          if (page) return page
        } catch (err) {
          if (err instanceof RagflowApiError) continue
          throw err
        }
      }
      return null
    }

    // 关键词定位：清单取第一个标题/关键词最贴合的条目
    const candidates = await this.listPages({ keywords: trimmed, limit: 5, signal: options.signal, fetchImpl: options.fetchImpl })
    const exact = candidates.find((c) => c.title === trimmed) ?? candidates[0]
    if (!exact) return null
    return this.getPage(exact.slug, { signal: options.signal, fetchImpl: options.fetchImpl })
  }

  private toPage(data: unknown, datasetId: string): KnowledgePage | null {
    if (data === null || typeof data !== 'object') return null
    const row = data as Record<string, unknown>
    const slug = str(row.slug)
    if (!slug) return null
    return {
      slug,
      title: str(row.title) || slugName(slug),
      pageType: str(row.page_type) || slug.split('/')[0] || 'entity',
      topic: str(row.topic),
      summary: str(row.summary),
      contentMd: str(row.content_md_rendered) || str(row.content_md),
      outlinks: strArray(row.outlinks),
      relatedPages: strArray(row.related_kb_pages),
      sourceChunkIds: strArray(row.source_chunk_ids),
      sourceDocIds: strArray(row.source_doc_ids),
      datasetId,
    }
  }

  /**
   * 实体关系子图（多数据集合并）。
   *
   * - `node` 提供：服务端 node 中心扩展（该实体全部出边 + to 目标）；
   * - 仅 `keywords`：概览种子（BM25 匹配实体）；
   * - 都未提供：权重最高的实体概览。
   */
  async subgraph(options: SubgraphOptions = {}): Promise<KnowledgeSubgraph> {
    const datasetIds = this.requireDatasets()
    const topN = Math.min(MAX_GRAPH_TOP_N, Math.max(1, Math.trunc(options.topN ?? this.config.maxGraphEntities)))
    const entityBySlug = new Map<string, KnowledgeEntity>()
    const relationKeys = new Set<string>()
    const relations: KnowledgeRelation[] = []
    const failures: unknown[] = []

    for (const datasetId of datasetIds) {
      const params = new URLSearchParams({ top_n: String(topN) })
      if (options.node) params.set('node', entitySlug(options.node))
      if (options.keywords) params.set('keywords', options.keywords)
      let data: unknown
      try {
        data = await this.getJson(`/datasets/${datasetId}/artifacts/graph?${params.toString()}`, options.signal, options.fetchImpl)
      } catch (err) {
        failures.push(err)
        continue
      }
      const rawEntities = (data as { entities?: unknown } | null)?.entities
      const rawRelations = (data as { relations?: unknown } | null)?.relations
      if (Array.isArray(rawEntities)) {
        for (const item of rawEntities) {
          if (item === null || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const slug = str(row.slug) || entitySlug(str(row.name))
          if (!slug || entityBySlug.has(slug)) continue
          entityBySlug.set(slug, {
            slug,
            name: str(row.name) || slugName(slug),
            type: str(row.entity_type) || str(row.type),
            aliases: strArray(row.aliases),
            description: str(row.description),
            weight: toNumber(row.weight) ?? toNumber(row.mention_count) ?? 0,
            sourceChunkIds: strArray(row.source_chunk_ids),
            datasetId,
          })
        }
      }
      if (Array.isArray(rawRelations)) {
        for (const item of rawRelations) {
          if (item === null || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const from = str(row.from) || str(row.source)
          const to = str(row.to) || str(row.target)
          if (!from || !to || from === to) continue
          const key = `${from}\u0000${to}`
          if (relationKeys.has(key)) continue
          relationKeys.add(key)
          relations.push({
            from,
            to,
            predicate: str(row.predicate) || str(row.keywords),
            weight: toNumber(row.weight) ?? 0,
            description: str(row.description),
            datasetId,
          })
        }
      }
    }

    if (entityBySlug.size === 0 && failures.length === datasetIds.length) throw failures[0]

    // 关系两端实体必须可见（服务端 node 模式保证；概览模式过滤悬空边）
    const entities = [...entityBySlug.values()]
    const known = new Set(entities.map((e) => e.slug))
    const kept = relations.filter((r) => known.has(r.from) && known.has(r.to))
    return {
      entities,
      relations: kept,
      ...(options.node ? { center: entitySlug(options.node) } : {}),
    }
  }

  /** 数据集级结构图谱（kind: graph/mindmap/timeline/session_essence/session_graph）。 */
  async structure(kind: string, options: { keywords?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<KnowledgeSubgraph> {
    const datasetIds = this.requireDatasets()
    const entityBySlug = new Map<string, KnowledgeEntity>()
    const relationKeys = new Set<string>()
    const relations: KnowledgeRelation[] = []
    const failures: unknown[] = []

    for (const datasetId of datasetIds) {
      const params = new URLSearchParams({ kind })
      if (options.keywords) params.set('keywords', options.keywords)
      let data: unknown
      try {
        data = await this.getJson(`/datasets/${datasetId}/artifacts/structure?${params.toString()}`, options.signal, options.fetchImpl)
      } catch (err) {
        failures.push(err)
        continue
      }
      const templates = (data as { templates?: unknown } | null)?.templates
      if (!Array.isArray(templates)) continue
      for (const tpl of templates) {
        if (tpl === null || typeof tpl !== 'object') continue
        const t = tpl as Record<string, unknown>
        const rawEntities = Array.isArray(t.entities) ? t.entities : []
        for (const item of rawEntities) {
          if (item === null || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const name = str(row.name)
          if (!name || entityBySlug.has(name)) continue
          entityBySlug.set(name, {
            slug: name,
            name,
            type: str(row.type) || str(row.entity_type),
            aliases: strArray(row.aliases),
            description: str(row.description),
            weight: toNumber(row.mention_count) ?? 0,
            sourceChunkIds: strArray(row.source_chunk_ids),
            datasetId,
          })
        }
        const rawRelations = Array.isArray(t.relations) ? t.relations : []
        for (const item of rawRelations) {
          if (item === null || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const from = str(row.from) || str(row.source)
          const to = str(row.to) || str(row.target)
          if (!from || !to || from === to) continue
          const key = `${from}\u0000${to}`
          if (relationKeys.has(key)) continue
          relationKeys.add(key)
          relations.push({
            from,
            to,
            predicate: str(row.predicate) || str(row.keywords),
            weight: toNumber(row.weight) ?? 0,
            description: str(row.description),
            datasetId,
          })
        }
      }
    }

    if (entityBySlug.size === 0 && failures.length === datasetIds.length) throw failures[0]
    const entities = [...entityBySlug.values()]
    const known = new Set(entities.map((e) => e.slug))
    return { entities, relations: relations.filter((r) => known.has(r.from) && known.has(r.to)) }
  }
}
