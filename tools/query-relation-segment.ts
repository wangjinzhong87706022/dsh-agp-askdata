/**
 * `query_relation_segment`（meta 数据查询，docs/architecture.md §20.4）：
 * 关系分段聚合统计——`POST {metaBase}/postRelationAggrigateData`（PDF §2.8，
 * §2.7 的关系版）。与 query_model_segment 的差异：作用在模型关系上，需
 * relationName，可选指定左右模型的继承模型（left/rightModelName）。
 * 语义自事故丢失的 tools-api/query-relation-segment.ts 移植（§18.x 实证）。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { metaBaseUrl, parseAgpEnvelope } from './model-relation-graph.ts'
import { agpPost, describeEnvelope, parseSegments, resolvePageSize } from './meta-common.ts'

/** query_relation_segment 工具定义。 */
export const queryRelationSegmentTool: AskdataTool = {
  name: 'query_relation_segment',
  description:
    '查询关系数据的分段聚合统计（每段独立按条件计算聚合值，输出一张表）。'
    + '需先知道关系名称（如"设备参数列表"、"组织和用户的关系"，可从 '
    + 'model_relation_graph 的关系清单取），可选指定左右模型的继承模型。'
    + 'search_str 常用 "属性,count(*) as 计数"；关系可用属性先用 '
    + 'relation_field_list 查。数据来自 AGP 数据底座 meta 接口，只读。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      relation_name: { type: 'string', description: '关系名称（如 设备参数列表）' },
      search_str: { type: 'string', description: '聚合定义，如 "name,count(*) as 计数"' },
      segment: {
        type: 'array',
        description: '分段定义列表（每段独立计算）',
        items: {
          type: 'object',
          properties: {
            where_str: { type: 'string', description: '该段查询条件' },
            title: { type: 'string', description: '段名' },
          },
          required: ['where_str'],
        },
      },
      left_model_name: { type: 'string', description: '左模型继承模型名（可选，缺省用关系定义）' },
      right_model_name: { type: 'string', description: '右模型继承模型名（可选，缺省用关系定义）' },
      group_by_str: { type: 'string', description: '分组定义（可选）' },
      order_by_str: { type: 'string', description: '排序定义（可选）' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
    },
    required: ['relation_name', 'search_str', 'segment'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      const relationName = typeof args.relation_name === 'string' ? args.relation_name.trim() : ''
      const searchStr = typeof args.search_str === 'string' ? args.search_str.trim() : ''
      if (relationName === '') throw askdataError('INVALID_PARAM', 'relation_name 必填（关系名称）')
      if (searchStr === '') throw askdataError('INVALID_PARAM', 'search_str 必填（如 "name,count(*) as 计数"）')
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），关系分段聚合不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)

      const body = {
        relationName,
        searchStr,
        whereStr: '',
        orderByStr: typeof args.order_by_str === 'string' ? args.order_by_str.trim() : '',
        groupByStr: typeof args.group_by_str === 'string' ? args.group_by_str.trim() : '',
        pageNum: 1,
        pageSize: resolvePageSize(args.page_size, ctx),
        leftModelName: typeof args.left_model_name === 'string' ? args.left_model_name.trim() : '',
        rightModelName: typeof args.right_model_name === 'string' ? args.right_model_name.trim() : '',
        segment: parseSegments(args.segment),
      }
      urlLog.push(`${metaBase}/postRelationAggrigateData (relationName=${relationName})`)
      const env = parseAgpEnvelope(await agpPost(ctx, metaBase, '/postRelationAggrigateData', body))
      const described = describeEnvelope(env)

      const apiOrSql = `POST ${metaBase}/postRelationAggrigateData (relationName=${relationName}, ${body.segment.length} 段) → ${described.data.length} 行`
      const itemTotal = described.page !== undefined ? described.page.itemTotal : undefined
      const result = ok(queryRelationSegmentTool.name, {
        apiOrSql,
        params: args,
        fields: described.fields,
        data: described.data,
        page: described.page,
        executionMs: Date.now() - started,
        ...(itemTotal !== undefined
          ? { total: itemTotal, complete: described.data.length >= itemTotal }
          : {}),
      })
      applyAudit(queryRelationSegmentTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `关系分段聚合查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(queryRelationSegmentTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(queryRelationSegmentTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}
