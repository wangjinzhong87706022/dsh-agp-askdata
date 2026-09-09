/**
 * AGP 标准返回结构（《工具实现规范》§1.2 ToolResult）。
 *
 * `fields` + `data` 按 0903 会议定义的结构化契约组织，前端可直接渲染；
 * `citations` 面向 P2 强制溯源（每个回答 ≥2 条引用），P0 恒为空对象。
 * @module
 */

import { retryHint, type ErrorCode } from './errors.ts'

/** 字段元数据：`fields[i]` 描述 `data[*][name]`。 */
export interface ResultField {
  name: string
  title: string
  type: 'string' | 'number' | 'datetime' | 'boolean'
}

/** 分页信息。 */
export interface PageInfo {
  pageNum: number
  pageSize: number
  pageTotal: number
  itemTotal: number
}

/** AGP 标准工具返回。 */
export interface ToolResult {
  success: boolean
  toolName: string
  /** 实际执行的 SQL（已脱敏）或 HTTP URL。 */
  apiOrSql: string
  params: Record<string, unknown>
  fields: ResultField[]
  data: Record<string, unknown>[]
  rowCount: number
  executionMs: number
  auditId: string
  citations: Record<string, string>
  errorMessage: string
  errorCode: ErrorCode | ''
  page?: PageInfo
}

/** 成功返回。 */
export function ok(
  toolName: string,
  args: {
    apiOrSql: string
    params: Record<string, unknown>
    fields: ResultField[]
    data: Record<string, unknown>[]
    executionMs: number
    auditId?: string
    page?: PageInfo
  },
): ToolResult {
  return {
    success: true,
    toolName,
    apiOrSql: args.apiOrSql,
    params: args.params,
    fields: args.fields,
    data: args.data,
    rowCount: args.data.length,
    executionMs: args.executionMs,
    auditId: args.auditId ?? '',
    citations: {},
    errorMessage: '',
    errorCode: '',
    page: args.page,
  }
}

/** 失败返回。`apiOrSql` 允许为空串（未执行到 SQL 即失败的场景）。 */
export function fail(
  toolName: string,
  args: {
    params: Record<string, unknown>
    code: ErrorCode
    message: string
    executionMs: number
    apiOrSql?: string
  },
): ToolResult {
  const hint = retryHint(args.code)
  return {
    success: false,
    toolName,
    apiOrSql: args.apiOrSql ?? '',
    params: args.params,
    fields: [],
    data: [],
    rowCount: 0,
    executionMs: args.executionMs,
    auditId: '',
    citations: {},
    errorMessage: hint ? `${args.message}；建议：${hint}` : args.message,
    errorCode: args.code,
  }
}
