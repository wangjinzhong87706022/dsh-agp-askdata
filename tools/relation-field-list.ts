/**
 * `relation_field_list`（meta 数据查询，docs/architecture.md §20.4）：
 * 查询一个模型关系的基本属性（关系字段构成）——
 * `GET {metaBase}/getRelationBasAttributes?relationName=<中文关系名>`（PDF §2.6）。
 * 与 model_field_list（模型字段）互为兄弟；返回列含所属模型（model_name）。
 * 语义自事故丢失的 tools-api 面 + 2026-09-24 真实网关实测移植。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok, type ResultField } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { agpGet, metaBaseUrl, parseAgpEnvelope } from './model-relation-graph.ts'

const FIELDS: ResultField[] = [
  { name: 'rank', title: '序号', type: 'number' },
  { name: 'field_name', title: '属性名称', type: 'string' },
  { name: 'field_description', title: '描述', type: 'string' },
  { name: 'field_type', title: '属性类型码', type: 'string' },
  { name: 'model_name', title: '所属模型', type: 'string' },
]

/** relation_field_list 工具定义。 */
export const relationFieldListTool: AskdataTool = {
  name: 'relation_field_list',
  description:
    '查询一个模型关系的基本属性（关系里可用的字段清单，含所属模型）。'
    + '输入中文关系名称（如 设备参数列表、组织和用户的关系；可从 model_relation_graph '
    + '返回的关系清单取）。要按关系聚合统计用 query_relation_segment。'
    + '数据来自 AGP 数据底座 meta 接口（getRelationBasAttributes），只读。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      relation_name: {
        type: 'string',
        description: '中文关系名称（如 设备参数列表、组织和用户的关系）',
      },
    },
    required: ['relation_name'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const relationName = typeof args.relation_name === 'string' ? args.relation_name.trim() : ''
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      if (relationName === '') throw askdataError('INVALID_PARAM', 'relation_name 必填（中文关系名称）')
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），关系属性接口不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)

      urlLog.push(`${metaBase}/getRelationBasAttributes?relationName=${relationName}`)
      const text = await agpGet(ctx, metaBase, `/getRelationBasAttributes?relationName=${encodeURIComponent(relationName)}`)
      const env = parseAgpEnvelope(text)

      const data: Record<string, unknown>[] = env.rows.map((row, i) => ({
        rank: i + 1,
        field_name: String(row.field_name ?? ''),
        field_description: String(row.field_description ?? ''),
        field_type: String(row.field_type ?? ''),
        model_name: String(row.model_name ?? ''),
      }))
      if (data.length === 0) {
        data.push({
          rank: 0,
          field_name: '',
          field_description: `关系「${relationName}」没有可见的基本属性（返回 0 行）。请直接说明，不要编造字段。`,
          field_type: '',
          model_name: '',
        })
      }

      const apiOrSql = `GET ${metaBase}/getRelationBasAttributes?relationName=${relationName} → ${env.rows.length} 个属性`
      const result = ok(relationFieldListTool.name, {
        apiOrSql,
        params: args,
        fields: FIELDS,
        data,
        executionMs: Date.now() - started,
      })
      applyAudit(relationFieldListTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `关系属性查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(relationFieldListTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(relationFieldListTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}
