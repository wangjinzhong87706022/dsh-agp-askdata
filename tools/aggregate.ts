/**
 * `aggregate`（P0, base_business）：SQL 端时序聚合，支持维度分组（§3.3）。
 *
 * 路由策略（对 LLM 接口不变，§14.10）：
 * - tag_filter 可解析出 `tagCode(+device)+粒度` 且 func 可路由（SUM/AVG/MAX/MIN/COUNT）
 *   且配置了聚合表 → cubeType 唯一性预检通过后查 WT_CUBE（1H/1D/1M/1Y 粒度唯一有数据的面）；
 * - 需要 tagName 分组（device/tagcode）→ 回退 LEFT JOIN WT_TAG 版模板（e2e 实证路径）；
 * - 其余 → tagIndex IN 子查询版模板。
 * @module
 */

import {
  aggregateByTagIndexSql,
  aggregateCubeSql,
  aggregateSql,
  cubeTypeDistinctSql,
  tagIndexByFilterSql,
} from '../src/sql/templates.ts'
import { parseTagFilterPrefix } from '../src/sql/tagname.ts'
import { assertSafeToExecute } from '../src/sql/whitelist.ts'
import { askdataError } from '../src/errors.ts'
import {
  validateAggFunc,
  validateFilterText,
  validateGroupBy,
  validateLimit,
  validateTimeRange,
} from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'
import { assertScanWithinLimit } from './time-series.ts'
import type { AggFunc, GroupByDim } from '../src/sql/validate.ts'
import type { ResultField } from '../src/result.ts'

/** 允许路由 WT_CUBE 的聚合函数（§14.4 D3：STDDEV/VAR 对预聚合值求方差语义不成立）。 */
const CUBE_ROUTABLE_FUNCS: readonly AggFunc[] = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT']

