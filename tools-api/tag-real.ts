/**
 * `tag_real`（P0, metadata）：查询测点实时值。
 *
 * 20260910 接口版：路径改为 `getIOTTagRealValues`，返回 QueryResult 形态
 * （field: tagname/datetime/value/quality）。注意 field 名与数据行键不一致
 * （行键为 tagName/time/value/comment），按双键名兼容取值；旧 getTagRealValues
 * 的对象映射形态保留为回落分支。
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
        description: '测点名列表，如 ["current_1O_pump0002"]',
      },
    },
    required: ['tag_names'],
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(tagRealTool, args, ctx, async () => {
      const tagNames = validateTagNamesArg(args.tag_names)
      return {
        request: {
          path: '/wz/iot-etl/iot/getIOTTagRealValues',
          params: { tagNames },
        },
        describe: describeRealValues,
      }
    })
  },
}

/** 实时值响应解释：QueryResult 行形态（20260910）为主，旧对象映射形态为回落。 */
export function describeRealValues(raw: unknown): { fields: import('../src/result.ts').ResultField[]; data: Record<string, unknown>[] } {
  // QueryResult 形态：{field: [...], data: [{value, time, tagName, comment}, ...]}
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    const rows = (raw as { data: Record<string, unknown>[] }).data
    return {
      fields: [
        { name: 'tagName', title: '测点代码', type: 'string' },
        { name: 'value', title: '数值', type: 'number' },
        { name: 'timestamp', title: '时间戳', type: 'datetime' },
        { name: 'comment', title: '测点名称', type: 'string' },
      ],
      data: rows.map((r) => ({
        tagName: toString(r.tagName ?? r.tagname),
        value: toNumber(r.value),
        timestamp: toString(r.time ?? r.datetime),
        comment: toString(r.comment),
      })),
    }
  }
  // 旧形态：{tagName: {value, time, tagName, comment}} 对象映射
  const map = (raw ?? {}) as Record<string, { value?: unknown; time?: unknown; tagName?: unknown; comment?: unknown }>
  return {
    fields: [
      { name: 'tagName', title: '测点代码', type: 'string' },
      { name: 'value', title: '数值', type: 'number' },
      { name: 'timestamp', title: '时间戳', type: 'datetime' },
      { name: 'comment', title: '测点名称', type: 'string' },
    ],
    data: Object.entries(map).map(([key, info]) => ({
      tagName: toString(info?.tagName ?? key),
      value: toNumber(info?.value),
      timestamp: toString(info?.time),
      comment: toString(info?.comment),
    })),
  }
}
