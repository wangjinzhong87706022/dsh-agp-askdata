/**
 * `query_model_segment`（20260910 新增, metadata）：模型分段聚合统计
 * （postModelAggrigateData，接口文档 §2.7）。
 *
 * segment 每段独立按 whereStr 过滤后计算 searchStr 聚合（如 count(*) as 计数），
 * 结果按一个表格输出——适合"按区间分段统计"类问题（如按温度区间分组计数）。
 * @module
 */

import { describeQueryResult, runApiTool, toString, validatePositiveInt, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** 分段定义入参解析：[{where_str, title}] → [{whereStr, title}]。 */
function parseSegments(value: unknown): Array<{ whereStr: string; title: string }> {
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

/** query_model_segment 工具定义。 */
export const queryModelSegmentTool: AskdataApiTool = {
  name: 'query_model_segment',
  description:
    '查询模型数据的分段聚合统计（每段独立按条件计算聚合值，输出一张表）。适合按区间分段统计，如"按温度区间统计数量"。search_str 常用 "属性,count(*) as 计数"。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: { type: 'string', description: '模型名称（从 list_models 获取）' },
      search_str: { type: 'string', description: '聚合定义，如 "姓名,count(*) as 计数"' },
      segment: {
        type: 'array',
        description: '分段定义列表',
        items: {
          type: 'object',
          properties: {
            where_str: { type: 'string', description: '该段查询条件，如 "年龄 > 20 and 年龄 < 40"' },
            title: { type: 'string', description: '段名，如 "大于20小于40岁"' },
          },
          required: ['where_str'],
        },
      },
      group_by_str: { type: 'string', description: '分组定义（可选）' },
      order_by_str: { type: 'string', description: '排序定义（可选）' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
    },
    required: ['model_name', 'search_str', 'segment'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(queryModelSegmentTool, args, ctx, async () => {
      const modelName = String(args.model_name ?? '').trim()
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填')
      const searchStr = String(args.search_str ?? '').trim()
      if (searchStr === '') throw askdataError('INVALID_PARAM', 'search_str 必填')
      const pageSize = Math.min(
        validatePositiveInt(args.page_size ?? 100, 'page_size'),
        ctx.config.api.maxPageSize,
      )
      return {
        request: {
          path: '/wz/meta/postModelAggrigateData',
          method: 'POST',
          params: {
            modelName,
            searchStr,
            orderByStr: args.order_by_str ? toString(args.order_by_str) ?? '' : '',
            groupByStr: args.group_by_str ? toString(args.group_by_str) ?? '' : '',
            pageNum: 1,
            pageSize,
            segment: parseSegments(args.segment),
          },
        },
        describe: describeQueryResult,
      }
    })
  },
}
