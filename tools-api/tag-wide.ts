/**
 * `tag_wide`（P0, metadata）：查询宽格式历史数据（getWideHistory）。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** tag_wide 工具定义。 */
export const tagWideTool: AskdataApiTool = {
  name: 'tag_wide',
  description:
    '查询等间距的历史数据（宽格式），适合画曲线图。interval 为采样间隔（秒）。时间格式：2023-12-30 01:22:22',
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
        description: '结束时间（与 sample 互斥）',
      },
      sample: {
        type: 'integer',
        description: '样本数（与 end_time 互斥）',
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
      const tagNames = args.tag_names as string[]
      const startTime = String(args.start_time ?? '').trim()
      const interval = Number(args.interval ?? 0)
      if (!Array.isArray(tagNames) || tagNames.length === 0) {
        throw askdataError('INVALID_PARAM', 'tag_names 必填且不能为空数组')
      }
      if (startTime === '') throw askdataError('INVALID_PARAM', 'start_time 必填')
      if (interval <= 0) throw askdataError('INVALID_PARAM', 'interval 必须为正整数')

      const result = await ctx.apiClient.getWideHistory({
        tagNames,
        startTime,
        interval,
        endTime: args.end_time ? String(args.end_time) : undefined,
        sample: args.sample ? Number(args.sample) : undefined,
        dateFormat: args.date_format ? String(args.date_format) : undefined,
      })

      return {
        path: '/wz/iot-etl/iot/getWideHistory',
        params: { tagNames, startTime, interval },
        fields: result.field.map((f) => ({
          name: f.name,
          title: f.title || f.name,
          type: f.type === '52' ? 'datetime' : f.type === '1' || f.type === '11' || f.type === '22' ? 'number' : 'string',
        })),
        shape: (rows) =>
          rows.map((r) => {
            const obj: Record<string, unknown> = {}
            for (const f of result.field) {
              const val = r[f.name]
              if (f.type === '1' || f.type === '11' || f.type === '22') {
                obj[f.name] = toNumber(val as string | null)
              } else {
                obj[f.name] = toString(val)
              }
            }
            return obj
          }),
      }
    })
  },
}