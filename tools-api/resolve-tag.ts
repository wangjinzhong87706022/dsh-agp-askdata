/**
 * `resolve_tag`（P0, metadata）：用中文关键字反查 tagName。
 * @module
 */

import { describeQueryResult, runApiTool, toString, validatePositiveInt, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** resolve_tag 工具定义。 */
export const resolveTagTool: AskdataApiTool = {
  name: 'resolve_tag',
  description:
    '用中文关键字反查 tagName。如 keyword="水位" 返回所有含"水位"的测点。不确定 tagName 时先调用本工具。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '中文关键字，如 "水位"',
      },
      limit: {
        type: 'integer',
        description: '返回条数上限，默认 100',
      },
    },
    required: ['keyword'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(resolveTagTool, args, ctx, async () => {
      const keyword = String(args.keyword ?? '').trim()
      if (keyword === '') throw askdataError('INVALID_PARAM', 'keyword 必填')
      // keyword 拼进 whereStr 的 LIKE 字面量；单引号会破坏条件语法，入参期直接拒绝
      if (keyword.includes("'")) {
        throw askdataError('INVALID_PARAM', 'keyword 不能包含单引号')
      }
      const pageSize = Math.min(
        validatePositiveInt(args.limit ?? ctx.config.system.defaultLookupLimit, 'limit'),
        ctx.config.api.maxPageSize,
      )

      return {
        request: {
          path: '/wz/meta/postModelDataMeta',
          method: 'POST',
          params: {
            modelName: 'wt_iot_tags',
            searchStr: '*',
            whereStr: `tagname LIKE '%${keyword}%' OR alias LIKE '%${keyword}%'`,
            pageNum: 1,
            pageSize,
            orderByStr: '',
            groupByStr: '',
          },
        },
        describe: (raw) => {
          const described = describeQueryResult(raw)
          return {
            fields: [
              { name: 'tagName', title: '测点名', type: 'string' },
              { name: 'alias', title: '中文别名', type: 'string' },
              { name: 'description', title: '描述', type: 'string' },
            ],
            data: described.data.map((r) => ({
              tagName: toString(r.tagname ?? r.tagName),
              alias: toString(r.alias),
              description: toString(r.description),
            })),
          }
        },
      }
    })
  },
}
