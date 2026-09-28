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
  /**
   * 完整性覆盖：仅在退化形态（notice 行）显式给出 `false`——那里 data 不是
   * 真实数据行，若交给 `rowCount >= total` 推算会碰巧得到同样的 false，
   * 但那是巧合而非声明（notice 行数 1 与 total 无关）。
   */
  complete?: boolean
}

/**
 * 信封 → fields/data/page。fields 取自响应 field 数组（title 缺省用 name）；
 * field 数组为空时从首行键名推导 string 列；data 行仅保留 field 定义内的列并
 * 按类型转换（行中多余键丢弃，缺失键补空串）。
 *
 * 退化形态：field 为空且首行取不出列（首行不是普通对象 / 是空对象）时，推导不出
 * 任何列——此时不再回吐一串 `{}` 空行（rowCount>0 但模型看不到任何值），而是给出
 * 一条显式说明行，让模型据实转告而不是把空行当成"有 N 行数据"。
 */
export function describeEnvelope(env: AgpEnvelope): DescribedEnvelope {
  const colDefs = env.field.length > 0
    ? env.field
    : isPlainRow(env.rows[0])
      ? Object.keys(env.rows[0]).map((name) => ({ name, title: name, type: '3' }))
      : []
  const fields: ResultField[] = colDefs.map((f) => ({
    name: String(f.name),
    title: String(f.title || f.name),
    type: resultFieldType(String(f.type ?? '3')),
  }))
  const page = env.page
  if (fields.length === 0 && env.rows.length > 0) {
    return {
      fields: [{ name: 'notice', title: '说明', type: 'string' }],
      data: [{
        notice:
          `接口返回了 ${env.rows.length} 行数据但没有列定义（field 为空且首行不是对象），无法还原任何属性——`
          + '这通常是接口契约变更或服务端异常。请如实说明，不要编造属性或数据。',
      }],
      ...(page !== undefined ? { page } : {}),
      complete: false,
    }
  }
  const data = env.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (const f of fields) {
      obj[f.name] = f.type === 'number' ? toNumber(row[f.name] as string | null | undefined) : (row[f.name] ?? '')
    }
    return obj
  })
  const out: DescribedEnvelope = { fields, data }
  if (page) out.page = page
  return out
}

/** 首行是否为可取键的普通对象（string/number/array 的 Object.keys 会产出无意义列）。 */
function isPlainRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 正整数入参校验（分页共用），失败抛 INVALID_PARAM。 */
export function validatePositiveInt(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw askdataError('INVALID_PARAM', `${field} 必须是正整数`)
  }
  return n
}

/** pageSize 解析：缺省走 config.query.meta.defaultPageSize，上限走 config.query.rest.maxPageSize（AGP 要求 <1000）。 */
export function resolvePageSize(value: unknown, ctx: ToolContext): number {
  const requested = value === undefined || value === null || value === ''
    ? ctx.config.query.meta.defaultPageSize
    : validatePositiveInt(value, 'page_size')
  return Math.min(requested, ctx.config.query.rest.maxPageSize)
}

/**
 * meta 查询片段护栏（防呆层，非 SQL 解析器）：`searchStr`/`whereStr`/
 * `orderByStr`/`groupByStr` 是 LLM 自由文本，由 AGP 服务端拼成 SQL 执行。
 *
 * 三道检查（2026-09-27 重写，修正评审 M-1 误杀与 M-2 空白绕过）：
 * 1. 引号内字面量剥离——引号内的 `;`/`#`/`--` 是合法数据值（备注='a;b'、
 *    名称='1#机组'），只有字面量外的断句/注释符才拒绝；
 * 2. 空白折叠——`\t\r\n` 折叠为空格，防 `union\tselect` 绕过带空格关键字；
 * 3. 断句/注释符 + DML/DDL/危险关键字按词边界匹配——`exec` 不再误杀
 *    `execute_flag`/`node_exec`，`update ` 系带尾空格的旧写法一并废除。
 *
 * 诚实边界：引号逃逸注入（`id' or '1'='1`）在 denylist 框架内结构性无解
 * （`or` 是合法 SQL 连接词），本护栏是防呆层而非解析器；纵深依赖 AGP 按
 * 项目隔离与只读账号。空串合法（接口要求"参数全传，值可空"）。
 */
const META_FRAGMENT_MAX = 1024

/** 字面量外的断句/注释/井号（引号内的属合法数据值）。 */
const META_PUNCTUATION = [';', '--', '/*', '*/', '#'] as const
/** 危险关键字（词边界匹配，大小写不敏感）。 */
const META_KEYWORD_RE =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|exec|union|sleep|benchmark|load_file|outfile|information_schema)\b/i

/** 剥离 '…' / "…" 字面量（含引号），处理 \' \\ 转义；未闭合引号原样返回。 */
function stripQuotedLiterals(text: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (const ch of text) {
    if (escaped) { escaped = false; continue }
    if ((inSingle || inDouble) && ch === '\\') { escaped = true; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (!inSingle && !inDouble) out += ch
  }
  return out
}

/** 校验一个 meta 查询片段；空串原样返回（接口的"可空"约定）。 */
export function validateMetaFragment(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text.length > META_FRAGMENT_MAX) {
    throw askdataError('INVALID_PARAM', `${field} 长度超过 ${META_FRAGMENT_MAX}`)
  }
  const stripped = stripQuotedLiterals(text).replace(/[\t\r\n\f\v]+/g, ' ').toLowerCase()
  for (const feature of META_PUNCTUATION) {
    if (stripped.includes(feature)) {
      throw askdataError('INVALID_PARAM', `${field} 含有禁用片段 "${feature}"（若为数据值请放入引号内）`)
    }
  }
  if (META_KEYWORD_RE.test(stripped)) {
    throw askdataError('INVALID_PARAM', `${field} 含有禁用关键字（DML/DDL/危险函数）——只允许属性名与比较表达式`)
  }
  return text
}

/** 分段定义入参解析：[{where_str, title}] → [{whereStr, title}]。 */
export function parseSegments(value: unknown): Array<{ whereStr: string; title: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw askdataError('INVALID_PARAM', 'segment 必填且不能为空数组（每段含 where_str 与 title）')
  }
  return value.map((item, i) => {
    const seg = item as { where_str?: unknown; title?: unknown }
    const whereStr = validateMetaFragment(seg?.where_str, `segment[${i}].where_str`)
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
