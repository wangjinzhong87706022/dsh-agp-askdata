/**
 * API 工具抽象与公共执行管线。
 *
 * `AskdataApiTool` 是框架无关的 API 工具面（name/description/inputSchema/handler），
 * 由 `runApiTool` 统一负责「构建请求 → 恰好一次 HTTP 执行 → describe 组装
 * fields/data → AGP ToolResult → 审计落行」。
 *
 * 请求描述（ApiRequest）与响应解释（describe）显式分离：fields 元数据常需从
 * 响应推导（如 postModelDataMeta 的 field 数组），因此 describe 与 fields 使用
 * 同一次响应——管线绝不重放第二次请求（历史实现曾在 plan 内先调一次 typed
 * 方法、再按 path/params 重放一次，两次参数不一致导致过滤条件丢失）。
 * @module
 */

import type { AskdataConfig } from '../src/config.ts'
import type { PageInfo, ResultField, ToolResult } from '../src/result.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import { buildAuditRow, type AuditRow } from '../src/audit.ts'

/** 接口层级（《工具实现规范》§1.6）。 */
export type ToolLayer = 'metadata' | 'base_business' | 'scenario' | 'project'

/** 一次 API 请求的描述（管线据此执行恰好一次 HTTP 调用）。 */
export interface ApiRequest {
  path: string
  /** HTTP 方法，默认 GET；POST 时 params 作为 JSON body。 */
  method?: 'GET' | 'POST'
  /** GET 查询串参数（数组自动逗号连接）或 POST body；值须可序列化。 */
  params: Record<string, unknown>
}

/** describe 的输出：fields 与 data 必须来自同一次响应。 */
export interface DescribedData {
  fields: ResultField[]
  data: Record<string, unknown>[]
  page?: PageInfo
}

/** 一次 API 查询的执行计划。 */
export interface ApiPlan {
  request: ApiRequest
  /** 原始响应 → AGP fields + data 行（含类型转换）。 */
  describe(data: unknown): DescribedData
}

/** API 执行口（ApiClient 满足该形状；测试可注入内存实现）。 */
export interface ApiExecutor {
  execute(method: 'GET' | 'POST', path: string, params: Record<string, unknown>): Promise<unknown>
}

/** 工具运行上下文。 */
export interface ApiToolContext {
  config: AskdataConfig
  /** API 执行口（新 API 网关）。 */
  apiClient: ApiExecutor
  /** 宿主取消信号（模型中断工具调用）；执行层必须尽快终止查询。 */
  signal?: AbortSignal
  /** 哈希链上一条 result_hash；首条为空串。由宿主跨调用维护。 */
  prevAuditHash?: string
  /** 审计落行回调（写 WT_QUERY_AUDIT）；审计失败不阻断查询。 */
  onAudit?(row: AuditRow): void
  /** 诊断日志（凭据脱敏后）。 */
  log?(message: string): void
}

/** 框架无关的工具定义。 */
export interface AskdataApiTool {
  name: string
  description: string
  layer: ToolLayer
  /** JSON Schema 形式的入参描述。 */
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: ApiToolContext): Promise<ToolResult>
}

/** 数值列转换：null/undefined 透传为 null，其余 Number。 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/** 字符串列转换：null/undefined 透传为 null，其余 String。 */
export function toString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

/** 正整数入参校验（分页/间隔/样本数共用），失败抛 INVALID_PARAM。 */
export function validatePositiveInt(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw askdataError('INVALID_PARAM', `${field} 必须是正整数`)
  }
  return n
}

/** tag_names 数组入参校验：非空数组、全为非空字符串。 */
export function validateTagNamesArg(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw askdataError('INVALID_PARAM', 'tag_names 必填且不能为空数组')
  }
  return value.map((item) => {
    const s = String(item ?? '').trim()
    if (s === '') throw askdataError('INVALID_PARAM', 'tag_names 不能含空字符串')
    return s
  })
}

/** AGP 模型字段类型码 → ResultField.type（'1'/'11'/'22' 数值、'51' 时间日期 / '52' 日期，其余 string）。 */
function resultFieldType(type: string): ResultField['type'] {
  if (type === '1' || type === '11' || type === '22') return 'number'
  if (type === '51' || type === '52') return 'datetime'
  return 'string'
}

