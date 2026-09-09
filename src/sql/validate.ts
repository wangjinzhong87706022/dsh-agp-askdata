/**
 * 工具入参校验（《工具实现规范》§1.1）。
 *
 * 校验失败一律抛 `AskdataError(INVALID_PARAM)`；全部为纯函数，便于穷举测试。
 * @module
 */

import { askdataError } from '../errors.ts'
import type { SystemLimits } from '../config.ts'

/** 校验并规范化时间区间：ISO8601、start < end、跨度 ≤ maxTimeRangeDays。返回毫秒时间戳对。 */
export function validateTimeRange(
  startTime: string,
  endTime: string,
  limits: SystemLimits,
): { startMs: number; endMs: number } {
  const startMs = Date.parse(startTime)
  const endMs = Date.parse(endTime)
  if (Number.isNaN(startMs)) throw askdataError('INVALID_PARAM', `start_time 不是合法 ISO8601 时间: ${startTime}`)
  if (Number.isNaN(endMs)) throw askdataError('INVALID_PARAM', `end_time 不是合法 ISO8601 时间: ${endTime}`)
  if (startMs >= endMs) throw askdataError('INVALID_PARAM', 'start_time 必须早于 end_time')
  const rangeDays = (endMs - startMs) / 86_400_000
  if (rangeDays > limits.maxTimeRangeDays) {
    throw askdataError(
      'EXCEED_LIMIT',
      `时间跨度 ${rangeDays.toFixed(1)} 天超过上限 ${limits.maxTimeRangeDays} 天`,
    )
  }
  return { startMs, endMs }
}

/** SQL/正则注入特征（《工具实现规范》§1.1：禁止 ";"、"--"、"/*"）。 */
const INJECTION_FEATURES = [';', '--', '/*'] as const

/** 校验用户输入的过滤串（tagName 正则 / 关键字）：长度 ≤1024 且无注入特征。 */
export function validateFilterText(value: string, field = 'tag_filter'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw askdataError('INVALID_PARAM', `${field} 不能为空`)
  }
  if (value.length > 1024) {
    throw askdataError('INVALID_PARAM', `${field} 长度超过 1024`)
  }
  for (const feature of INJECTION_FEATURES) {
    if (value.includes(feature)) {
      throw askdataError('INVALID_PARAM', `${field} 含有非法片段 "${feature}"`)
    }
  }
  return value
}

/** 校验 tagName 数组：1-1000 个、自动去重、逐个过格式与注入检查。 */
export function validateTagNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw askdataError('INVALID_PARAM', 'tag_names 必填（1-1000 个）')
  }
  if (value.length > 1000) throw askdataError('INVALID_PARAM', 'tag_names 超过 1000 个上限')
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw askdataError('INVALID_PARAM', 'tag_names 必须全为字符串')
    validateFilterText(item, 'tag_names[]')
    if (item.length > 256) throw askdataError('INVALID_PARAM', `tagName 超过 256 字符: ${item}`)
    seen.add(item)
  }
  return [...seen]
}

/** 校验 limit：1 ≤ limit ≤ limits.maxLimit。 */
export function validateLimit(value: unknown, limits: SystemLimits, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > limits.maxLimit) {
    throw askdataError('INVALID_PARAM', `limit 必须是 1-${limits.maxLimit} 的整数`)
  }
  return n
}

/** SQL 聚合函数白名单（《工具实现规范》§3.3）。 */
export const AGG_FUNCS = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'STDDEV', 'VAR'] as const
export type AggFunc = (typeof AGG_FUNCS)[number]

/** 校验聚合函数名（大小写不敏感，规范化为大写）。 */
export function validateAggFunc(value: unknown): AggFunc {
  const upper = String(value ?? '').toUpperCase()
  if (!(AGG_FUNCS as readonly string[]).includes(upper)) {
    throw askdataError('INVALID_PARAM', `func 必须是 ${AGG_FUNCS.join('/')} 之一`)
  }
  return upper as AggFunc
}

/** aggregate 的 group_by 维度（§3.3）。 */
export const GROUP_BY_DIMS = ['none', 'device', 'tagcode', 'bucket_hour', 'bucket_day', 'bucket_month'] as const
export type GroupByDim = (typeof GROUP_BY_DIMS)[number]

/** 校验 group_by 维度。 */
export function validateGroupBy(value: unknown): GroupByDim {
  const v = String(value ?? 'none')
  if (!(GROUP_BY_DIMS as readonly string[]).includes(v)) {
    throw askdataError('INVALID_PARAM', `group_by 必须是 ${GROUP_BY_DIMS.join('/')} 之一`)
  }
  return v as GroupByDim
}

/** time_series 的时间桶（§3.2）。 */
export const TIME_BUCKETS = ['raw', '1m', '5m', '15m', '1h', '1d'] as const
export type TimeBucket = (typeof TIME_BUCKETS)[number]

/** 校验时间桶。 */
export function validateBucket(value: unknown): TimeBucket {
  const v = String(value ?? '1h')
  if (!(TIME_BUCKETS as readonly string[]).includes(v)) {
    throw askdataError('INVALID_PARAM', `bucket 必须是 ${TIME_BUCKETS.join('/')} 之一`)
  }
  return v as TimeBucket
}

/** WT_TAG.dataType 枚举（0=整型/1=单精度/2=双精度/6=字符串）。 */
export const DATA_TYPES = [0, 1, 2, 6] as const

/** 校验 dataType 枚举，空值返回 undefined。 */
export function validateDataType(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!(DATA_TYPES as readonly number[]).includes(n)) {
    throw askdataError('INVALID_PARAM', `data_type 只允许 ${DATA_TYPES.join('/')}`)
  }
  return n
}

/** tagName 粒度段（§2.3：1O/2O 原始，1H/1D/1M/1Y 派生）。 */
export const GRANULARITIES = ['1O', '2O', '1H', '1D', '1M', '1Y'] as const
export type Granularity = (typeof GRANULARITIES)[number]

/** 校验粒度段。 */
export function validateGranularity(value: unknown): Granularity | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const v = String(value).toUpperCase()
  if (!(GRANULARITIES as readonly string[]).includes(v)) {
    throw askdataError('INVALID_PARAM', `granularity 必须是 ${GRANULARITIES.join('/')} 之一`)
  }
  return v as Granularity
}

/**
 * ISO 时间 → StarRocks 字面量：`'YYYY-MM-DD HH:MM:SS'`（按 timeZone 偏移换算）。
 *
 * 不直接嵌入 ISO 原文——`T`/`Z`/毫秒会破坏 StarRocks 的分区裁剪与时区语义
 * （e2e 实证：ISO 原文导致 COUNT 全表扫 182s）。时区格式必须为 `±HH:MM`。
 * 纯日期输入（`YYYY-MM-DD`）按会话时区的零点取墙钟——Date.parse 会把纯日期
 * 解析为 UTC 零点，直接偏移换算会使"全天"窗口平移数小时。
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_ZONE_RE = /^([+-])(\d{2}):(\d{2})$/

export function toSqlTimestamp(iso: string, timeZone = '+08:00'): string {
  const dateOnly = DATE_ONLY_RE.exec(iso.trim())
  if (dateOnly) return `'${iso.trim()} 00:00:00'`
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw askdataError('INVALID_PARAM', `不是合法 ISO8601 时间: ${iso}`)
  const m = TIME_ZONE_RE.exec(timeZone)
  if (!m) throw askdataError('INVALID_PARAM', `timeZone 必须是 ±HH:MM 格式: ${timeZone}`)
  const offsetMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return `'${shifted.toISOString().slice(0, 19).replace('T', ' ')}'`
}
