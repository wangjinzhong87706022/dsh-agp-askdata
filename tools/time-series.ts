/**
 * `time_series`（P0, base_business）：时序明细 / 时间桶聚合查询（§3.2）。
 * @module
 */

import { askdataError } from '../src/errors.ts'
import { estimateScanSql, tagIndexByFilterSql, timeSeriesByTagIndexSql } from '../src/sql/templates.ts'
import { assertSafeToExecute } from '../src/sql/whitelist.ts'
import {
  validateBucket,
  validateFilterText,
  validateLimit,
  validateTimeRange,
} from '../src/sql/validate.ts'
import { runSqlTool, toNumber, type AskdataTool, type SqlPlan, type ToolContext } from './types.ts'

/** 区间查询前的扫描护栏（§estimate_count：超 maxScanRows 拒绝返回明细）。 */
export async function assertScanWithinLimit(
  ctx: ToolContext,
  startIso: string,
  endIso: string,
): Promise<number> {
  const out = await ctx.executor.execute(estimateScanSql(ctx.config, startIso, endIso), { signal: ctx.signal })
  const scanRows = Number(out.rows[0]?.scanRows ?? 0)
  if (scanRows > ctx.config.system.maxScanRows) {
    throw askdataError(
      'EXCEED_LIMIT',
      `扫描行数估算 ${scanRows} 超过上限 ${ctx.config.system.maxScanRows}，请缩小时间范围或加大聚合粒度`,
    )
  }
  return scanRows
}

/** time_series 工具定义。 */
export const timeSeriesTool: AskdataTool = {
  name: 'time_series',
  description:
    '时序明细查询，按时间桶聚合（raw/1m/5m/15m/1h/1d，默认 1h）。输入 tagName 正则（带 ^ 锚定）与时间区间。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      tag_filter: { type: 'string', description: "tagName 正则，必须带 ^ 锚定，如 '^HWNBYC174_1O_'" },
      start_time: { type: 'string', format: 'date-time' },
      end_time: { type: 'string', format: 'date-time' },
      bucket: { type: 'string', enum: ['raw', '1m', '5m', '15m', '1h', '1d'] },
      limit: { type: 'integer', description: '1-10000，默认 1000' },
    },
    required: ['tag_filter', 'start_time', 'end_time'],
  },
  async run(args, ctx: ToolContext) {
    return runSqlTool(timeSeriesTool, args, ctx, async (): Promise<SqlPlan> => {
      const tagFilter = validateFilterText(String(args.tag_filter ?? ''))
      validateTimeRange(String(args.start_time ?? ''), String(args.end_time ?? ''), ctx.config.system)
      const bucket = validateBucket(args.bucket)
      const limit = validateLimit(args.limit, ctx.config.system, ctx.config.system.defaultLimit)
      if (ctx.config.security.scanGuard) {
        await assertScanWithinLimit(ctx, String(args.start_time), String(args.end_time))
      }
      // tagIndex 预查：确认 filter 命中至少一个 tag，否则提前返回 TAG_NOT_FOUND
      const preCheckSql = tagIndexByFilterSql(ctx.config, tagFilter)
      assertSafeToExecute(preCheckSql, ctx.config.security.tableWhitelist)
      const preCheck = await ctx.executor.execute(preCheckSql, { signal: ctx.signal })
      if (preCheck.rows.length === 0) {
        throw askdataError('TAG_NOT_FOUND', `tag_filter 未命中任何 tagName: ${tagFilter}`)
      }
      const sql = timeSeriesByTagIndexSql(ctx.config, {
        tagFilter,
        startIso: String(args.start_time),
        endIso: String(args.end_time),
        bucket,
        limit,
        badValueMask: ctx.config.system.badValueMask,
      })
      return {
        sql,
        params: { tag_filter: tagFilter, start_time: args.start_time, end_time: args.end_time, bucket, limit },
        fields:
          bucket === 'raw'
            ? [
                { name: 'timestamp', title: '时间', type: 'datetime' },
                { name: 'value', title: '工程量值', type: 'number' },
                { name: 'quality', title: '质量码', type: 'number' },
              ]
            : [
                { name: 'bucket', title: '时间桶', type: 'datetime' },
                { name: 'avgValue', title: '均值', type: 'number' },
                { name: 'minValue', title: '最小值', type: 'number' },
                { name: 'maxValue', title: '最大值', type: 'number' },
                { name: 'sampleCount', title: '样本数', type: 'number' },
              ],
        shape: (rows) =>
          bucket === 'raw'
            ? rows.map((r) => ({
                timestamp: r.timestamp,
                value: toNumber(r.value),
                quality: toNumber(r.quality),
              }))
            : rows.map((r) => ({
                bucket: r.bucket,
                avgValue: toNumber(r.avgValue),
                minValue: toNumber(r.minValue),
                maxValue: toNumber(r.maxValue),
                sampleCount: toNumber(r.sampleCount),
              })),
      }
    })
  },
}
