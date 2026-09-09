/**
 * `latest_value`（P0, metadata）：取一批 tag 的最新实时值（§3.1）。
 *
 * 通道选择（§14.10 层1，配置 `query.tsdbChannel`）：
 * - `rest`：TSDB HTTP 网关 `iotRealTimeValue`（主路，RTDQuery 形态）；
 *   失败且 `query.rest.fallbackToSql=true` 时自动回落 SQL（兜底路）。
 * - `sql`（默认）：StarRocks `max_by` 兜底路。
 * @module
 */

import { askdataError } from '../src/errors.ts'
import { fetchLatestValuesViaRest } from '../src/clients/tsdb-rest.ts'
import { latestValueSql, tagExistenceSql } from '../src/sql/templates.ts'
import { validateTagNames } from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'

/** latest_value 工具定义。 */
export const latestValueTool: AskdataTool = {
  name: 'latest_value',
  description:
    '取一个或多个 tag 的最新实时值。输入 tagName 数组；不确定 tagName 时先调用 lookup_tag。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      tag_names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000 },
    },
    required: ['tag_names'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(latestValueTool, args, ctx, async (): Promise<SqlPlan> => {
      const tagNames = validateTagNames(args.tag_names)
      const { query } = ctx.config

      // REST 主路（iotRealTimeValue）：plan 阶段即发起调用——失败在此处按
      // fallbackToSql 决定回落 SQL 或直接抛出（拖到 execute 阶段就接不住回落了）
      if (query.tsdbChannel === 'rest') {
        const url = restUrl(query.rest.baseUrl, tagNames)
        try {
          const out = await fetchLatestValuesViaRest(query, tagNames, ctx.config.system, { signal: ctx.signal })
          return restPlan(url, tagNames, out.rows)
        } catch (err) {
          if (!query.rest.fallbackToSql) throw err
          ctx.log?.(
            `latest_value REST 通道失败，回落 SQL: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return sqlPlan(ctx, tagNames)
    })
  },
}

const LATEST_FIELDS = [
  { name: 'tagName', title: '测点全名', type: 'string' },
  { name: 'latestValue', title: '最新值', type: 'number' },
  { name: 'latestTime', title: '最新时间', type: 'datetime' },
] as const

/** REST 主路 URL（apiOrSql 契约展示用）。 */
function restUrl(baseUrl: string, tagNames: string[]): string {
  return `${baseUrl.replace(/\/+$/, '')}/iotRealTimeValue?tagNames=${encodeURIComponent(tagNames.join(','))}`
}

/**
 * REST 主路计划：`sql` 字段承载请求 URL（apiOrSql 契约），`transport: 'http'`
 * 免 SQL 白名单闸门，`execute` 返回 plan 阶段已取到的行。未回行的 tag 记入 missingTagNames。
 */
function restPlan(url: string, tagNames: string[], rows: Record<string, string | null>[]): SqlPlan {
  return {
    sql: url,
    transport: 'http',
    params: { tag_names: tagNames, channel: 'rest' },
    fields: [...LATEST_FIELDS],
    execute: async () => ({ columns: ['tagName', 'latestValue', 'latestTime'], rows }),
    shape: (rows): Record<string, unknown>[] => {
      const data: Record<string, unknown>[] = rows.map((r) => ({
        tagName: r.tagName,
        latestValue: toNumber(r.latestValue),
        latestTime: r.latestTime,
      }))
      const found = new Set(rows.map((r) => r.tagName))
      const missing = tagNames.filter((t) => !found.has(t))
      if (missing.length > 0) data.push({ missingTagNames: missing.join(', ') })
      return data
    },
  }
}

/** SQL 兜底路：存在性预检（全缺失 → TAG_NOT_FOUND）+ max_by。 */
async function sqlPlan(ctx: ToolContext, tagNames: string[]): Promise<SqlPlan> {
  const exist = await ctx.executor.execute(tagExistenceSql(ctx.config, tagNames), { signal: ctx.signal })
  const found = new Set(exist.rows.map((r) => r.tagName))
  const missing = tagNames.filter((t) => !found.has(t))
  if (missing.length === tagNames.length) {
    throw askdataError('TAG_NOT_FOUND', `所有 tagName 都不在 WT_TAG 中: ${missing.join(', ')}`)
  }
  const sql = latestValueSql(ctx.config, {
    tagNames: missing.length > 0 ? tagNames.filter((t) => found.has(t)) : tagNames,
    badValueMask: ctx.config.system.badValueMask,
  })
  return {
    sql,
    params: { tag_names: tagNames, channel: 'sql' },
    fields: [...LATEST_FIELDS],
    shape: (rows): Record<string, unknown>[] => {
      const data: Record<string, unknown>[] = rows.map((r) => ({
        tagName: r.tagName,
        latestValue: toNumber(r.latestValue),
        latestTime: r.latestTime,
      }))
      if (missing.length > 0) {
        data.push({ missingTagNames: missing.join(', ') })
      }
      return data
    },
  }
}