/**
 * QueryResult 形态响应（`{field, data, page}`）→ fields + 类型化 data 行 + 分页。
 *
 * postModelDataMeta / getTagRawHistory / getWideHistory / getTagAggrigateHistory
 * 共用该响应形态；字段类型按 API field 元数据的 type 码转换。
 */
export function describeQueryResult(raw: unknown): DescribedData {
  const qr = raw as {
    field?: Array<{ name: string; title?: string; type: string }>
    data?: Record<string, unknown>[]
    page?: { pageNum: unknown; pageSize: unknown; pageTotal: unknown; itemTotal: unknown }
  }
  const field = qr.field ?? []
  const fields = field.map((f) => ({
    name: f.name,
    title: f.title || f.name,
    type: resultFieldType(f.type),
  }))
  const data = (qr.data ?? []).map((row) => {
    const obj: Record<string, unknown> = {}
    for (const f of field) {
      obj[f.name] =
        resultFieldType(f.type) === 'number' ? toNumber(row[f.name]) : toString(row[f.name])
    }
    return obj
  })
  const page = qr.page
    ? {
        pageNum: Number(qr.page.pageNum),
        pageSize: Number(qr.page.pageSize),
        pageTotal: Number(qr.page.pageTotal),
        itemTotal: Number(qr.page.itemTotal),
      }
    : undefined
  return { fields, data, page }
}

/**
 * 公共执行管线：构建请求 → 恰好一次执行 → describe → 组装 ToolResult → 审计。
 *
 * 构建/执行任一环节抛出的 `AskdataError` 按规范错误码返回；
 * 其余异常按 BACKEND_DOWN 收敛，不向 LLM 暴露堆栈。
 */
export async function runApiTool(
  tool: { name: string; layer: ToolLayer },
  args: Record<string, unknown>,
  ctx: ApiToolContext,
  plan: () => Promise<ApiPlan>,
): Promise<ToolResult> {
  const started = Date.now()
  let apiOrSql = ''
  try {
    if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
    const p = await plan()
    const method = p.request.method ?? 'GET'
    apiOrSql = `${method} API ${p.request.path}`
    const raw = await ctx.apiClient.execute(method, p.request.path, p.request.params)
    const described = p.describe(raw)
    const result = ok(tool.name, {
      apiOrSql,
      params: args,
      fields: described.fields,
      data: described.data,
      page: described.page,
      executionMs: Date.now() - started,
    })
    applyAudit(tool, args, ctx, apiOrSql, result, started)
    return result
  } catch (err) {
    const askErr = err instanceof AskdataError ? err : null
    const code = askErr ? askErr.code : 'BACKEND_DOWN'
    const message = askErr ? askErr.message : `工具执行异常: ${err instanceof Error ? err.message : String(err)}`
    const result = fail(tool.name, {
      params: args,
      code,
      message,
      executionMs: Date.now() - started,
      apiOrSql,
    })
    applyAudit(tool, args, ctx, apiOrSql, result, started)
    return result
  }
}

/** 构建审计行并回调宿主；成功落行后把 auditId 回填进 ToolResult。 */
function applyAudit(
  tool: { name: string; layer: ToolLayer },
  args: Record<string, unknown>,
  ctx: ApiToolContext,
  apiOrSql: string,
  result: ToolResult,
  started: number,
): void {
  if (!ctx.config.audit.enabled || !ctx.onAudit) return
  try {
    const row = buildAuditRow({
      userId: ctx.config.audit.userId,
      appId: ctx.config.audit.appId,
      orgId: ctx.config.audit.orgId,
      question: JSON.stringify(args),
      sqlText: apiOrSql,
      apiParams: args,
      rowCount: result.rowCount,
      executionMs: Date.now() - started,
      errorCode: result.errorCode || undefined,
      errorMessage: result.errorMessage || undefined,
      resultJson: JSON.stringify(result.data),
      prevHash: ctx.prevAuditHash ?? '',
      toolName: tool.name,
      toolLayer: tool.layer,
    })
    ctx.onAudit(row)
    result.auditId = row.auditId
  } catch (err) {
    ctx.log?.(`审计记录失败（不阻断查询）: ${err instanceof Error ? err.message : String(err)}`)
  }
}
