/**
 * 工具注册表：P0（TSDB/StarRocks 面 5 工具）+ P1（MySQL 元数据/告警面 6 工具）
 * + P2 知识面（RAGFlow graph/wiki/mindmap/原文检索 4 工具）+ 值班报告面（2 工具）。
 *
 * P0 顺序：先字典（lookup_tag），再护栏（estimate_count），再取数（latest_value / time_series / aggregate）。
 * P1 顺序：先模型/设备/测点定义（lookup_model → lookup_object → lookup_tag_definition），
 *          再中文解析（resolve_tag），再告警（query_alarm → query_alarm_config）。
 * P2 顺序：先图谱定位实体（knowledge_graph），再原文取证（knowledge_search），
 *          再按需取全景页面（knowledge_wiki_page）或层级导航（knowledge_mindmap）。
 * 值班面顺序：先台账（list_duty_stations），再报告（generate_duty_report）。
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
import { askdataDeepAnalysisTool } from './deep-analysis.ts'
import { knowledgeSearchTool } from './knowledge-search.ts'
import { knowledgeGraphTool } from './knowledge-graph.ts'
import { knowledgeWikiPageTool } from './knowledge-wiki-page.ts'
import { knowledgeMindmapTool } from './knowledge-mindmap.ts'
import { dutyReportTool } from './duty-report.ts'
import { dutyStationsTool } from './duty-stations.ts'

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

/**
 * P2 subagent-style 工具：自然语言问数入口（自动流水线 + 溯源）。
 * 工具面与 P0/P1 互斥：模型可视 12 个工具时倾向走基础工具 + 自己编排；
 * 用户/简单场景倾向本工具"一答到底"。
 */
export const subagentTools: AskdataTool[] = [
  askdataDeepAnalysisTool,
]

/**
 * P2 知识面工具（RAGFlow graph/wiki/mindmap/原文检索）：问数的第二数据源——
 * TSDB 给数值，知识库给依据。与取数面工具互补，不替换任何取数能力。
 */
export const knowledgeTools: AskdataTool[] = [
  knowledgeGraphTool,
  knowledgeSearchTool,
  knowledgeWikiPageTool,
  knowledgeMindmapTool,
]

/**
 * 值班报告面工具（防汛值班报告 Agent，docs/architecture.md §19）：
 * 先列台账（list_duty_stations 澄清槽位），再生成报告（generate_duty_report 编排
 * AGP API 取数 → 规则研判 → RAGFlow 规程引用 → 8 段 HTML → 落盘出闸）。
 */
export const dutyTools: AskdataTool[] = [
  dutyStationsTool,
  dutyReportTool,
]

/** 全部工具（P0 + P1 + subagent-style + 知识面 + 值班报告面，共 18 个）。 */
export const allTools: AskdataTool[] = [...p0Tools, ...p1Tools, ...subagentTools, ...knowledgeTools, ...dutyTools]

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
  askdataDeepAnalysisTool,
  knowledgeSearchTool,
  knowledgeGraphTool,
  knowledgeWikiPageTool,
  knowledgeMindmapTool,
  dutyReportTool,
  dutyStationsTool,
}
export type { AskdataTool, ToolContext, SqlExecutor, ToolLayer } from './types.ts'
