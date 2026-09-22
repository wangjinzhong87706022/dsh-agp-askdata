/**
 * 知识面工具公共管线（RAGFlow graph / wiki / 原文检索）。
 *
 * 与 `runSqlTool` 对偶：知识工具不过 SQL 闸门（载体是 HTTP GET/POST 检索），
 * 但同样统一负责 ok/fail 组装、执行计时与审计落行（sqlText 记 API URL，
 * apiUrl 字段同记——审计哈希链覆盖知识调用，问数溯源链完整）。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import type { ResultField, ToolResult } from '../src/result.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError, type ErrorCode } from '../src/errors.ts'
import { RagflowApiError, type RagflowClient } from '../src/clients/ragflow.ts'

/** 取知识面客户端；未装配时抛明确错误（不静默失效）。 */
export function requireKnowledge(ctx: ToolContext): RagflowClient {
  if (!ctx.knowledge) {
    throw askdataError(
      'BACKEND_DOWN',
      '知识面未装配：宿主未提供 RAGFlow 客户端（检查 knowledge.datasetIds 配置与插件装配）',
    )
  }
  return ctx.knowledge
}

/** 网络层错误统一收敛：RagflowApiError 保留 code 文本，其余按 BACKEND_DOWN。 */
export function toKnowledgeFailure(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AskdataError) return { code: err.code, message: err.message }
  if (err instanceof RagflowApiError) {
    return { code: 'BACKEND_DOWN', message: `RAGFlow 知识面业务失败: ${err.message}` }
  }
  return { code: 'BACKEND_DOWN', message: `知识面调用异常: ${err instanceof Error ? err.message : String(err)}` }
}

/** 一次知识工具调用的执行计划。 */
export interface KnowledgePlan {
  /** 展示用调用面（API 路径 + 关键参数摘要）。 */
  apiOrSql: string
  /** 审计用完整 URL。 */
  apiUrl: string
  fields: ResultField[]
  data: Record<string, unknown>[]
}

/**
 * 知识工具执行管线：执行 plan → ok/fail → 审计。
 *
 * `plan` 抛出的 AskdataError 按规范错误码返回；其余异常按 BACKEND_DOWN 收敛，
 * 不向 LLM 暴露堆栈。
 */
export async function runKnowledgeTool(
  tool: { name: string; layer: AskdataTool['layer'] },
  args: Record<string, unknown>,
  ctx: ToolContext,
  plan: () => Promise<KnowledgePlan>,
): Promise<ToolResult> {
  const started = Date.now()
  let apiOrSql = ''
  let apiUrl = ''
  try {
    if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
    const p = await plan()
    apiOrSql = p.apiOrSql
    apiUrl = p.apiUrl
    const result = ok(tool.name, {
      apiOrSql,
      params: args,
      fields: p.fields,
      data: p.data,
      executionMs: Date.now() - started,
    })
    applyAudit(tool, args, ctx, apiOrSql, result, started, apiUrl)
    return result
  } catch (err) {
    const { code, message } = toKnowledgeFailure(err)
    const result = fail(tool.name, {
      params: args,
      code,
      message,
      executionMs: Date.now() - started,
      apiOrSql,
    })
    applyAudit(tool, args, ctx, apiOrSql, result, started, apiUrl || undefined)
    return result
  }
}

/** 截断到指定字符数（保留可读性；超长加省略号）。 */
export function truncate(text: string, max: number): string {
  const t = text.length > max ? `${text.slice(0, max)}…` : text
  return t
}
