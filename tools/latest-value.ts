/**
 * `latest_value`（P0, metadata）：取一批 tag 的最新实时值（§3.1）。
 *
 * P0 仅实现 StarRocks max_by 兜底路；TSDB HTTP RTDQuery 主路在 P1 接入。
 * @module
 */

import { askdataError } from '../src/errors.ts'
import { latestValueSql, tagExistenceSql } from '../src/sql/templates.ts'
import { validateTagNames } from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'

/** latest_value 工具定义。 */
export const latestValueTool: AskdataTool = {
  name: 'latest_value',
  description:
    '取一个或多个 tag 的最新实时值（兜底走 StarRocks max_by）。输入 tagName 数组；不确定 tagName 时先调用 lookup_tag。',
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
        params: { tag_names: tagNames },
        fields: [
          { name: 'tagName', title: '测点全名', type: 'string' },
          { name: 'latestValue', title: '最新值', type: 'number' },
          { name: 'latestTime', title: '最新时间', type: 'datetime' },
        ],
        shape: (rows) => {
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
    })
  },
}
