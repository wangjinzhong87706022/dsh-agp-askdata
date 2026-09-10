/**
 * `query_model`（P0, metadata）：查询模型数据（postModelDataMeta）。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** query_model 工具定义。 */
export const queryModelTool: AskdataApiTool = {
  name: 'query_model',
  description:
    '查询模型数据。支持中文属性名。search_str 为查询字段（如 *），where_str 为条件（如 年龄>30）。model_name 从 list_models 获取。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '模型英文名（从 list_models 获取）',
      },
      search_str: {
        type: 'string',
        description: '查询字段，如 "*" 或 "姓名,年龄"',
      },
      where_str: {
        type: 'string',
        description: '查询条件，如 "年龄 > 30"',
      },
      page_num: {
        type: 'integer',
        description: '页码，默认 1',
      },
      page_size: {
        type: 'integer',
        description: '每页条数，默认 100，最大 1000',
      },
      order_by_str: {
        type: 'string',
        description: '排序字段，如 "年龄 DESC"',
      },
      group_by_str: {
        type: 'string',
        description: '分组字段',
      },
    },
    required: ['model_name'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(queryModelTool, args, ctx, async () => {
      const modelName = String(args.model_name ?? '').trim()
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填')
      const searchStr = String(args.search_str ?? '').trim()

      const pageSize = Math.min(Number(args.page_size ?? 100), ctx.config.api.maxPageSize)
      const pageNum = Number(args.page_num ?? 1)

      const result = await ctx.apiClient.queryModelData({
        modelName,
        searchStr,
        whereStr: args.where_str ? String(args.where_str) : undefined,
        pageNum,
        pageSize,
        orderByStr: args.order_by_str ? String(args.order_by_str) : undefined,
        groupByStr: args.group_by_str ? String(args.group_by_str) : undefined,
      })

      // 动态构建 fields：从 API 返回的 field 数组
      const fields = result.field.map((f) => ({
        name: f.name,
        title: f.title || f.name,
        type: (f.type === '1' || f.type === '11' || f.type === '22' ? 'number' : 'string') as 'string' | 'number' | 'datetime' | 'boolean',
      }))

      return {
        path: '/wz/meta/postModelDataMeta',
        params: { modelName, searchStr, pageSize, pageNum },
        fields,
        shape: (rows) =>
          rows.map((r) => {
            const obj: Record<string, unknown> = {}
            for (const f of result.field) {
              const val = r[f.name]
              if (f.type === '1' || f.type === '11' || f.type === '22') {
                obj[f.name] = toNumber(val as string | null)
              } else {
                obj[f.name] = toString(val)
              }
            }
            return obj
          }),
      }
    })
  },
}