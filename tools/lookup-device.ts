/**
 * `lookup_device`（结构验证阶段新增, metadata）：设备维度表反查（逆变器→组串→子阵层级）。
 *
 * WT_DEVICE 真实列为 inverter、array、sub 三级前缀命名（结构验证报告 §2），
 * 每行携带一台逆变器及其所属组串、子阵的完整层级；设备 id 可作为测点
 * tagName 设备段与 WT_CUBE device 过滤的取值来源。
 * @module
 */

import { askdataError } from '../src/errors.ts'
import { lookupDeviceSql } from '../src/sql/templates.ts'
import { validateFilterText, validateLimit } from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'

/** lookup_device 工具定义。 */
export const lookupDeviceTool: AskdataTool = {
  name: 'lookup_device',
  description:
    '查询设备维度表（逆变器→组串→子阵三级层级）。按设备名/编码关键字模糊反查设备及其归属层级，可按设备类型精确过滤。结果的设备 id 可用作测点 tagName 的设备段。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '设备名/编码关键字（模糊匹配逆变器/组串/子阵三级的名称与编码），与 device_type 至少提供一个',
      },
      device_type: {
        type: 'string',
        description: '设备类型（type 列精确匹配），与 keyword 至少提供一个',
      },
      limit: { type: 'integer', description: '1-10000，默认 100' },
    },
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(lookupDeviceTool, args, ctx, async (): Promise<SqlPlan> => {
      const keyword =
        args.keyword !== undefined && args.keyword !== null && String(args.keyword).trim() !== ''
          ? validateFilterText(String(args.keyword), 'keyword')
          : undefined
      const deviceType =
        args.device_type !== undefined && args.device_type !== null && String(args.device_type).trim() !== ''
          ? validateFilterText(String(args.device_type), 'device_type')
          : undefined
      if (keyword === undefined && deviceType === undefined) {
        throw askdataError('INVALID_PARAM', 'keyword 与 device_type 至少提供一个')
      }
      const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLookupLimit)
      const sql = lookupDeviceSql(ctx.config, { keyword, deviceType, limit })
      return {
        sql,
        params: { keyword, device_type: deviceType, limit },
        fields: [
          { name: 'inverterId', title: '逆变器ID', type: 'number' },
          { name: 'inverterName', title: '逆变器名称', type: 'string' },
          { name: 'inverterCode', title: '逆变器编码', type: 'string' },
          { name: 'arrayId', title: '组串ID', type: 'number' },
          { name: 'arrayName', title: '组串名称', type: 'string' },
          { name: 'arrayCode', title: '组串编码', type: 'string' },
          { name: 'subId', title: '子阵ID', type: 'number' },
          { name: 'subName', title: '子阵名称', type: 'string' },
          { name: 'subCode', title: '子阵编码', type: 'string' },
          { name: 'type', title: '设备类型', type: 'string' },
        ],
        shape: (rows) =>
          rows.map((r) => ({
            inverterId: toNumber(r.inverterId),
            inverterName: r.inverterName,
            inverterCode: r.inverterCode,
            arrayId: toNumber(r.arrayId),
            arrayName: r.arrayName,
            arrayCode: r.arrayCode,
            subId: toNumber(r.subId),
            subName: r.subName,
            subCode: r.subCode,
            type: r.type,
          })),
      }
    })
  },
}
