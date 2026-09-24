/**
 * AGP meta 数据查询族共享件（query_model / query_model_segment /
 * query_relation_segment / relation_field_list，docs/architecture.md §20.4）。
 *
 * 语义移植自事故丢失的 tools-api/types.ts（§18.x 时期线上实证，2026-09-24
 * 自 git 历史 3f27672 恢复移植）：
 *   - 动态 fields：fields 元数据来自响应 data.field 数组，data 行按字段类型转换；
 *   - 类型码映射：1/11/22→number，52→datetime，其余 string；
 *   - 分段定义解析（[{where_str,title}] → [{whereStr,title}]）；
 *   - POST 通道（与 model-relation-graph 的 agpGet 同款三头 + 超时/取消 + GBK 回退）。
 * @module
 */

import type { PageInfo, ResultField } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import { resolveAgpCredentials } from '../src/clients/tsdb-rest.ts'
import type { ToolContext } from './types.ts'
import { toNumber } from './types.ts'
import { decodeAgpBody, type AgpEnvelope } from './model-relation-graph.ts'

/** AGP 属性类型码 → ResultField 类型（§18.x 实测映射）。 */
export function resultFieldType(type: string): ResultField['type'] {
  if (type === '1' || type === '11' || type === '22') return 'number'
  if (type === '52') return 'datetime'
  return 'string'
}

/** describeEnvelope 的输出：fields/data/page 来自同一次响应（绝不重放请求）。 */
export interface DescribedEnvelope {
  fields: ResultField[]
  data: Record<string, unknown>[]
  page?: PageInfo
}

/**
 * 信封 → fields/data/page。fields 取自响应 field 数组（title 缺省用 name）；
 * field 数组为空时从首行键名推导 string 列；data 行仅保留 field 定义内的列并
 * 按类型转换（行中多余键丢弃，缺失键补空串）。
 */
export function describeEnvelope(env: AgpEnvelope): DescribedEnvelope {
  const colDefs = env.field.length > 0
    ? env.field
    : Object.keys(env.rows[0] ?? {}).map((name) => ({ name, title: name, type: '3' }))
  const fields: ResultField[] = colDefs.map((f) => ({
    name: String(f.name),
    title: String(f.title || f.name),
    type: resultFieldType(String(f.type ?? '3')),
  }))
  const data = env.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (const f of fields) {
      obj[f.name] = f.type === 'number' ? toNumber(row[f.name] as string | null | undefined) : (row[f.name] ?? '')
    }
    return obj
  })
  const out: DescribedEnvelope = { fields, data }
  if (env.page) out.page = env.page
  return out
}

/** 正整数入参校验（分页共用），失败抛 INVALID_PARAM。 */
export function validatePositiveInt(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw askdataError('INVALID_PARAM', `${field} 必须是正整数`)
  }
  return n
}

/** pageSize 解析：默认 100，上限走 config.query.rest.maxPageSize（AGP 要求 <1000）。 */
export function resolvePageSize(value: unknown, ctx: ToolContext): number {
  const requested = value === undefined || value === null || value === '' ? 100 : validatePositiveInt(value, 'page_size')
  return Math.min(requested, ctx.config.query.rest.maxPageSize)
}

/** 分段定义入参解析：[{where_str, title}] → [{whereStr, title}]。 */
export function parseSegments(value: unknown): Array<{ whereStr: string; title: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw askdataError('INVALID_PARAM', 'segment 必填且不能为空数组（每段含 where_str 与 title）')
  }
  return value.map((item, i) => {
    const seg = item as { where_str?: unknown; title?: unknown }
    const whereStr = String(seg?.where_str ?? '').trim()
    if (whereStr === '') throw askdataError('INVALID_PARAM', `segment[${i}].where_str 必填`)
    const title = String(seg?.title ?? '').trim() || `段${i + 1}`
    return { whereStr, title }
  })
}

/** meta 面共用 POST 通道：三头 + JSON body + 超时/取消合并 + GBK 回退解码。 */
export async function agpPost(ctx: ToolContext, metaBase: string, path: string, body: unknown): Promise<string> {
  const cred = resolveAgpCredentials(ctx.config.query.rest, ctx.config.appId)
  const impl = ctx.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(ctx.config.system.queryTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  let res: Response
  try {
    res = await impl(`${metaBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'WT-APPID': cred.appId,
        'WT-OPENID': cred.openid,
        'WT-TOKEN': cred.token,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw askdataError('BACKEND_DOWN', `AGP meta 接口返回 HTTP ${res.status}`)
  } catch (err) {
    if (err instanceof AskdataError) throw err
    const reason = (err as { cause?: { code?: string }; message?: string })?.cause?.code
      ?? (err instanceof Error ? err.message : String(err))
    throw askdataError('BACKEND_DOWN', `AGP meta 接口调用失败: ${String(reason).slice(0, 200)}`)
  }
  return decodeAgpBody(await res.arrayBuffer())
}
