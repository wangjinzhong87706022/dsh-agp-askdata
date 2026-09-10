/**
 * 工具注册表：P0（TSDB/StarRocks 面 5 工具）+ P1（MySQL 元数据/告警面 6 工具）
 * + 结构验证阶段（StarRocks 设备维度面）。
 *
 * P0 顺序：先字典（lookup_tag），再护栏（estimate_count），再取数（latest_value / time_series / aggregate）。
 * P1 顺序：先模型/设备/测点定义（lookup_model → lookup_object → lookup_tag_definition），
 *          再中文解析（resolve_tag），再告警（query_alarm → query_alarm_config）。
 * @module
 */

import type { AskdataTool } from './types.ts'
import { lookupTagTool } from './lookup-tag.ts'
import { latestValueTool } from './latest-value.ts'
import { timeSeriesTool } from './time-series.ts'
import { aggregateTool } from './aggregate.ts'
import { estimateCountTool } from './estimate-count.ts'
import { lookupModelTool } from './lookup-model.ts'
import { lookupObjectTool } from './lookup-object.ts'
import { lookupTagDefinitionTool } from './lookup-tag-definition.ts'
import { resolveTagTool } from './resolve-tag.ts'
import { queryAlarmTool } from './query-alarm.ts'
import { queryAlarmConfigTool } from './query-alarm-config.ts'
import { lookupDeviceTool } from './lookup-device.ts'

/** P0 全部工具，按推荐调用顺序排列。 */
export const p0Tools: AskdataTool[] = [
  lookupTagTool,
  estimateCountTool,
  latestValueTool,
  timeSeriesTool,
  aggregateTool,
]

/** P1 新增工具，按推荐调用顺序排列。 */
export const p1Tools: AskdataTool[] = [
  lookupModelTool,
  lookupObjectTool,
  lookupTagDefinitionTool,
  resolveTagTool,
  queryAlarmTool,
  queryAlarmConfigTool,
]

/** 结构验证阶段新增：消费真实库 WT_DEVICE 设备层级表（结构验证报告 §2）。 */
export const schemaTools: AskdataTool[] = [lookupDeviceTool]

/** 全部工具（P0 + P1 + 结构验证阶段）。 */
export const allTools: AskdataTool[] = [...p0Tools, ...p1Tools, ...schemaTools]

export {
  lookupTagTool,
  latestValueTool,
  timeSeriesTool,
  aggregateTool,
  estimateCountTool,
  lookupModelTool,
  lookupObjectTool,
  lookupTagDefinitionTool,
  resolveTagTool,
  queryAlarmTool,
  queryAlarmConfigTool,
  lookupDeviceTool,
}
export type { AskdataTool, ToolContext, SqlExecutor, ToolLayer } from './types.ts'
