/**
 * `resolve_tag`（P0, metadata）：用中文关键字反查 tagName。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
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
      const limit = args.limit ? Number(args.limit) : ctx.config.system.defaultLookupLimit

      // 查询测点基础模型（wt_iot_tags 或类似），用 whereStr 过滤
      const result = await ctx.apiClient.queryModelData({
        modelName: 'wt_iot_tags', // 测点基础模型
        searchStr: '*',
        whereStr: `tagname LIKE '%${keyword}%' OR alias LIKE '%${keyword}%'`,
        pageNum: 1,
        pageSize: Math.min(limit, ctx.config.api.maxPageSize),
      })

      return {
        path: '/wz/meta/postModelDataMeta',
        params: { keyword, limit },
        fields: [
          { name: 'tagName', title: '测点名', type: 'string' },
          { name: 'alias', title: '中文别名', type: 'string' },
          { name: 'description', title: '描述', type: 'string' },
        ],
        shape: (rows) =>
          rows.map((r) => ({
            tagName: toString(r.tagname ?? r.tagName),
            alias: toString(r.alias),
            description: toString(r.description),
          })),
      }
    })
  },
}