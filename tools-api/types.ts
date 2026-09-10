/**
 * API 工具抽象与公共执行管线。
 *
 * `AskdataApiTool` 是框架无关的 API 工具面（name/description/inputSchema/handler），
 * 与 SQL 工具并存，由 `runApiTool` 统一负责计时、AGP ToolResult 组装与审计落行。
 * @module
 */

import type { AskdataConfig } from '../src/config.ts'
import type { ResultField, ToolResult } from '../src/result.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import { buildAuditRow, type AuditRow } from '../src/audit.ts'
import { ApiClient } from '../src/api/client.ts'

/** 接口层级（《工具实现规范》§1.6）。 */
export type ToolLayer = 'metadata' | 'base_business' | 'scenario' | 'project'

/** API 执行口（由 ApiClient 提供）。 */
export interface ApiExecutor {
  execute<T>(path: string, params: Record<string, string>): Promise<T>
}

/** 工具运行上下文。 */
export interface ApiToolContext {
  config: AskdataConfig
  /** API 客户端（新 API 网关）。 */
  apiClient: ApiClient
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

/** 一次 API 查询的执行计划。 */
export interface ApiPlan {
  /** API 路径（用于审计与展示）。 */
  path: string
  params: Record<string, unknown>
  fields: ResultField[]
  /** 行 → AGP data 行（含类型转换）。 */
  shape(rows: Record<string, unknown>[]): Record<string, unknown>[]
}

/** 数值列转换：null/undefined 透传为 null，其余 Number。 */
export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/** 字符串列转换：null/undefined 透传为 null，其余 String。 */
export function toString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

/**
 * 公共执行管线：构建 API 请求 → 执行 → 组装 ToolResult → 审计。
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
  let path = ''
  try {
    if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
    const p = await plan()
    path = p.path
    const data = await ctx.apiClient.execute<unknown>(path, p.params as Record<string, string>)
    const shapedData = p.shape(data as Record<string, unknown>[])
    const result = ok(tool.name, {
      apiOrSql: `API ${path}`,
      params: args,
      fields: p.fields,
      data: shapedData,
      executionMs: Date.now() - started,
    })
    applyAudit(tool, args, ctx, path, result, started)
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
      apiOrSql: path ? `API ${path}` : '',
    })
    applyAudit(tool, args, ctx, path, result, started)
    return result
  }
}

/** 构建审计行并回调宿主；成功落行后把 auditId 回填进 ToolResult。 */
function applyAudit(
  tool: { name: string; layer: ToolLayer },
  args: Record<string, unknown>,
  ctx: ApiToolContext,
  apiPath: string,
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
      sqlText: apiPath,
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