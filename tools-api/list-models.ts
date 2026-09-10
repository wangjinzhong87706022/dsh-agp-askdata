/**
 * `list_models`（P0, metadata）：列出所有可用数据模型（getModelList）。
 * @module
 */

import { runApiTool, toString, type AskdataApiTool, type ApiToolContext } from './types.ts'

/** list_models 工具定义。 */
export const listModelsTool: AskdataApiTool = {
  name: 'list_models',
  description:
    '列出当前项目中所有可用的数据模型。返回模型名称、路径和描述。用户问"有哪些模型"或"能查什么"时调用。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async run(args, ctx: ApiToolContext) {
    return runApiTool(listModelsTool, args, ctx, async () => {
      const models = await ctx.apiClient.getModelList()
      return {
        path: '/wz/meta/getModelList',
        params: {},
        fields: [
          { name: 'id', title: '模型ID', type: 'number' },
          { name: 'class_alias', title: '模型别名', type: 'string' },
          { name: 'class_name', title: '模型英文名', type: 'string' },
          { name: 'class_path', title: '模型路径', type: 'string' },
          { name: 'class_description', title: '模型描述', type: 'string' },
          { name: 'classify_tag', title: '分类标签', type: 'string' },
        ],
        shape: (rows) =>
          rows.map((r) => ({
            id: r.id,
            class_alias: toString(r.class_alias),
            class_name: toString(r.class_name),
            class_path: toString(r.class_path),
            class_description: toString(r.class_description),
            classify_tag: toString(r.classify_tag),
          })),
      }
    })
  },
}