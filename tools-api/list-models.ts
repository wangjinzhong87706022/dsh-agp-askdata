/**
 * `list_models`（P0, metadata）：列出所有可用数据模型（getModelList）。
 *
 * 网关不特别支持服务端过滤/分页（实测传参返回全量），因此 keyword 在客户端
 * 过滤（对 class_alias/class_name/class_description 不区分大小写包含匹配），
 * page_num/page_size 对过滤结果做客户端分页——模型数量级（数百）下开销可忽略。
 * @module
 */

import { runApiTool, toString, toNumber, type AskdataApiTool, type ApiToolContext } from './types.ts'
import { askdataError } from '../src/errors.ts'

/** list_models 工具定义。 */
export const listModelsTool: AskdataApiTool = {
  name: 'list_models',
  description:
    '列出当前项目中所有可用的数据模型，支持 keyword 过滤（匹配模型别名/英文名/描述，如 keyword="泵" 或 "模拟量"）。用户问"有哪些模型"或"能查什么"时调用；找特定业务的模型时务必带 keyword。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '过滤关键字（匹配模型别名/英文名/描述，不区分大小写），如 "泵"、"模拟量"、"水表"',
      },
      page_num: { type: 'integer', description: '页码（对过滤结果分页），默认 1' },
      page_size: { type: 'integer', description: '每页条数，默认 50，最大 1000' },
    },
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(listModelsTool, args, ctx, async () => {
      const keyword = String(args.keyword ?? '').trim().toLowerCase()
      const pageSize = Math.min(Number(args.page_size ?? 50) || 50, 1000)
      const pageNum = Math.max(Number(args.page_num ?? 1) || 1, 1)
      return {
        request: { path: '/wz/meta/getModelList', params: {} },
        describe: (raw) => {
          const rows = ((raw as { data?: Record<string, unknown>[] }).data ?? []) as Record<string, unknown>[]
          const all = rows.map((r) => ({
            id: toNumber(r.id),
            class_alias: toString(r.class_alias),
            class_name: toString(r.class_name),
            class_path: toString(r.class_path),
            class_description: toString(r.class_description),
            classify_tag: toString(r.classify_tag),
          }))
          const filtered = keyword
            ? all.filter((m) =>
                [m.class_alias, m.class_name, m.class_description, m.classify_tag]
                  .some((v) => v && v.toLowerCase().includes(keyword)))
            : all
          const start = (pageNum - 1) * pageSize
          const pageRows = filtered.slice(start, start + pageSize)
          const itemTotal = filtered.length
          return {
            fields: [
              { name: 'id', title: '模型ID', type: 'number' },
              { name: 'class_alias', title: '模型别名', type: 'string' },
              { name: 'class_name', title: '模型英文名', type: 'string' },
              { name: 'class_description', title: '模型描述', type: 'string' },
            ],
            data: pageRows,
            page: {
              pageNum,
              pageSize,
              pageTotal: Math.max(Math.ceil(itemTotal / pageSize), 1),
              itemTotal,
            },
          }
        },
      }
    })
  },
}
