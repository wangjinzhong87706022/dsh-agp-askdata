/**
 * `estimate_count`（P0, metadata）：扫描行数估算护栏。
 *
 * 独立暴露给 LLM：回答"这个区间能查多少数据"类问题，以及大查询前的自检。
 * 超过 `system.maxScanRows`（默认 1 亿）时返回 EXCEED_LIMIT 失败。
 * @module
 */

import { estimateScanSql } from '../src/sql/templates.ts'
import { validateTimeRange } from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'

/** estimate_count 工具定义。 */
export const estimateCountTool: AskdataTool = {
  name: 'estimate_count',
  description:
    '估算某时间区间内 WT_DATA 会扫描的记录数（安全护栏）。大查询前调用；超过 max-scan-rows（默认 1 亿）会被拒绝。',
  layer: 'metadata',
  inputSchema: {
    type: 'object',
    properties: {
      start_time: { type: 'string', format: 'date-time' },
      end_time: { type: 'string', format: 'date-time' },
    },
    required: ['start_time', 'end_time'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(estimateCountTool, args, ctx, async (): Promise<SqlPlan> => {
      validateTimeRange(String(args.start_time ?? ''), String(args.end_time ?? ''), ctx.config.system)
      const startIso = String(args.start_time)
      const endIso = String(args.end_time)
      const sql = estimateScanSql(ctx.config, startIso, endIso)
      const maxRows = ctx.config.system.maxScanRows
      return {
        sql,
        params: { start_time: startIso, end_time: endIso },
        fields: [
          { name: 'scanRows', title: '扫描行数估算', type: 'number' },
          { name: 'withinLimit', title: '是否在限额内', type: 'boolean' },
          { name: 'maxScanRows', title: '限额', type: 'number' },
        ],
        shape: (rows) => {
          const scanRows = toNumber(rows[0]?.scanRows) ?? 0
          return [{ scanRows, withinLimit: scanRows <= maxRows, maxScanRows: maxRows }]
        },
      }
    })
  },
}
