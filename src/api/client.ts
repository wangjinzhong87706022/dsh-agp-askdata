/**
 * AGP REST API 客户端：封装 HTTP 请求、认证头注入、错误码映射。
 *
 * 所有取数走 AGP REST API（`/s1M6_uE9/wz/`），不直连数据库。
 * 认证通过 WT-TOKEN / WT-OPENID / WT-PROJECTID 请求头传递。
 * @module
 */

import { askdataError, AskdataError } from '../errors.ts'
import type { ApiConfig } from '../config.ts'

/** API 统一返回结构。 */
interface ApiResponse<T = unknown> {
  code: number | string
  message: string
  data: T
  timestamp: number
  executeTime: number
}

/** 模型列表项。 */
export interface ModelInfo {
  id: number
  class_alias: string
  class_name: string
  class_path: string
  class_description: string
  classify_tag: string
  app_id: number
  app_domain: string
}

/** 模型属性项。 */
export interface ModelAttribute {
  field_name: string
  field_description: string
  field_type: string
}

/** 查询数据返回。 */
export interface QueryResult {
  field: Array<{ name: string; title: string; type: string }>
  data: Record<string, unknown>[]
  page: { pageNum: number; pageSize: number; pageTotal: number; itemTotal: number }
}

/**
 * AGP REST API 客户端。
 *
 * 封装 fetch 调用，自动注入认证头，映射 API 错误码为 AskdataError。
 */
export class ApiClient {
  private readonly config: ApiConfig

  constructor(config: ApiConfig) {
    this.config = config
  }

