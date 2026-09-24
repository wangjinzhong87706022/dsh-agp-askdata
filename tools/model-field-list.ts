/**
 * `model_field_list`（模型字段构成，docs/architecture.md §20.3）：
 * 查询一个模型的基本属性（字段构成）——AGP 数据底座 meta 接口
 * `GET {metaBase}/getModelBasAttributes?modelName=<中文模型名>`（PDF §2.3）。
 *
 * 与 model_relation_graph 互补：图谱查关系边，本工具查字段构成
 * （2026-09-24 会话实证：模型只有关系图谱工具时，"设备参数列模型的字段
 * 构成"只能去 RAGFlow 撞运气并如实报告查不到）。
 *
 * 线上实证（2026-09-24 openagp.top 10462）：
 *   - modelName 直接收中文模型名（与 getRelationsByModel 不同，无需先解析
 *     class_path）；信封同构：data.field=列定义，data.data=属性行
 *     （field_name/field_description/field_type）。
 *   - 容错：入参含 "/" 视为 class_path 直接透传；中文名查询报「模型不存在」
 *     类错误时，回落 queryByGenericSql 解析 class_path 重试一次。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok, type ResultField } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { agpGet, metaBaseUrl, parseAgpEnvelope, resolveClassPath, type AgpEnvelope } from './model-relation-graph.ts'

const FIELDS: ResultField[] = [
  { name: 'rank', title: '序号', type: 'number' },
  { name: 'field_name', title: '属性名称', type: 'string' },
  { name: 'field_description', title: '描述', type: 'string' },
  { name: 'field_type', title: '属性类型码', type: 'string' },
]

/** 「模型不存在」类业务失败（触发 class_path 回落重试）。 */
function isModelNotFound(message: string): boolean {
  return /没有找到|不存在|未找到|not\s*found/i.test(message)
}

/** model_field_list 工具定义。 */
export const modelFieldListTool: AskdataTool = {
  name: 'model_field_list',
  previewLimit: 300,
  description:
    '查询一个模型的基本属性（字段构成）：返回该模型的全部可用属性名、描述与类型码。'
    + '输入中文模型名（如 设备参数列模型、水泵模型、水库模型；也接受 class_path 形态）。'
    + '数据来自 AGP 数据底座 meta 接口（getModelBasAttributes），只读。'
    + '查模型之间的关系链用 model_relation_graph，查模型的字段构成用本工具。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      model_name: {
        type: 'string',
        description: '中文模型名称（如 设备参数列模型、水泵模型）；也接受 class_path（含 / 的形态）',
      },
    },
    required: ['model_name'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    const modelName = typeof args.model_name === 'string' ? args.model_name.trim() : ''
    const urlLog: string[] = []
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      if (modelName === '') throw askdataError('INVALID_PARAM', 'model_name 必填（中文模型名或 class_path）')
      if (!ctx.config.query.rest.baseUrl) {
        throw askdataError('BACKEND_DOWN', 'AGP API 未配置（query.rest.baseUrl），模型字段接口不可用')
      }
      const metaBase = metaBaseUrl(ctx.config.query.rest.baseUrl)

      // 主路：中文名直接查（§2.3 契约，2026-09-24 真实网关实测）。
      // 回落：报「模型不存在」类错误且入参非 class_path 时，解析 class_path 重试一次。
      let env: AgpEnvelope
      urlLog.push(`${metaBase}/getModelBasAttributes?modelName=${modelName}`)
      try {
        const text = await agpGet(ctx, metaBase, `/getModelBasAttributes?modelName=${encodeURIComponent(modelName)}`)
        env = parseAgpEnvelope(text)
      } catch (err) {
        const message = err instanceof AskdataError ? err.message : String(err)
        if (modelName.includes('/') || !isModelNotFound(message)) throw err
        const classPath = await resolveClassPath(ctx, metaBase, modelName, urlLog)
        urlLog.push(`${metaBase}/getModelBasAttributes?modelName=${classPath}`)
        const text = await agpGet(ctx, metaBase, `/getModelBasAttributes?modelName=${encodeURIComponent(classPath)}`)
        env = parseAgpEnvelope(text)
      }

      const data: Record<string, unknown>[] = env.rows.map((row, i) => ({
        rank: i + 1,
        field_name: String(row.field_name ?? ''),
        field_description: String(row.field_description ?? ''),
        field_type: String(row.field_type ?? ''),
      }))
      if (data.length === 0) {
        data.push({
          rank: 0,
          field_name: '',
          field_description: `模型「${modelName}」没有可见的基本属性（返回 0 行，可能全部属性被设置为不显示）。请直接说明，不要编造字段。`,
          field_type: '',
        })
      }

      const apiOrSql = `GET ${metaBase}/getModelBasAttributes?modelName=${modelName} → ${env.rows.length} 个属性`
      const result = ok(modelFieldListTool.name, {
        apiOrSql,
        params: args,
        fields: FIELDS,
        data,
        executionMs: Date.now() - started,
        total: env.rows.length,
        complete: true,
      })
      applyAudit(modelFieldListTool, args, ctx, apiOrSql, result, started, urlLog[0])
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `模型字段查询异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(modelFieldListTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(modelFieldListTool, args, ctx, urlLog[0] ?? '', result, started, urlLog[0])
      return result
    }
  },
}

export const MODEL_FIELD_LIST_FIELDS = FIELDS
