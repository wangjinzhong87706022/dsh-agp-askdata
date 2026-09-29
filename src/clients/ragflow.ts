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
 *   - 取消与超时都能中断在途请求：调用方 signal 与本地超时经 AbortSignal.any 合并；
 *     超时（TimeoutError）与取消（AbortError）在错误消息中分流，不都报成英文 abort 原文。
 *   - 多数据集方法语义：某个数据集失败不拖垮整体（该数据集贡献为空），全部失败才抛错；
 *     部分失败经 `onPartialFailure(failed, total)` 回调暴露，由调用方决定是否进入审计面。
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

/** search 响应顶层标签分布（标签库软重排命中计数，如 {"2021-09":1,"洪水资料":1}）。 */
export type KnowledgeLabels = Record<string, number>

/** searchChunks 返回：片段清单 + 标签分布（标签库软重排结果，用于引用分类标注）。 */
export interface KnowledgeSearchOutcome {
  chunks: KnowledgeChunk[]
  labels: KnowledgeLabels
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

/** 脑图节点（父子层级；森林形态——每个 central_topic 一棵树）。 */
export interface MindmapNode {
  name: string
  /** central_topic / branch / sub_branch（服务端编译产物类型）。 */
  type: string
  description: string
  children: MindmapNode[]
}

/** mindmap() 结果：森林 + 预算可见性（截断不能静默——缺层级会让模型答错分支数）。 */
export interface MindmapOutcome {
  forest: MindmapNode[]
  /** 预算截断前的实体（节点）总数。 */
  totalNodes: number
  /** 实际展开进入森林的节点数。 */
  expandedNodes: number
  /** 是否有实体未进入森林（节点预算封顶或图不连通）。 */
  incomplete: boolean
}

/** 部分数据集失败时的可见性回调：failed = 失败数，total = 数据集总数；仅 failed>0 时回调。 */
export type PartialFailureReporter = (failed: number, total: number) => void

/** 原文检索附加选项（多数据集方法共用）。 */
export interface PartialFailureOptions {
  /** 部分数据集失败且整体仍返回时的回调（全失败走抛错路径，不回调）。 */
  onPartialFailure?: PartialFailureReporter
}

export interface SearchChunksOptions {
  topK?: number
  /**
   * 元数据硬过滤（RAGFlow meta_data_filter 契约）。简化形态：
   * `{ conditions: [{ key, op, value }], logic?: 'and' | 'or' }` 或裸数组
   * `[{ key, op, value }]`（逻辑默认 and）。客户端补全 method 字段。
   */
  metaFilter?: Record<string, unknown> | Array<Record<string, unknown>>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface GetPageOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onPartialFailure?: PartialFailureReporter
}

export interface StructureOptions {
  keywords?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onPartialFailure?: PartialFailureReporter
}

/**
 * 知识面客户端公共接口：`RagflowClient`（单租户）与 `bindKnowledgeTenant`
 * 返回的租户绑定视图都满足它。ToolContext 持有本接口——工具层不感知租户。
 */
export interface KnowledgeClient {
  searchChunks(question: string, options?: SearchChunksOptions): Promise<KnowledgeSearchOutcome>
  listPages(options?: ListPagesOptions): Promise<KnowledgePageItem[]>
  getPage(slugOrKeywords: string, options?: GetPageOptions): Promise<KnowledgePage | null>
  subgraph(options?: SubgraphOptions): Promise<KnowledgeSubgraph>
  structure(kind: string, options?: StructureOptions): Promise<KnowledgeSubgraph>
  mindmap(options?: StructureOptions): Promise<MindmapOutcome>
}

export interface SubgraphOptions extends PartialFailureOptions {
  /** 中心实体（wiki slug 或实体名）；提供时走 node 中心扩展。 */
  node?: string
  /** 概览种子关键词（node 未提供时生效）。 */
  keywords?: string
  topN?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface ListPagesOptions extends PartialFailureOptions {
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

/** structure 端点支持的 kind 枚举（线上 v0.27.x 实证）。 */
const STRUCTURE_KINDS = new Set(['graph', 'mindmap', 'timeline', 'session_essence', 'session_graph'])

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

/**
 * positions 净化为 5 元组 `[page, x0, x1, top, bottom]`（与 dsh-ragflow 的
 * normalizePositions 同一契约）：page 必须 ≥1 且全坐标有限才保留，其余行丢弃——
 * RAGFlow 常以 `[null, …]` 打头，Number(null)=0 的宽松转换会让 page=0 假页码存活。
 */
function positionsOf(raw: Record<string, unknown>): number[][] | null {
  if (!Array.isArray(raw.positions)) return null
  const rows: number[][] = []
  for (const entry of raw.positions) {
    if (!Array.isArray(entry) || entry.length < 5) continue
    const [page, x0, x1, top, bottom] = entry as unknown[]
    if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) continue
    if (![x0, x1, top, bottom].every((n) => typeof n === 'number' && Number.isFinite(n))) continue
    rows.push([page, x0, x1, top, bottom] as number[])
  }
  return rows.length > 0 ? rows : null
}

/**
 * slug 形态：`<page_type>/<名称>`。page_type 只认小写字母开头的 ASCII 短词
 * （entity/concept/topic/regulation…服务端可扩展），不再硬编码三值白名单——
 * 新增页面类型不会被误判成关键词；page_type 至少 2 字符，`a/b` 这类单词斜杠
 * 仍按关键词处理。
 */
const SLUG_RE = /^[a-z][a-z0-9_-]{1,31}\/\S+$/

/** 实体名 → wiki slug（`<page_type>/<name>`）；已是 slug 形态原样返回。 */
export function entitySlug(name: string): string {
  const trimmed = name.trim()
  return SLUG_RE.test(trimmed) ? trimmed : `entity/${trimmed}`
}

/** wiki slug → 人类可读名（去掉 `<page_type>/` 前缀）。 */
export function slugName(slug: string): string {
  const idx = slug.indexOf('/')
  return idx >= 0 ? slug.slice(idx + 1) : slug
}

/**
 * RagflowClient 构造配置：KnowledgeConfig 的客户端子集（租户注册表/兜底属于
 * 服务装配层，不进客户端）。完整 KnowledgeConfig 结构上天然满足本类型。
 */
export type RagflowClientConfig = Pick<
  KnowledgeConfig,
  'ragflowBaseUrl' | 'ragflowApiKey' | 'datasetIds' | 'timeoutMs' | 'maxChunks' | 'maxGraphEntities'
>

/**
 * RAGFlow 知识面客户端。
 *
 * 每个方法独立可测（`fetchImpl` 注入）；多数据集方法（search/subgraph/listPages）
 * 逐个数据集调用后按 slug/title 合并去重，某个数据集失败不拖垮整体
 * （该数据集贡献为空），全部失败才抛错。
 */
export class RagflowClient implements KnowledgeClient {
  constructor(
    private readonly config: RagflowClientConfig,
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
        '知识面未配置检索目标：多租户请配置 knowledge.tenants[].datasetIds（每租户各自的数据集），'
        + '遗留单租户请配置 knowledge.datasetIds',
      )
    }
    return this.config.datasetIds
  }

