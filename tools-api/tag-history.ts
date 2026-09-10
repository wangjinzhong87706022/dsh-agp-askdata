/**
 * `tag_history`（P0, metadata）：查询测点历史原始值（getTagRawHistory）。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
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
      const tagNames = args.tag_names as string[]
      const startTime = String(args.start_time ?? '').trim()
      if (!Array.isArray(tagNames) || tagNames.length === 0) {
        throw askdataError('INVALID_PARAM', 'tag_names 必填且不能为空数组')
      }
      if (startTime === '') throw askdataError('INVALID_PARAM', 'start_time 必填')

      const result = await ctx.apiClient.getTagRawHistory({
        tagNames,
        startTime,
        endTime: args.end_time ? String(args.end_time) : undefined,
        sample: args.sample ? Number(args.sample) : undefined,
      })

      return {
        path: '/wz/iot-etl/iot/getTagRawHistory',
        params: { tagNames, startTime },
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