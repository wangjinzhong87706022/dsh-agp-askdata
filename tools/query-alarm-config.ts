/**
 * `query_alarm_config`（P1, base_business）：查告警配置 bole.wt_cus_alarmdynamicconfig（§14.4）。
 *
 * 按设备模型 cus_class_path 过滤，返回告警规则定义。
 * @module
 */

import { runSqlTool, type AskdataTool, type ToolContext } from './types.ts'
import { queryAlarmConfigSql } from '../src/sql/templates.ts'
import { validateFilterText } from '../src/sql/validate.ts'

/** query_alarm_config 工具定义。 */
export const queryAlarmConfigTool: AskdataTool = {
  name: 'query_alarm_config',
  description:
    '查询告警配置规则（bole.wt_cus_alarmdynamicconfig），按设备模型路径过滤。用户问"某类设备配了哪些告警规则/阈值"时调用本工具。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      cus_class_path: { type: 'string', description: '设备模型路径（精确匹配）' },
    },
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(
      queryAlarmConfigTool,
      args,
      ctx,
      async () => {
        const cusClassPath = args.cus_class_path
          ? validateFilterText(String(args.cus_class_path), 'cus_class_path')
          : undefined
        const sql = queryAlarmConfigSql(ctx.config, {
          appId: ctx.config.appId,
          cusClassPath,
        })
        return {
          sql,
          params: { cus_class_path: cusClassPath },
          fields: [
            { name: 'tag_code', title: '测点编码', type: 'string' },
            { name: 'tag_comment', title: '测点说明', type: 'string' },
            { name: 'cus_class_path', title: '设备模型路径', type: 'string' },
            { name: 'alarm_type', title: '告警类型', type: 'string' },
            { name: 'alarm_level', title: '告警级别', type: 'string' },
            { name: 'alarm_classify', title: '告警分类', type: 'string' },
            { name: 'is_white', title: '是否白名单', type: 'number' },
            { name: 'status', title: '状态', type: 'number' },
          ],
          shape: (rows) =>
            rows.map((r) => ({
              tag_code: r.tag_code,
              tag_comment: r.tag_comment,
              cus_class_path: r.cus_class_path,
              alarm_type: r.alarm_type,
              alarm_level: r.alarm_level,
              alarm_classify: r.alarm_classify,
              is_white: Number(r.is_white),
              status: Number(r.status),
            })),
        }
      },
      { executor: ctx.mysqlExecutor, whitelist: ctx.config.security.mysqlTableWhitelist },
    )
  },
}