  /**
   * 网络层异常收敛：AskdataError 直通；超时（TimeoutError）与取消（AbortError）
   * 单独措辞（原样透出英文 "This operation was aborted" 会误导排障）；其余按
   * BACKEND_DOWN 收敛为 AskdataError，不向调用方暴露堆栈。
   */
  private transportFailure(err: unknown, path: string): never {
    if (err instanceof Error && err.name === 'AskdataError') throw err
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw askdataError(
        'BACKEND_DOWN',
        err.name === 'TimeoutError'
          ? `RAGFlow 调用超时（knowledge.timeoutMs=${this.config.timeoutMs}ms，${path.split('?')[0]}）`
          : `知识调用已被取消（${path.split('?')[0]}）`,
      )
    }
    throw askdataError('BACKEND_DOWN', `无法访问 RAGFlow（${path.split('?')[0]}）：${String(err instanceof Error ? err.message : err).slice(0, 160)}`)
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
      this.transportFailure(err, path)
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
      this.transportFailure(err, path)
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
   * 元数据硬过滤形态归一：裸数组 / {conditions} → RAGFlow meta_data_filter 全量形态。
   * 条件逐条净化（key/op/value 只允许标量）；非法条件整体忽略（不过滤），
   * 由服务端做最终校验——客户端不静默篡改语义。
   */
  private normalizeMetaFilter(
    input: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
  ): Record<string, unknown> | undefined {
    if (input === undefined || input === null) return undefined
    const raw = Array.isArray(input) ? { conditions: input } : input
    const conditionsRaw = Array.isArray(raw.conditions) ? raw.conditions : []
    const conditions = conditionsRaw
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({ key: String(c.key ?? ''), op: String(c.op ?? '='), value: c.value }))
      .filter((c) => c.key.length > 0 && ['string', 'number', 'boolean'].includes(typeof c.value))
    if (conditions.length === 0) return undefined
    const logic = raw.logic === 'or' ? 'or' : 'and'
    return { method: 'manual', logic, conditions }
  }

  /**
   * 原文片段检索（多数据集一次调用）。
   *
   * 与 dsh-plugins/lingzhi-knowledge-tool 的 searchDatasets 契约一致：
   * dataset_ids 数组 + question + top_k + rerank_candidates_count。
   *
   * 注意（实测）：`top_k` 只是 kNN 候选池，返回条数由服务端 page_size（默认 30）
   * 控制——客户端按 topK 截断，保证知识面预算配置真实生效。
   * 出处字段容错：线上响应用 `doc_id`/`docnm_kwd`，旧契约用
   * `document_id`/`document_keyword`，两者都认。
   */
  async searchChunks(question: string, options: SearchChunksOptions = {}): Promise<KnowledgeSearchOutcome> {
    const datasetIds = this.requireDatasets()
    const topK = Math.min(50, Math.max(1, Math.trunc(options.topK ?? this.config.maxChunks)))
    const payload: Record<string, unknown> = {
      dataset_ids: datasetIds,
      question,
      top_k: topK,
      rerank_candidates_count: Math.max(topK * 4, 40),
    }
    const metaFilter = this.normalizeMetaFilter(options.metaFilter)
    if (metaFilter) payload.meta_data_filter = metaFilter

    const data = await this.postJson('/datasets/search', payload, options.signal, options.fetchImpl)
    const rawChunks = (data as { chunks?: unknown } | null)?.chunks
    const chunks: KnowledgeChunk[] = []
    if (Array.isArray(rawChunks)) {
      for (const item of rawChunks) {
        if (item === null || typeof item !== 'object') continue
        const c = item as Record<string, unknown>
        const content = str(c.content_with_weight) || str(c.content)
        if (content.trim().length === 0) continue
        const positions = positionsOf(c)
        chunks.push({
          content,
          // 出处双契约：线上 doc_id/docnm_kwd，旧版 document_id/document_keyword
          documentId: str(c.doc_id) || str(c.document_id),
          documentName: str(c.docnm_kwd) || str(c.document_keyword) || str(c.document_name),
          similarity: toNumber(c.similarity),
          ...(str(c.chunk_id) ? { chunkId: str(c.chunk_id) } : {}),
          ...(positions ? { positions } : {}),
          ...(toNumber(c.page_num) !== null ? { pageNum: toNumber(c.page_num) } : {}),
          ...(str(c.image_id) ? { imageId: str(c.image_id) } : {}),
        })
      }
    }

    // 标签分布（标签库软重排）：{"标签名": 命中数}；缺失/空为 {}
    const rawLabels = (data as { labels?: unknown } | null)?.labels
    const labels: KnowledgeLabels = {}
    if (rawLabels !== null && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
      for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
        const n = toNumber(value)
        if (key && n !== null) labels[key] = n
      }
    }

    // 同文去重（对齐 dsh-ragflow dedupeByContent 契约）：同一文档多次入库会返回
    // 同文异 id 的片段，既占 topK 预算又让引用重复计数；按归一化正文（空白折叠）
    // 去重保首见——分块差异（解析/OCR 波动）不构成"不同证据"。
    const seenText = new Set<string>()
    const deduped: KnowledgeChunk[] = []
    for (const c of chunks) {
      const identity = c.content.replace(/\s+/gu, ' ')
      if (seenText.has(identity)) continue
      seenText.add(identity)
      deduped.push(c)
    }

    return { chunks: deduped.slice(0, topK), labels }
  }

  /**
   * wiki 页面清单（keywords 命中 title/summary；多数据集合并）。
   *
   * 每个数据集都查询（各取 limit 条候选）后统一去重截断——不在前置数据集吃满
   * limit 时提前返回，避免后置数据集被饿死（合并顺序仍按数据集配置顺序）。
   */
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
      }
    }
    if (items.length === 0 && failures.length === datasetIds.length) throw failures[0]
    if (failures.length > 0) options.onPartialFailure?.(failures.length, datasetIds.length)
    return items.slice(0, limit)
  }

  /**
   * wiki 页面全文（按 slug 或关键词定位；slug 需带 `<page_type>/` 前缀）。
   *
   * 失败语义与 listPages/subgraph 一致：逐数据集找第一个命中；某数据集失败
   * （业务失败或网络失败）不拖垮整体；**全部数据集失败才抛首个错误**——业务
   * 失败（如 API key 失效）不能吞成"页面不存在"，否则模型会带着用户反复换名重试。
   * 部分失败且未找到时回调 onPartialFailure 后返回 null。
   */
  async getPage(
    slugOrKeywords: string,
    options: GetPageOptions = {},
  ): Promise<KnowledgePage | null> {
    const datasetIds = this.requireDatasets()
    const trimmed = slugOrKeywords.trim()
    if (!trimmed) throw askdataError('INVALID_PARAM', 'slug 或关键词不能为空')

    if (SLUG_RE.test(trimmed)) {
      // slug 直取：拆 page_type/slug 逐数据集找第一个命中
      const [pageType, ...rest] = trimmed.split('/')
      const slug = rest.join('/')
      const failures: unknown[] = []
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
          failures.push(err)
        }
      }
      if (failures.length === datasetIds.length) throw failures[0]!
      if (failures.length > 0) options.onPartialFailure?.(failures.length, datasetIds.length)
      return null
    }

    // 关键词定位：清单取第一个标题/关键词最贴合的条目
    const candidates = await this.listPages({
      keywords: trimmed,
      limit: 5,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      ...(options.onPartialFailure ? { onPartialFailure: options.onPartialFailure } : {}),
    })
    const exact = candidates.find((c) => c.title === trimmed) ?? candidates[0]
    if (!exact) return null
    return this.getPage(exact.slug, { signal: options.signal, fetchImpl: options.fetchImpl, onPartialFailure: options.onPartialFailure })
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
          const predicate = str(row.predicate) || str(row.keywords) || str(row.type)
          if (!from || !to || from === to) continue
          // 去重键含谓词：同一实体对的不同关系（如"任职于"与"管理"）各自成边，不互相吞并
          const key = `${from}\u0000${to}\u0000${predicate}`
          if (relationKeys.has(key)) continue
          relationKeys.add(key)
          relations.push({
            from,
            to,
            predicate,
            weight: toNumber(row.weight) ?? 0,
            description: str(row.description),
            datasetId,
          })
        }
      }
    }

    if (entityBySlug.size === 0 && failures.length === datasetIds.length) throw failures[0]
    if (failures.length > 0) options.onPartialFailure?.(failures.length, datasetIds.length)

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

  /**
   * 数据集级结构图谱（kind: graph/mindmap/timeline/session_essence/session_graph）。
   * kind 白名单在调用期校验（拼错直接 INVALID_PARAM，不发无效请求）。
   */
  async structure(
    kind: string,
    options: StructureOptions = {},
  ): Promise<KnowledgeSubgraph> {
    if (!STRUCTURE_KINDS.has(kind)) {
      throw askdataError('INVALID_PARAM', `structure kind 非法：${kind}（允许：${[...STRUCTURE_KINDS].join(' / ')}）`)
    }
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
          const predicate = str(row.predicate) || str(row.keywords) || str(row.type)
          if (!from || !to || from === to) continue
          // 去重键含谓词：同一实体对的不同关系（如"任职于"与"管理"）各自成边，不互相吞并
          const key = `${from}\u0000${to}\u0000${predicate}`
          if (relationKeys.has(key)) continue
          relationKeys.add(key)
          relations.push({
            from,
            to,
            predicate,
            weight: toNumber(row.weight) ?? 0,
            description: str(row.description),
            datasetId,
          })
        }
      }
    }

    if (entityBySlug.size === 0 && failures.length === datasetIds.length) throw failures[0]
    if (failures.length > 0) options.onPartialFailure?.(failures.length, datasetIds.length)
    const entities = [...entityBySlug.values()]
    const known = new Set(entities.map((e) => e.slug))
    return { entities, relations: relations.filter((r) => known.has(r.from) && known.has(r.to)) }
  }

  /**
   * 脑图层级森林（mindmap 编译产物，父子边为 has_branch/has_sub_branch）。
   *
   * 与 structure('mindmap') 的差别：把 entities+relations 组装成树——
   * central_topic 为根，无入边的节点为根（兜底），环/悬空边安全跳过。
   * `keywords` 透传服务端做种子过滤；`onPartialFailure` 同 structure。
   * 返回预算信息：预算截断/孤立节点导致的"未全部展开"必须让调用方可见，
   * 否则模型可能对被截断的层级数给出自信的错答案。
   */
  async mindmap(
    options: StructureOptions = {},
  ): Promise<MindmapOutcome> {
    const sub = await this.structure('mindmap', options)
    const cap = this.config.maxGraphEntities
    const byName = new Map(sub.entities.map((e) => [e.name, e]))
    const childrenOf = new Map<string, string[]>()
    const hasParent = new Set<string>()
    for (const rel of sub.relations) {
      if (!byName.has(rel.from) || !byName.has(rel.to) || rel.from === rel.to) continue
      const list = childrenOf.get(rel.from) ?? []
      if (!list.includes(rel.to)) list.push(rel.to)
      childrenOf.set(rel.from, list)
      hasParent.add(rel.to)
    }

    // 根：central_topic 优先，其次无父节点；都没有则取前几个实体（防空树）
    const roots = sub.entities.filter((e) => e.type === 'central_topic').map((e) => e.name)
    if (roots.length === 0) {
      roots.push(...sub.entities.filter((e) => !hasParent.has(e.name)).map((e) => e.name))
    }
    if (roots.length === 0 && sub.entities.length > 0) roots.push(sub.entities[0]!.name)

    let budget = cap
    const build = (name: string, seen: Set<string>): MindmapNode | null => {
      if (budget <= 0 || seen.has(name)) return null
      const entity = byName.get(name)
      if (!entity) return null
      seen.add(name)
      budget -= 1
      const children: MindmapNode[] = []
      for (const child of childrenOf.get(name) ?? []) {
        const node = build(child, seen)
        if (node) children.push(node)
      }
      return { name, type: entity.type, description: entity.description, children }
    }

    const forest: MindmapNode[] = []
    for (const root of roots) {
      const node = build(root, new Set())
      if (node) forest.push(node)
    }
    const expandedNodes = cap - budget
    return {
      forest,
      totalNodes: sub.entities.length,
      expandedNodes,
      incomplete: expandedNodes < sub.entities.length,
    }
  }
}

