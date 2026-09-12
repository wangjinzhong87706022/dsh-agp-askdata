/**
 * `lookup_model`（P1, metadata）：查模型清单 meta_class_info（§14.2）。
 *
 * 返回光伏应用（app_id 过滤）下所有设备模型，供 LLM 了解可查设备类型。
 * @module
 */

import { runSqlTool, type AskdataTool, type ToolContext } from './types.ts'
import { lookupModelSql } from '../src/sql/templates.ts'
import { validateLimit } from '../src/sql/validate.ts'

/** lookup_model 工具定义。 */
export const lookupModelTool: AskdataTool = {
  name: 'lookup_model',
  description:
    '查询光伏应用下的设备模型清单（meta_class_info）。LLM 需了解有哪些设备类型/模型时可调用本工具。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '返回条数上限，默认 100' },
    },
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(
      lookupModelTool,
      args,
      ctx,
      async () => {
        const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLookupLimit)
        const sql = lookupModelSql(ctx.config, ctx.config.appId, limit)
        return {
          sql,
          params: { app_id: ctx.config.appId, limit },
          fields: [
            { name: 'class_alias', title: '模型别名', type: 'string' },
            { name: 'class_name', title: '模型名称', type: 'string' },
            { name: 'class_path', title: '模型路径', type: 'string' },
            { name: 'level', title: '层级', type: 'number' },
          ],
          shape: (rows) =>
            rows.map((r) => ({
              class_alias: r.class_alias,
              class_name: r.class_name,
              class_path: r.class_path,
              level: Number(r.level),
            })),
        }
      },
      { executor: ctx.mysqlExecutor, whitelist: ctx.config.security.mysqlTableWhitelist },
    )
  },
}