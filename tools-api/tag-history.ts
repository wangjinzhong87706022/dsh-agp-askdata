/**
 * `tag_history`（P0, metadata）：查询测点历史原始值（getTagRawHistory）。
 * @module
 */

import { describeQueryResult, runApiTool, validatePositiveInt, validateTagNamesArg, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** tag_history 工具定义。 */
export const tagHistoryTool: AskdataApiTool = {
  name: 'tag_history',
  description:
    '查询测点的历史原始值（不等间距时间序列）。需指定起始时间，可选结束时间或样本数。时间格式：2023-12-30 01:22:22',
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
      end_time: {
        type: 'string',
        description: '结束时间（与 sample 互斥）',
      },
      sample: {
        type: 'integer',
        description: '样本数（与 end_time 互斥）',
      },
    },
    required: ['tag_names', 'start_time'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(tagHistoryTool, args, ctx, async () => {
      const tagNames = validateTagNamesArg(args.tag_names)
      const startTime = String(args.start_time ?? '').trim()
      if (startTime === '') throw askdataError('INVALID_PARAM', 'start_time 必填')
      const sample = args.sample !== undefined && args.sample !== null && args.sample !== ''
        ? validatePositiveInt(args.sample, 'sample')
        : undefined

      return {
        request: {
          path: '/wz/iot-etl/iot/getTagRawHistory',
          params: {
            tagNames,
            startTime,
            ...(args.end_time ? { endTime: String(args.end_time) } : {}),
            ...(sample !== undefined ? { sample } : {}),
          },
        },
        describe: describeQueryResult,
      }
    })
  },
}
