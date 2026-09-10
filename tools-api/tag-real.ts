/**
 * `tag_real`（P0, metadata）：查询测点实时值（getTagRealValues）。
 * @module
 */

import { runApiTool, toString, toNumber, validateTagNamesArg, type AskdataApiTool, type ApiToolContext } from './types.ts'

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
      const tagNames = validateTagNamesArg(args.tag_names)
      // 响应是 {tagName: {value, timestamp}} 的对象映射，而非行数组
      return {
        request: {
          path: '/wz/iot-etl/iot/getTagRealValues',
          params: { tagNames },
        },
        describe: (raw) => {
          const map = (raw ?? {}) as Record<string, { value?: unknown; timestamp?: unknown }>
          return {
            fields: [
              { name: 'tagName', title: '测点名', type: 'string' },
              { name: 'value', title: '实时值', type: 'number' },
              { name: 'timestamp', title: '时间戳', type: 'string' },
            ],
            data: Object.entries(map).map(([tagName, info]) => ({
              tagName,
              value: toNumber(info?.value),
              timestamp: toString(info?.timestamp),
            })),
          }
        },
      }
    })
  },
}
