/**
 * `tag_real`（P0, metadata）：查询测点实时值（getTagRealValues）。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** tag_real 工具定义。 */
export const tagRealTool: AskdataApiTool = {
  name: 'tag_real',
  description:
    '查询一个或多个测点的实时值。tagName 格式为 "前缀_粒度_设备"。不确定 tagName 时先调 resolve_tag。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      tag_names: {
        type: 'array',
        items: { type: 'string' },
        description: '测点名列表，如 ["Quantity_1O_SKZH-1#-01F-1"]',
      },
    },
    required: ['tag_names'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(tagRealTool, args, ctx, async () => {
      const tagNames = args.tag_names as string[]
      if (!Array.isArray(tagNames) || tagNames.length === 0) {
        throw askdataError('INVALID_PARAM', 'tag_names 必填且不能为空数组')
      }
      const result = await ctx.apiClient.getTagRealValues(tagNames)
      return {
        path: `/wz/iot-etl/iot/getTagRealValues?tagNames=${encodeURIComponent(tagNames.join(','))}`,
        params: { tagNames },
        fields: [
          { name: 'tagName', title: '测点名', type: 'string' },
          { name: 'value', title: '实时值', type: 'number' },
          { name: 'timestamp', title: '时间戳', type: 'string' },
        ],
        shape: (rows) => {
          const data: Record<string, unknown>[] = []
          for (const [tagName, info] of Object.entries(result)) {
            data.push({
              tagName,
              value: toNumber(info.value as string | null),
              timestamp: toString(info.timestamp),
            })
          }
          return data
        },
      }
    })
  },
}