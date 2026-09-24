/**
 * `query_model`（meta 数据查询，docs/architecture.md §20.4）：
 * 查询模型业务数据——AGP 数据底座 meta 接口 `POST {metaBase}/postModelDataMeta`
 * （PDF §2.2，参数全传语义自 §18.x 实证移植）。
 *
 * 线上实证（2026-09-24 + §18.5）：
 *   - searchStr 用显式属性名（中文或英文均可，逗号分隔）；**不要用 `*`**——
 *     服务端会按模型逻辑属性展开，可能包含物理表不存在的列而报
 *     "Unknown column" 错。查可用字段先用 model_field_list。
 *   - 属性名兼容中文（如 参数值）；条件/排序/分组同为 MySQL 语法 + 属性名直用。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { metaBaseUrl, parseAgpEnvelope } from './model-relation-graph.ts'
import { agpPost, describeEnvelope, resolvePageSize, validatePositiveInt } from './meta-common.ts'

/** query_model 工具定义。 */
export const queryModelTool: AskdataTool = {
  name: 'query_model',
  description:
    '查询一个模型的业务数据（模型实例行，如"设备参数列模型里有哪些参数记录"）。'
    + '输入中文模型名 + 显式属性名列表（先用 model_field_list 查该模型可用字段，'
    + '不要传 *，服务端展开 * 会报 Unknown column）。支持中文属性名、where 条件、'
    + '排序、分组、分页；返回 total 为全量行数。用法约定：total 超过一页时不要逐页翻，'
    + '优先收窄 where_str（按属性过滤）或改用 query_model_segment 聚合统计。'
    + '数据来自 AGP 数据底座 meta 接口（postModelDataMeta），只读。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '中文模型名称（如 设备参数列模型、水泵模型）',
      },
      search_str: {
        type: 'string',
        description: '查询字段，显式属性名逗号分隔（如 "id,code,name,canshuzhi"；中文属性名可直接用）。不要传 *',
      },
      where_str: { type: 'string', description: '查询条件（如 "参数值 > 10"），可空串' },
      page_num: { type: 'integer', description: '页码，默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
      order_by_str: { type: 'string', description: '排序定义（如 "参数值 DESC"），可空串' },
      group_by_str: { type: 'string', description: '分组定义，可空串' },
    },
    required: ['model_name', 'search_str'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      const modelName = typeof args.model_name === 'string' ? args.model_name.trim() : ''
      const searchStr = typeof args.search_str === 'string' ? args.search_str.trim() : ''
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填（中文模型名）')
      if (searchStr === '') throw askdataError('INVALID_PARAM', 'search_str 必填（显式属性名，先用 model_field_list 查可用字段；不要传 *）')
      if (searchStr.trim() === '*') {
        throw askdataError('INVALID_PARAM', 'search_str 不支持 *（服务端展开会含物理表不存在的列）；请用 model_field_list 查字段后显式列出')
      }
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），模型数据查询不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)
      const pageNum = args.page_num === undefined || args.page_num === null || args.page_num === ''
        ? 1
        : validatePositiveInt(args.page_num, 'page_num')
      const pageSize = resolvePageSize(args.page_size, ctx)

      const body = {
        modelName,
        searchStr,
        whereStr: typeof args.where_str === 'string' ? args.where_str.trim() : '',
        pageNum,
        pageSize,
        orderByStr: typeof args.order_by_str === 'string' ? args.order_by_str.trim() : '',
        groupByStr: typeof args.group_by_str === 'string' ? args.group_by_str.trim() : '',
      }
      urlLog.push(`${metaBase}/postModelDataMeta (modelName=${modelName})`)
      const env = parseAgpEnvelope(await agpPost(ctx, metaBase, '/postModelDataMeta', body))
      const described = describeEnvelope(env)

      const apiOrSql = `POST ${metaBase}/postModelDataMeta (modelName=${modelName}, searchStr=${searchStr}) → ${described.data.length} 行`
      const itemTotal = described.page !== undefined ? described.page.itemTotal : undefined
      const result = ok(queryModelTool.name, {
        apiOrSql,
        params: args,
        fields: described.fields,
        data: described.data,
        page: described.page,
        executionMs: Date.now() - started,
        // 完整性契约：total（分页 itemTotal）顶层透出；单页即全量时 complete=true。
        ...(itemTotal !== undefined
          ? { total: itemTotal, complete: described.data.length >= itemTotal }
          : {}),
      })
      applyAudit(queryModelTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `模型数据查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(queryModelTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(queryModelTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}
