/**
 * `lookup_object`（P1, metadata）：查设备对象 wt_elm_equipment（§14.2）。
 *
 * 按 class__path / node_name / parent_id 过滤，返回设备树节点。
 * @module
 */

import { runSqlTool, toNumber, type AskdataTool, type ToolContext } from './types.ts'
import { lookupObjectSql } from '../src/sql/templates.ts'
import { validateFilterText, validateLimit } from '../src/sql/validate.ts'

/** lookup_object 工具定义。 */
export const lookupObjectTool: AskdataTool = {
  name: 'lookup_object',
  description:
    '查询设备对象清单（wt_elm_equipment），按模型路径/节点名/父 ID 过滤。用户提到具体设备/电站/逆变器但不确定确切名称时调用本工具。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      class_path: { type: 'string', description: '模型路径关键字（模糊匹配）' },
      node_name: { type: 'string', description: '节点名关键字（模糊匹配）' },
      parent_id: { type: 'integer', description: '父节点 ID（精确匹配）' },
      limit: { type: 'integer', description: '返回条数上限，默认 100' },
    },
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(
      lookupObjectTool,
      args,
      ctx,
      async () => {
        const classPath = args.class_path
          ? validateFilterText(String(args.class_path), 'class_path')
          : undefined
        const nodeName = args.node_name
          ? validateFilterText(String(args.node_name), 'node_name')
          : undefined
        const parentId =
          args.parent_id !== undefined && args.parent_id !== null
            ? Number(args.parent_id)
            : undefined
        const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLookupLimit)
        const sql = lookupObjectSql(ctx.config, {
          appId: ctx.config.appId,
          classPath,
          nodeName,
          parentId,
          limit,
        })
        return {
          sql,
          params: { class_path: classPath, node_name: nodeName, parent_id: parentId, limit },
          fields: [
            { name: 'id', title: '设备ID', type: 'number' },
            { name: 'node_code', title: '节点编码', type: 'string' },
            { name: 'node_name', title: '节点名称', type: 'string' },
            { name: 'class__path', title: '模型路径', type: 'string' },
            { name: 'parent_id', title: '父节点ID', type: 'number' },
            { name: 'tree_level', title: '树层级', type: 'number' },
            { name: 'position', title: '位置', type: 'string' },
          ],
          shape: (rows) =>
            rows.map((r) => ({
              id: toNumber(r.id),
              node_code: r.node_code,
              node_name: r.node_name,
              'class__path': r.class__path,
              parent_id: toNumber(r.parent_id),
              tree_level: toNumber(r.tree_level),
              position: r.position,
            })),
        }
      },
      { executor: ctx.mysqlExecutor, whitelist: ctx.config.security.mysqlTableWhitelist },
    )
  },
}