  /** GET 请求。 */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    const url = `${this.config.baseUrl}${this.config.apiPrefix}${path}${qs}`
    return this.request<T>('GET', url)
  }

  /** POST 请求。 */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.config.baseUrl}${this.config.apiPrefix}${path}`
    return this.request<T>('POST', url, JSON.stringify(body))
  }

  /** 获取认证头。WT-ROUTER 为网关鉴权中间件的实测必需头（缺它报 00011「登录过期」，2026-09-10 E2E 实证）。 */
  private authHeaders(): Record<string, string> {
    return {
      'WT-TOKEN': this.config.token,
      'WT-OPENID': this.config.openid,
      'WT-APPID': this.config.projectId,
      'WT-PROJECTID': this.config.projectId,
      'WT-ROUTER': '#/',
    }
  }

  /**
   * 通用执行方法（供 runApiTool 调用）：method 显式声明，不再按路径字符串嗅探。
   * GET 走查询串（数组值自动逗号连接，对齐 tagNames 约定）；POST 走 JSON body。
   */
  async execute<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown>): Promise<T> {
    if (method === 'POST') {
      return this.post<T>(path, params)
    }
    const query: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      query[key] = Array.isArray(value) ? value.join(',') : String(value)
    }
    return this.get<T>(path, query)
  }

  /** 执行 HTTP 请求并处理响应（5xx 带退避重试）。 */
  private async request<T>(method: string, url: string, body?: string): Promise<T> {
    const headers: Record<string, string> = this.authHeaders()
    if (body) headers['Content-Type'] = 'application/json'

    const maxRetries = 2
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let resp: Response
      try {
        resp = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('timeout') || msg.includes('abort')) {
          throw askdataError('API_TIMEOUT', `API 请求超时 (${this.config.timeoutMs}ms): ${path(url)}`)
        }
        throw askdataError('API_UNREACHABLE', `API 不可达: ${msg}`)
      }

      if (!resp.ok) {
        // 5xx 错误可重试
        if (resp.status >= 500 && resp.status < 600 && attempt < maxRetries) {
          await this.sleep(100 * attempt)
          continue
        }
        throw askdataError('API_HTTP_ERROR', `HTTP ${resp.status}: ${resp.statusText}`)
      }

      // 解析 JSON 响应（先读文本：部分接口在模型不存在等场景返回 200+空响应体）
      let text: string
      try {
        text = await resp.text()
      } catch {
        throw askdataError('API_ERROR', `API 响应体不可读: ${resp.status} ${resp.statusText}`)
      }
      if (!text.trim()) {
        throw askdataError(
          'API_ERROR',
          `API 返回空响应体(HTTP ${resp.status})——常见于请求的模型/关系在本项目不存在: ${path(url)}`,
        )
      }
      try {
        const j = JSON.parse(text) as ApiResponse<T>
        return this.handleResponse(j)
      } catch (e) {
        if (e instanceof AskdataError) throw e
        throw askdataError('API_ERROR', `API 返回非 JSON 响应: ${resp.status} ${resp.statusText}，响应体: ${text.slice(0, 200)}`)
      }
    }
    throw askdataError('API_ERROR', `API 请求失败（已重试 ${maxRetries} 次）`)
  }

  /** 延迟辅助（指数退避）。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 映射 API 错误码。 */
  private handleResponse<T>(j: ApiResponse<T>): T {
    const code = j.code
    if (code === 0) return j.data

    const msg = j.message || '未知错误'
    if (code === '00010') throw askdataError('AUTH_REQUIRED', 'API 未登录，请检查 Token 配置')
    if (code === '00011') throw askdataError('AUTH_EXPIRED', 'Token 已过期，请重新获取')
    if (code === 1) throw askdataError('INVALID_PARAM', `参数错误: ${msg}`)
    if (code === -1) {
      if (msg.includes('没有找到模型')) throw askdataError('MODEL_NOT_FOUND', msg)
      throw askdataError('API_ERROR', `API 内部错误: ${msg}`)
    }
    throw askdataError('API_ERROR', `API 错误 (code=${code}): ${msg}`)
  }

  // ── 高级方法 ──────────────────────────────────────────────

  /** 获取所有模型列表。 */
  async getModelList(): Promise<ModelInfo[]> {
    const data = await this.get<{ field: unknown[]; data: ModelInfo[] }>('/wz/meta/getModelList')
    return data.data
  }

  /** 获取模型基本属性。 */
  async getModelAttributes(modelName: string): Promise<ModelAttribute[]> {
    const data = await this.get<{ field: ModelAttribute[] }>('/wz/meta/getModelBasAttributes', { modelName })
    return data.field || (data as unknown as ModelAttribute[])
  }

  /** 查询模型数据（自动选择 GET/POST）。 */
  async queryModelData(params: {
    modelName: string
    searchStr: string
    whereStr?: string
    pageNum?: number
    pageSize?: number
    orderByStr?: string
    groupByStr?: string
  }): Promise<QueryResult> {
    const pageSize = Math.min(params.pageSize ?? 100, this.config.maxPageSize)
    const body = {
      modelName: params.modelName,
      searchStr: params.searchStr,
      whereStr: params.whereStr ?? '',
      pageNum: params.pageNum ?? 1,
      pageSize,
      orderByStr: params.orderByStr ?? '',
      groupByStr: params.groupByStr ?? '',
    }
    return this.post<QueryResult>('/wz/meta/postModelDataMeta', body)
  }

  /** 查询测点实时值（20260910 接口版：路径 getIOTTagRealValues，QueryResult 形态）。 */
  async getTagRealValues(tagNames: string[]): Promise<QueryResult> {
    return this.get<QueryResult>('/wz/iot-etl/iot/getIOTTagRealValues', {
      tagNames: tagNames.join(','),
    })
  }

  /** 查询测点历史原始值。 */
  async getTagRawHistory(params: {
    tagNames: string[]
    startTime: string
    endTime?: string
    sample?: number
  }): Promise<QueryResult> {
    const p: Record<string, string> = {
      tagNames: params.tagNames.join(','),
      startTime: params.startTime,
    }
    if (params.endTime) p.endTime = params.endTime
    if (params.sample) p.sample = String(params.sample)
    return this.get<QueryResult>('/wz/iot-etl/iot/getTagRawHistory', p)
  }

  /** 查询宽格式历史数据。 */
  async getWideHistory(params: {
    tagNames: string[]
    startTime: string
    interval: number
    endTime?: string
    sample?: number
    dateFormat?: string
  }): Promise<QueryResult> {
    const p: Record<string, string> = {
      tagNames: params.tagNames.join(','),
      startTime: params.startTime,
      interval: String(params.interval),
    }
    if (params.endTime) p.endTime = params.endTime
    if (params.sample) p.sample = String(params.sample)
    if (params.dateFormat) p.dateFormat = params.dateFormat
    return this.get<QueryResult>('/wz/iot-etl/iot/getWideHistory', p)
  }

  /** 查询测点历史统计值。 */
  async getTagAggregateHistory(params: {
    tagNames: string[]
    startTime: string
    methods: string[]
    endTime?: string
    sample?: number
    params?: string
  }): Promise<QueryResult> {
    const p: Record<string, string> = {
      tagNames: params.tagNames.join(','),
      startTime: params.startTime,
      methods: params.methods.join(','),
    }
    if (params.endTime) p.endTime = params.endTime
    if (params.sample) p.sample = String(params.sample)
    if (params.params) p.params = params.params
    return this.get<QueryResult>('/wz/iot-etl/iot/getTagAggrigateHistory', p)
  }
}

/** 从 URL 提取路径部分（错误信息用）。 */
function path(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}