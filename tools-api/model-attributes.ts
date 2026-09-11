/**
 * `model_attributes`（P0, metadata）：查询模型属性（getModelBasAttributes）。
 * @module
 */

import { runApiTool, toString, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** model_attributes 工具定义。 */
export const modelAttributesTool: AskdataApiTool = {
  name: 'model_attributes',
  description:
    '查询某个模型的可用属性列表。用户问"模型有哪些字段"或"能查什么属性"时调用。model_name 从 list_models 获取。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '模型英文名（从 list_models 获取）',
      },
    },
    required: ['model_name'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(modelAttributesTool, args, ctx, async () => {
      const modelName = String(args.model_name ?? '').trim()
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填')
      return {
        request: {
          path: '/wz/meta/getModelBasAttributes',
          params: { modelName },
        },
        describe: (raw) => {
          // 实测形态为 QueryResult：field=列定义，data=属性行（2026-09-11 修正）
          const qr = raw as { data?: Record<string, unknown>[]; field?: Record<string, unknown>[] }
          const rows = Array.isArray(qr?.data)
            ? qr.data
            : Array.isArray(raw)
              ? (raw as Record<string, unknown>[])
              : (qr?.field ?? [])
          return {
            fields: [
              { name: 'field_name', title: '字段名', type: 'string' },
              { name: 'field_description', title: '字段描述', type: 'string' },
              { name: 'field_type', title: '字段类型', type: 'string' },
            ],
            data: rows.map((r) => ({
              field_name: toString(r.field_name),
              field_description: toString(r.field_description),
              field_type: toString(r.field_type),
            })),
          }
        },
      }
    })
  },
}
