/**
 * `query_model`（P0, metadata）：查询模型数据（postModelDataMeta）。
 * @module
 */

import { describeQueryResult, runApiTool, validatePositiveInt, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** query_model 工具定义。 */
export const queryModelTool: AskdataApiTool = {
  name: 'query_model',
  description:
    '查询模型数据。支持中文属性名。search_str 为查询字段（如 *），where_str 为条件（如 年龄>30）。model_name 必须用中文模型别名（list_models 返回的 class_alias，如 "水库基础模型"），用英文名 class_name 会报"模型不存在"。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '中文模型别名（list_models 的 class_alias，如 "水库基础模型"、"模拟量模型"）；不要用英文名 class_name',
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

      const pageSize = Math.min(
        validatePositiveInt(args.page_size ?? 100, 'page_size'),
        ctx.config.api.maxPageSize,
      )
      const pageNum = validatePositiveInt(args.page_num ?? 1, 'page_num')

      return {
        request: {
          path: '/wz/meta/postModelDataMeta',
          method: 'POST',
          params: {
            modelName,
            searchStr,
            whereStr: args.where_str ? String(args.where_str) : '',
            pageNum,
            pageSize,
            orderByStr: args.order_by_str ? String(args.order_by_str) : '',
            groupByStr: args.group_by_str ? String(args.group_by_str) : '',
          },
        },
        describe: describeQueryResult,
      }
    })
  },
}
