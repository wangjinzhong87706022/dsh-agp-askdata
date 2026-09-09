/**
 * `lookup_tag_definition`（P1, metadata）：查动态属性定义 meta_classtagmodel（§14.2）。
 *
 * 按设备模型 class_path 查其所有测点定义（tag_code/name/tag_type/calculated/in_out）。
 * @module
 */

import { runSqlTool, type AskdataTool, type ToolContext } from './types.ts'
import { lookupTagDefinitionSql } from '../src/sql/templates.ts'
import { validateFilterText } from '../src/sql/validate.ts'
import { askdataError } from '../src/errors.ts'

/** lookup_tag_definition 工具定义。 */
export const lookupTagDefinitionTool: AskdataTool = {
  name: 'lookup_tag_definition',
  description:
    '查询设备模型的动态属性定义（meta_classtagmodel）。给定 class_path 返回该模型所有测点的 tag_code/中文名/类型。LLM 需了解某类设备能查哪些测点时调用本工具。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      class_path: { type: 'string', description: '设备模型路径（精确匹配，从 lookup_model 获取）' },
    },
    required: ['class_path'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(
      lookupTagDefinitionTool,
      args,
      ctx,
      async () => {
        const classPath = validateFilterText(String(args.class_path ?? ''), 'class_path')
        if (classPath.trim() === '') throw askdataError('INVALID_PARAM', 'class_path 必填')
        const sql = lookupTagDefinitionSql(ctx.config, classPath)
        return {
          sql,
          params: { class_path: classPath },
          fields: [
            { name: 'tag_code', title: '测点编码', type: 'string' },
            { name: 'name', title: '测点中文名', type: 'string' },
            { name: 'tag_type', title: '测点类型', type: 'number' },
            { name: 'calculated', title: '是否计算点', type: 'number' },
            { name: 'in_out', title: '输入输出方向', type: 'number' },
          ],
          shape: (rows) =>
            rows.map((r) => ({
              tag_code: r.tag_code,
              name: r.name,
              tag_type: Number(r.tag_type),
              calculated: Number(r.calculated),
              in_out: Number(r.in_out),
            })),
        }
      },
      { executor: ctx.mysqlExecutor, whitelist: ctx.config.security.mysqlTableWhitelist },
    )
  },
}