/** aggregate 工具定义。 */
export const aggregateTool: AskdataTool = {
  name: 'aggregate',
  description:
    '时序聚合查询：SUM/AVG/MAX/MIN/COUNT/STDDEV/VAR，支持按 device/tagcode/时间桶分组。tag_filter 带 1H/1D/1M/1Y 粒度段时自动查聚合表 WT_CUBE。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      tag_filter: { type: 'string', description: "tagName 正则，必须带 ^ 锚定" },
      start_time: { type: 'string', format: 'date-time' },
      end_time: { type: 'string', format: 'date-time' },
      func: { type: 'string', enum: ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'STDDEV', 'VAR'] },
      group_by: {
        type: 'string',
        enum: ['none', 'device', 'tagcode', 'bucket_hour', 'bucket_day', 'bucket_month'],
        description: '分组维度；bucket_* 的时间粒度已内含在维度名中',
      },
      limit: { type: 'integer', description: '1-10000，默认取 system.defaultLimit' },
    },
    required: ['tag_filter', 'start_time', 'end_time', 'func'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(aggregateTool, args, ctx, async (): Promise<SqlPlan> => {
      const tagFilter = validateFilterText(String(args.tag_filter ?? ''))
      validateTimeRange(String(args.start_time ?? ''), String(args.end_time ?? ''), ctx.config.system)
      const func = validateAggFunc(args.func)
      const groupBy = validateGroupBy(args.group_by)
      const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLimit)

      // 字典预查先行（两种路径共用）：确认 filter 命中至少一个 tag
      const preCheckSql = tagIndexByFilterSql(ctx.config, tagFilter)
      assertSafeToExecute(preCheckSql, ctx.config.security.tableWhitelist)
      const preCheck = await ctx.executor.execute(preCheckSql, { signal: ctx.signal })
      if (preCheck.rows.length === 0) {
        throw askdataError('TAG_NOT_FOUND', `tag_filter 未命中任何 tagName: ${tagFilter}`)
      }

      const startIso = String(args.start_time)
      const endIso = String(args.end_time)
      const needsTagName = groupBy === 'device' || groupBy === 'tagcode'
      const filterParts = parseTagFilterPrefix(tagFilter)
      const granularityNum = filterParts
        ? ctx.config.query.granularityMap[filterParts.granularity]
        : undefined
      const cubeEligible =
        ctx.config.query.aggregateTable !== '' &&
        filterParts !== null &&
        granularityNum !== undefined &&
        (CUBE_ROUTABLE_FUNCS as readonly string[]).includes(func)

      // WT_CUBE 路由（在 WT_DATA 扫描护栏之前判定）：实际扫描的是预聚合表（全表仅
      // 数千万行），护栏针对的 WT_DATA 大区间扫描不发生，故路由命中时跳过护栏——
      // 否则长窗口估算本身会把 cube 路由拖死（2026-09-09 真实库实证）。cubeType
      // 唯一性预检：个别 tagCode 对多个 cubeType，口径不唯一则回退 WT_DATA 保守路径。
      if (cubeEligible && filterParts && granularityNum !== undefined) {
        const cubeTypeSql = cubeTypeDistinctSql(ctx.config, {
          tagCode: filterParts.tagCode,
          deviceId: filterParts.deviceId,
          granularity: granularityNum,
        })
        assertSafeToExecute(cubeTypeSql, ctx.config.security.tableWhitelist)
        const cubeTypes = await ctx.executor.execute(cubeTypeSql, { signal: ctx.signal })
        if (cubeTypes.rows.length === 1) {
          const sql = aggregateCubeSql(ctx.config, {
            tagCode: filterParts.tagCode,
            deviceId: filterParts.deviceId,
            startIso,
            endIso,
            func,
            groupBy,
            granularity: granularityNum,
            limit,
          })
          const dimField = dimFieldOf(groupBy)
          return {
            sql,
            params: {
              tag_filter: tagFilter,
              start_time: args.start_time,
              end_time: args.end_time,
              func,
              group_by: groupBy,
              limit,
              routed_to: ctx.config.query.aggregateTable,
              filter_tag_code: filterParts.tagCode,
              filter_device_id: filterParts.deviceId,
            },
            fields: [
              dimField,
              { name: 'aggValue', title: `聚合值(${func})`, type: 'number' },
              { name: 'sampleCount', title: '样本数', type: 'number' },
            ],
            shape: shapeRows(groupBy, dimField),
          }
        }
      }

      // WT_DATA 路径：区间查询前先过扫描护栏（§estimate_count）
      if (ctx.config.security.scanGuard) {
        await assertScanWithinLimit(ctx, startIso, endIso)
      }
      let sql: string
      if (needsTagName) {
        // device/tagcode 分组需要 tagName 列：走 LEFT JOIN WT_TAG 版（WT_DATA 面唯一提供方）
        sql = aggregateSql(ctx.config, {
          tagFilter,
          startIso,
          endIso,
          func,
          groupBy,
          limit,
          badValueMask: ctx.config.system.badValueMask,
        })
      } else {
        sql = aggregateByTagIndexSql(ctx.config, {
          tagFilter,
          startIso,
          endIso,
          func,
          groupBy,
          limit,
          badValueMask: ctx.config.system.badValueMask,
        })
      }
      const dimField = dimFieldOf(groupBy)
      return {
        sql,
        params: {
          tag_filter: tagFilter,
          start_time: args.start_time,
          end_time: args.end_time,
          func,
          group_by: groupBy,
          limit,
          routed_to: ctx.config.tables.data,
          ...(filterParts
            ? { filter_tag_code: filterParts.tagCode, filter_device_id: filterParts.deviceId }
            : {}),
        },
        fields: [
          dimField,
          { name: 'aggValue', title: `聚合值(${func})`, type: 'number' },
          { name: 'sampleCount', title: '样本数', type: 'number' },
        ],
        shape: shapeRows(groupBy, dimField),
      }
    })
  },
}

/** 聚合分组的 dim 字段元数据（三个路径共用）。 */
function dimFieldOf(groupBy: GroupByDim): ResultField {
  if (groupBy === 'device') return { name: 'device', title: '设备', type: 'string' }
  if (groupBy === 'tagcode') return { name: 'tagCode', title: 'tagCode', type: 'string' }
  return { name: 'bucket', title: '时间桶', type: 'datetime' }
}

/** 聚合结果行整形（三个路径共用；分组值透传，聚合值数值化）。 */
function shapeRows(groupBy: GroupByDim, dimField: ResultField) {
  return (rows: Record<string, string | null>[]) =>
    rows.map((r) => ({
      [dimField.name]: groupBy === 'none' ? r.bucket : (r[dimField.name] ?? r.bucket),
      aggValue: toNumber(r.aggValue),
      sampleCount: toNumber(r.sampleCount),
    }))
}
