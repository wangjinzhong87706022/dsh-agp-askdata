/**
 * API 工具注册表：P0（元数据面 10 工具，20260910 接口版）。
 *
 * 顺序：先字典（list_models → model_attributes），再查询（query_model →
 * query_model_segment → query_relation_segment），再测点（resolve_tag →
 * tag_real → tag_history → tag_wide → tag_aggregate）。
 * @module
 */

import type { AskdataApiTool } from './types.ts'
import { listModelsTool } from './list-models.ts'
import { modelAttributesTool } from './model-attributes.ts'
import { queryModelTool } from './query-model.ts'
import { queryModelSegmentTool } from './query-model-segment.ts'
import { queryRelationSegmentTool } from './query-relation-segment.ts'
import { tagRealTool } from './tag-real.ts'
import { tagHistoryTool } from './tag-history.ts'
import { tagWideTool } from './tag-wide.ts'
import { tagAggregateTool } from './tag-aggregate.ts'
import { resolveTagTool } from './resolve-tag.ts'

/** P0 全部 API 工具，按推荐调用顺序排列。 */
export const apiTools: AskdataApiTool[] = [
  listModelsTool,
  modelAttributesTool,
  queryModelTool,
  queryModelSegmentTool,
  queryRelationSegmentTool,
  resolveTagTool,
  tagRealTool,
  tagHistoryTool,
  tagWideTool,
  tagAggregateTool,
]

export {
  listModelsTool,
  modelAttributesTool,
  queryModelTool,
  queryModelSegmentTool,
  queryRelationSegmentTool,
  tagRealTool,
  tagHistoryTool,
  tagWideTool,
  tagAggregateTool,
  resolveTagTool,
}
export type { AskdataApiTool, ApiToolContext } from './types.ts'
