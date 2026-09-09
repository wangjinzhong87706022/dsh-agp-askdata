/**
 * `query_alarm`（P1, base_business）：查告警记录 wt_bas_alarmrecord（§14.4）。
 *
 * 按时间区间 + 告警级别过滤，返回告警事件。
 * @module
 */

import { runSqlTool, toNumber, type AskdataTool, type ToolContext } from './types.ts'
import { queryAlarmSql } from '../src/sql/templates.ts'
import { validateLimit, validateTimeRange } from '../src/sql/validate.ts'

/** query_alarm 工具定义。 */
export const queryAlarmTool: AskdataTool = {
  name: 'query_alarm',
  description:
    '查询告警记录（wt_bas_alarmrecord），按时间区间和告警级别过滤。用户问"最近有什么告警/故障/异常"时调用本工具。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      start_time: { type: 'string', description: '起始时间 ISO8601' },
      end_time: { type: 'string', description: '结束时间 ISO8601' },
      alarm_level: { type: 'string', description: '告警级别（精确匹配）' },
      limit: { type: 'integer', description: '返回条数上限，默认 100' },
    },
    required: ['start_time', 'end_time'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(
      queryAlarmTool,
      args,
      ctx,
      async () => {
        const startTime = String(args.start_time ?? '')
        const endTime = String(args.end_time ?? '')
        validateTimeRange(startTime, endTime, ctx.config.system)
        const alarmLevel = args.alarm_level ? String(args.alarm_level) : undefined
        const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultAlarmLimit)
        const sql = queryAlarmSql(ctx.config, {
          appId: ctx.config.appId,
          startTime,
          endTime,
          alarmLevel,
          limit,
        })
        return {
          sql,
          params: { start_time: startTime, end_time: endTime, alarm_level: alarmLevel, limit },
          fields: [
            { name: 'id', title: '告警ID', type: 'number' },
            { name: 'alarm_title', title: '告警标题', type: 'string' },
            { name: 'alarm_time', title: '告警时间', type: 'datetime' },
            { name: 'alarm_level', title: '告警级别', type: 'string' },
            { name: 'alarm_status', title: '告警状态', type: 'number' },
            { name: 'entity_name', title: '设备名称', type: 'string' },
            { name: 'tag_code', title: '测点编码', type: 'string' },
            { name: 'description', title: '描述', type: 'string' },
          ],
          shape: (rows) =>
            rows.map((r) => ({
              id: toNumber(r.id),
              alarm_title: r.alarm_title,
              alarm_time: r.alarm_time,
              alarm_level: r.alarm_level,
              alarm_status: toNumber(r.alarm_status),
              entity_name: r.entity_name,
              tag_code: r.tag_code,
              description: r.description,
            })),
        }
      },
      { executor: ctx.mysqlExecutor, whitelist: ctx.config.security.mysqlTableWhitelist },
    )
  },
}