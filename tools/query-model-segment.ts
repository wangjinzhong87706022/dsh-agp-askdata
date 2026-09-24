/**
 * `query_model_segment`（meta 数据查询，docs/architecture.md §20.4）：
 * 模型分段聚合统计——`POST {metaBase}/postModelAggrigateData`（PDF §2.7）。
 * segment 每段独立按 whereStr 过滤后计算 searchStr 聚合，结果输出一张表。
 * 语义自事故丢失的 tools-api/query-model-segment.ts 移植（§18.x 实证）。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { metaBaseUrl, parseAgpEnvelope } from './model-relation-graph.ts'
import { agpPost, describeEnvelope, parseSegments, resolvePageSize } from './meta-common.ts'

/** query_model_segment 工具定义。 */
export const queryModelSegmentTool: AskdataTool = {
  name: 'query_model_segment',
  description:
    '查询模型数据的分段聚合统计（每段独立按条件计算聚合值，输出一张表）。'
    + '适合"按区间/分类分段统计"类问题（如按参数类型分组计数）。'
    + 'search_str 常用 "属性,count(*) as 计数"；属性名先用 model_field_list 查。'
    + '数据来自 AGP 数据底座 meta 接口（postModelAggrigateData），只读。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: { type: 'string', description: '中文模型名称（如 设备参数列模型）' },
      search_str: { type: 'string', description: '聚合定义，如 "name,count(*) as 计数"（属性名可用中文）' },
      segment: {
        type: 'array',
        description: '分段定义列表（每段独立计算）',
        items: {
          type: 'object',
          properties: {
            where_str: { type: 'string', description: '该段查询条件，如 "tree_level > 0"' },
            title: { type: 'string', description: '段名，如 "有层级"' },
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
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      const modelName = typeof args.model_name === 'string' ? args.model_name.trim() : ''
      const searchStr = typeof args.search_str === 'string' ? args.search_str.trim() : ''
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填（中文模型名）')
      if (searchStr === '') throw askdataError('INVALID_PARAM', 'search_str 必填（如 "name,count(*) as 计数"）')
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），分段聚合不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)

      const body = {
        modelName,
        searchStr,
        orderByStr: typeof args.order_by_str === 'string' ? args.order_by_str.trim() : '',
        groupByStr: typeof args.group_by_str === 'string' ? args.group_by_str.trim() : '',
        pageNum: 1,
        pageSize: resolvePageSize(args.page_size, ctx),
        segment: parseSegments(args.segment),
      }
      urlLog.push(`${metaBase}/postModelAggrigateData (modelName=${modelName})`)
      const env = parseAgpEnvelope(await agpPost(ctx, metaBase, '/postModelAggrigateData', body))
      const described = describeEnvelope(env)

      const apiOrSql = `POST ${metaBase}/postModelAggrigateData (modelName=${modelName}, ${body.segment.length} 段) → ${described.data.length} 行`
      const itemTotal = described.page !== undefined ? described.page.itemTotal : undefined
      const result = ok(queryModelSegmentTool.name, {
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
      applyAudit(queryModelSegmentTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `分段聚合查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(queryModelSegmentTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(queryModelSegmentTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}
