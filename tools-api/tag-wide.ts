/**
 * `tag_wide`（P0, metadata）：查询宽格式历史数据（getWideHistory）。
 * @module
 */

import { describeQueryResult, runApiTool, validatePositiveInt, validateTagNamesArg, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** tag_wide 工具定义。 */
export const tagWideTool: AskdataApiTool = {
  name: 'tag_wide',
  description:
    '查询等间距的历史数据（宽格式），适合画曲线图。interval 为采样间隔（秒）。时间格式：2023-12-30 01:22:22。注意：end_time 与 sample 至少提供一个（网关实际实现要求，20260910 文档未写明）。',
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
      interval: {
        type: 'integer',
        description: '采样间隔（秒），如 60 表示每分钟一个点',
      },
      end_time: {
        type: 'string',
        description: '结束时间；end_time 与 sample 必须至少提供一个（网关实测要求）',
      },
      sample: {
        type: 'integer',
        description: '样本数；end_time 与 sample 必须至少提供一个（网关实测要求）',
      },
      date_format: {
        type: 'string',
        description: '时间格式，默认 "YYYY-MM-DD HH:mm:ss"',
      },
    },
    required: ['tag_names', 'start_time', 'interval'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(tagWideTool, args, ctx, async () => {
      const tagNames = validateTagNamesArg(args.tag_names)
      const startTime = String(args.start_time ?? '').trim()
      if (startTime === '') throw askdataError('INVALID_PARAM', 'start_time 必填')
      const interval = validatePositiveInt(args.interval, 'interval')
      const sample = args.sample !== undefined && args.sample !== null && args.sample !== ''
        ? validatePositiveInt(args.sample, 'sample')
        : undefined

      return {
        request: {
          path: '/wz/iot-etl/iot/getWideHistory',
          params: {
            tagNames,
            startTime,
            interval,
            ...(args.end_time ? { endTime: String(args.end_time) } : {}),
            ...(sample !== undefined ? { sample } : {}),
            ...(args.date_format ? { dateFormat: String(args.date_format) } : {}),
          },
        },
        describe: describeQueryResult,
      }
    })
  },
}