/**
 * 把租户注册表绑定为一次工具调用的知识面视图（多租户方案 1 的路由点）。
 *
 * 租户选择发生在上下文创建期（`createContext({tenantId})` 捕获），工具层只看到
 * KnowledgeClient 接口、不感知租户；解析失败在首次方法调用时 fail loud
 * （AskdataError INVALID_PARAM，可用租户名列在消息里）——绝不静默落别的租户，
 * 防跨租户误用。
 */
export function bindKnowledgeTenant(
  clients: ReadonlyMap<string, RagflowClient>,
  tenantId: string | undefined,
  defaultTenant: string,
): KnowledgeClient {
  const pick = (): RagflowClient => {
    const wanted = (tenantId ?? '').trim() || defaultTenant
    const client = wanted !== '' ? clients.get(wanted) : undefined
    if (client === undefined) {
      throw askdataError(
        'INVALID_PARAM',
        `知识面租户未解析：tenantId=${tenantId || '（未提供）'}，defaultTenant=${defaultTenant || '（未配置）'}`
        + `，可用租户：${[...clients.keys()].join('、') || '（无）'}。`
        + '请配置 knowledge.defaultTenant 或在会话上下文携带 tenantId。',
      )
    }
    return client
  }
  // 委托方法一律 async：租户解析的同步抛错转成 rejected promise，
  // 调用方（工具层 catch 管线）按统一失败语义处理。
  return {
    searchChunks: async (question, options) => pick().searchChunks(question, options),
    listPages: async (options) => pick().listPages(options),
    getPage: async (slugOrKeywords, options) => pick().getPage(slugOrKeywords, options),
    subgraph: async (options) => pick().subgraph(options),
    structure: async (kind, options) => pick().structure(kind, options),
    mindmap: async (options) => pick().mindmap(options),
  }
}
