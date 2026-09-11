/**
 * `model_tags`（20260911 新增, metadata）：查询模型的所有测点列表 + 实时值
 * （getModelTagsByName，接口文档 §3.5）。
 *
 * ⚠ 网关实测：成功响应的行数据键为 `date`（应为 data，服务端拼写问题），
 * describe 同时兼容两键；模型未在数据采集场景绑定测点时返回空列表。
 * @module
 */

import { runApiTool, validatePositiveInt, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { describeQueryResult, type DescribedData } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** model_tags 工具定义。 */
export const modelTagsTool: AskdataApiTool = {
  name: 'model_tags',
  description:
    '查询某个模型关联的所有测点列表（含测点实时值）。model_name 从 list_models 获取；测点需在数据采集场景绑定后才有数据。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: { type: 'string', description: '模型名称（从 list_models 获取）' },
      page_num: { type: 'integer', description: '页码，默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 100，最大 1000' },
    },
    required: ['model_name'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(modelTagsTool, args, ctx, async () => {
      const modelName = String(args.model_name ?? '').trim()
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填')
      const pageSize = Math.min(
        validatePositiveInt(args.page_size ?? 100, 'page_size'),
        ctx.config.api.maxPageSize,
      )
      const pageNum = validatePositiveInt(args.page_num ?? 1, 'page_num')
      return {
        request: {
          path: '/wz/iot-etl/iot/getModelTagsByName',
          params: { modelName, pageNum, pageSize },
        },
        describe: describeModelTags,
      }
    })
  },
}

/** 模型测点响应解释：服务端行键为 `date`（拼写问题），data 兼容。 */
export function describeModelTags(raw: unknown): DescribedData {
  const wrapped = raw as { date?: unknown; data?: unknown } | undefined
  const payload = wrapped && Array.isArray(wrapped.date) ? { ...wrapped, data: wrapped.date } : raw
  return describeQueryResult(payload)
}
