/**
 * `tag_aggregate`（P0, metadata）：查询测点历史统计值（getTagAggrigateHistory）。
 *
 * 路径拼写 `Aggrigate` 为 AGP 网关的官方形态（docs/TDD-AGP-API-Smart-Query.md
 * 实测验证），非笔误——勿"纠正"为 Aggregate。
 * @module
 */

import { describeQueryResult, runApiTool, validatePositiveInt, validateTagNamesArg, type AskdataApiTool, type ApiToolContext } from './types.ts'
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
    '查询测点的历史统计值。methods 可选: max/min/mean/rms/count/stddeviation/percentile50 等。时间格式：2023-12-30 01:22:22',
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
        description: '结束时间（与 sample 互斥）',
      },
      sample: {
        type: 'integer',
        description: '样本数（与 end_time 互斥）',
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
      const sample = args.sample !== undefined && args.sample !== null && args.sample !== ''
        ? validatePositiveInt(args.sample, 'sample')
        : undefined

      return {
        request: {
          path: '/wz/iot-etl/iot/getTagAggrigateHistory',
          params: {
            tagNames,
            startTime,
            methods,
            ...(args.end_time ? { endTime: String(args.end_time) } : {}),
            ...(sample !== undefined ? { sample } : {}),
            ...(args.params ? { params: String(args.params) } : {}),
          },
        },
        describe: describeQueryResult,
      }
    })
  },
}
