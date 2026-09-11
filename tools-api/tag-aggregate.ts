/**
 * `tag_aggregate`（P0, metadata）：查询测点历史统计值（getTagAggrigateHistory）。
 *
 * 路径拼写 `Aggrigate` 为 AGP 网关的官方形态（docs/TDD-AGP-API-Smart-Query.md
 * 实测验证），非笔误——勿"纠正"为 Aggregate。
 * @module
 */

import { describeQueryResult, runApiTool, toNumber, toString, validatePositiveInt, validateTagNamesArg, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** 16 种统计方法枚举。 */
const AGGREGATE_METHODS = [
  'max', 'min', 'mean', 'rms', 'count',
  'skewness', 'kurtosis',
  'percentile100', 'percentile50', 'percentile10', 'percentile4',
  'percentile', 'stddeviation', 'geometrimean',
  'populationvariance', 'elementat', 'valueindex', 'duration',
] as const

/** tag_aggregate 工具定义。 */
export const tagAggregateTool: AskdataApiTool = {
  name: 'tag_aggregate',
  description:
    '查询测点的历史统计值。methods 可选: max/min/mean/rms/count/stddeviation/percentile50 等。时间格式：2023-12-30 01:22:22。end_time 与 sample 至少提供一个（同给时 end_time 优先）。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      tag_names: {
        type: 'array',
        items: { type: 'string' },
        description: '测点名列表',
      },
      start_time: {
        type: 'string',
        description: '起始时间，如 "2023-12-30 01:22:22"',
      },
      methods: {
        type: 'array',
        items: { type: 'string', enum: AGGREGATE_METHODS },
        description: '统计方法列表，如 ["max", "min", "mean"]',
      },
      end_time: {
        type: 'string',
        description: '结束时间；end_time 与 sample 至少提供一个（同给时 end_time 优先）',
      },
      sample: {
        type: 'integer',
        description: '样本数；end_time 与 sample 至少提供一个（同给时 end_time 优先）',
      },
      params: {
        type: 'string',
        description: '额外参数（percentile/elementat/duration 时需要）',
      },
    },
    required: ['tag_names', 'start_time', 'methods'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(tagAggregateTool, args, ctx, async () => {
      const tagNames = validateTagNamesArg(args.tag_names)
      const startTime = String(args.start_time ?? '').trim()
      const methods = args.methods as string[]
      if (startTime === '') throw askdataError('INVALID_PARAM', 'start_time 必填')
      if (!Array.isArray(methods) || methods.length === 0) {
        throw askdataError('INVALID_PARAM', 'methods 必填且不能为空数组')
      }
      // 校验 methods 是否在枚举内
      for (const m of methods) {
        if (!AGGREGATE_METHODS.includes(m as (typeof AGGREGATE_METHODS)[number])) {
          throw askdataError('INVALID_PARAM', `未知统计方法: ${m}，可选: ${AGGREGATE_METHODS.join(', ')}`)
        }
      }
      // 网关要求参数全传：endTime 与 sample 至少提供一个（同给时 endTime 优先），
      // params 恒传（空串占位）——缺任一参数报 -1「系统内部出现错误」（2026-09-11 实测）
      const endTime = args.end_time ? String(args.end_time) : undefined
      const sample = args.sample !== undefined && args.sample !== null && args.sample !== ''
        ? validatePositiveInt(args.sample, 'sample')
        : undefined
      if (endTime === undefined && sample === undefined) {
        throw askdataError('INVALID_PARAM', 'end_time 与 sample 至少提供一个')
      }

      return {
        request: {
          path: '/wz/iot-etl/iot/getTagAggrigateHistory',
          params: {
            tagNames,
            startTime,
            methods,
            params: args.params ? String(args.params) : '',
            ...(endTime !== undefined ? { endTime } : {}),
            ...(sample !== undefined ? { sample } : {}),
          },
        },
        describe: describeAggrigateHistory,
      }
    })
  },
}

/**
 * 统计值响应解释：主形态为 `{type:'history_inter', data:{tagName: [行...]}}`
 * 包装（2026-09-11 实测），QueryResult 形态回落。
 */
export function describeAggrigateHistory(raw: unknown): { fields: import('../src/result.ts').ResultField[]; data: Record<string, unknown>[] } {
  const wrapped = raw as { type?: string; data?: Record<string, Record<string, unknown>[]> } | undefined
  if (wrapped && typeof wrapped === 'object' && wrapped.type === 'history_inter' && wrapped.data && !Array.isArray(wrapped.data)) {
    const rows: Record<string, unknown>[] = []
    for (const [tagName, list] of Object.entries(wrapped.data)) {
      for (const row of list ?? []) {
        rows.push({
          tagName,
          tag: toString(row.tag),
          type: toString(row.type),
          time: toString(row.time),
          value: toNumber(row.value),
          comment: toString(row.comment),
        })
      }
    }
    return {
      fields: [
        { name: 'tagName', title: '测点代码', type: 'string' },
        { name: 'type', title: '测点类型', type: 'string' },
        { name: 'time', title: '统计窗', type: 'datetime' },
        { name: 'value', title: '统计值', type: 'number' },
        { name: 'comment', title: '测点名称', type: 'string' },
      ],
      data: rows,
    }
  }
  // QueryResult 形态回落（field + data）
  if (raw && typeof raw === 'object' && Array.isArray((raw as { field?: unknown }).field)) {
    return describeQueryResult(raw)
  }
  return { fields: [], data: [] }
}
