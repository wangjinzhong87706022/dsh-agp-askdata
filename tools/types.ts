/**
 * 工具抽象与公共执行管线。
 *
 * `AskdataTool` 是框架无关的工具面（name/description/inputSchema/handler），
 * P1 的 DSH 集成把它适配到 DSH 工具注册模型；`runSqlTool` 统一负责
 * 校验层闸门、执行计时、AGP ToolResult 组装与审计落行。
 * @module
 */

import type { AskdataConfig } from '../src/config.ts'
import type { QueryOutput } from '../src/clients/starrocks.ts'
import type { ResultField, ToolResult } from '../src/result.ts'
import { fail, ok } from '../src/result.ts'
import { assertSafeToExecute } from '../src/sql/whitelist.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import { buildAuditRow, type AuditRow } from '../src/audit.ts'

/** 接口层级（《工具实现规范》§1.6）。 */
export type ToolLayer = 'metadata' | 'base_business' | 'scenario' | 'project'

/** SQL 执行口（由执行层适配器提供；测试可替换为内存实现）。 */
export interface SqlExecutor {
  execute(sql: string, options?: { signal?: AbortSignal }): Promise<QueryOutput>
}

/** 工具运行上下文。 */
export interface ToolContext {
  config: AskdataConfig
  executor: SqlExecutor
  /** MySQL 执行器（P1 元数据/告警工具用）。 */
  mysqlExecutor: SqlExecutor
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
export interface AskdataTool {
  name: string
  description: string
  layer: ToolLayer
  /** JSON Schema 形式的入参描述。 */
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** 一次模板查询的执行计划。 */
export interface SqlPlan {
  sql: string
  params: Record<string, unknown>
  fields: ResultField[]
  /** 行 → AGP data 行（含类型转换）。 */
  shape(rows: Record<string, string | null>[]): Record<string, unknown>[]
  /**
   * 载体：'sql'（默认）= SQL 语句，派发前过白名单闸门；
   * 'http' = REST 调用，`sql` 字段承载请求 URL（ToolResult.apiOrSql 契约），
   * 不做 SQL 分类/白名单校验。
   */
  transport?: 'sql' | 'http'
  /**
   * 自定义执行闭包（REST 等非 SQL 载体用）：提供时取代默认执行器，
   * `sql` 字段仅作展示（apiOrSql）。
   */
  execute?(signal?: AbortSignal): Promise<QueryOutput>
}

/** 数值列转换：null/undefined 透传为 null，其余 Number。 */
export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/**
 * 公共执行管线：构建 SQL → 校验层闸门 → 执行 → 组装 ToolResult → 审计。
 *
 * 构建/校验/执行任一环节抛出的 `AskdataError` 按规范错误码返回；
 * 其余异常按 BACKEND_DOWN 收敛，不向 LLM 暴露堆栈。
 *
 * `options.executor` / `options.whitelist` 可覆盖默认的 StarRocks 执行器与白名单，
 * 供 P1 MySQL 元数据工具使用。
 */
export async function runSqlTool(
  tool: { name: string; layer: ToolLayer },
  args: Record<string, unknown>,
  ctx: ToolContext,
  plan: () => Promise<SqlPlan>,
  options?: { executor?: SqlExecutor; whitelist?: string[] },
): Promise<ToolResult> {
  const started = Date.now()
  let sql = ''
  try {
    if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
    const p = await plan()
    sql = p.sql
    if (p.transport !== 'http') {
      const whitelist = options?.whitelist ?? ctx.config.security.tableWhitelist
      assertSafeToExecute(sql, whitelist)
    }
    const out = p.execute
      ? await p.execute(ctx.signal)
      : await (options?.executor ?? ctx.executor).execute(sql, { signal: ctx.signal })
    const data = p.shape(out.rows)
    const result = ok(tool.name, {
      apiOrSql: sql,
      params: args,
      fields: p.fields,
      data,
      executionMs: Date.now() - started,
    })
    applyAudit(tool, args, ctx, sql, result, started)
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
      apiOrSql: sql,
    })
    applyAudit(tool, args, ctx, sql, result, started)
    return result
  }
}

/** 构建审计行并回调宿主；成功落行后把 auditId 回填进 ToolResult。 */
function applyAudit(
  tool: { name: string; layer: ToolLayer },
  args: Record<string, unknown>,
  ctx: ToolContext,
  sql: string,
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
      sqlText: sql,
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
