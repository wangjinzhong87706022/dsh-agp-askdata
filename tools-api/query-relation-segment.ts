/**
 * `query_relation_segment`（20260910 新增, metadata）：关系分段聚合统计
 * （postRelationAggrigateData，接口文档 §2.7 关系版）。
 *
 * 与 query_model_segment 的差异：作用在模型关系上，需 relationName，
 * 可选指定左右模型的继承模型（leftModelName/rightModelName）。
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

/** query_relation_segment 工具定义。 */
export const queryRelationSegmentTool: AskdataApiTool = {
  name: 'query_relation_segment',
  description:
    '查询关系数据的分段聚合统计（每段独立按条件计算聚合值，输出一张表）。需先知道关系名称（如"组织和用户的关系"），可用 search_str 如 "组织名称,count(*) as 计数"。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      relation_name: { type: 'string', description: '关系名称，如 "组织和用户的关系"' },
      search_str: { type: 'string', description: '聚合定义，如 "组织名称,count(*) as 计数"' },
      segment: {
        type: 'array',
        description: '分段定义列表',
        items: {
          type: 'object',
          properties: {
            where_str: { type: 'string', description: '该段查询条件' },
            title: { type: 'string', description: '段名' },
          },
          required: ['where_str'],
        },
      },
      left_model_name: { type: 'string', description: '左模型的继承模型名称（可选）' },
      right_model_name: { type: 'string', description: '右模型的继承模型名称（可选）' },
      group_by_str: { type: 'string', description: '分组定义（可选）' },
      order_by_str: { type: 'string', description: '排序定义（可选）' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
    },
    required: ['relation_name', 'search_str', 'segment'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(queryRelationSegmentTool, args, ctx, async () => {
      const relationName = String(args.relation_name ?? '').trim()
      if (relationName === '') throw askdataError('INVALID_PARAM', 'relation_name 必填')
      const searchStr = String(args.search_str ?? '').trim()
      if (searchStr === '') throw askdataError('INVALID_PARAM', 'search_str 必填')
      const pageSize = Math.min(
        validatePositiveInt(args.page_size ?? 100, 'page_size'),
        ctx.config.api.maxPageSize,
      )
      return {
        request: {
          path: '/wz/meta/postRelationAggrigateData',
          method: 'POST',
          params: {
            relationName,
            searchStr,
            orderByStr: args.order_by_str ? toString(args.order_by_str) ?? '' : '',
            groupByStr: args.group_by_str ? toString(args.group_by_str) ?? '' : '',
            leftModelName: args.left_model_name ? toString(args.left_model_name) ?? '' : '',
            rightModelName: args.right_model_name ? toString(args.right_model_name) ?? '' : '',
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
