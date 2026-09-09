/**
 * TSDB HTTP 网关客户端（REST 通道，§14.10 层1）：`iotRealTimeValue` 实时值。
 *
 * 鉴权三头 WT-APPID / WT-OPENID / WT-TOKEN（凭据进程内使用，不进日志）。
 * 网关未部署 / 不可达 / 响应不合法 → 统一抛 `AskdataError(BACKEND_DOWN)`，
 * 由调用方按 `query.rest.fallbackToSql` 决定是否回落 SQL 通道。
 *
 * 说明：网关官方 JSON 形态未完全固化（2026-09-09 实测网关未部署，无法对拍），
 * 解析器按宽容策略接受常见包装（`{code,data}` / `{data:{list}}` / 顶层数组）与
 * 常见字段名（tagName/tagname、value/val、timestamp/time）；解析不出一行有效
 * 数据即视为失败（宁可回落 SQL，不编造结果）。
 * @module
 */

import { askdataError } from '../errors.ts'
import type { QueryConfig, SystemLimits } from '../config.ts'
import type { QueryOutput } from './starrocks.ts'

/** 一次实时值调用允许的最大 tag 数（与 latest_value 的 validateTagNames 上限一致）。 */
const MAX_TAGS_PER_CALL = 1000

/** 从任意 JSON 包装里挖出第一层数组。 */
function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    for (const key of ['data', 'result', 'rows', 'list']) {
      const v = obj[key]
      if (Array.isArray(v)) return v
      if (v !== null && typeof v === 'object') {
        const inner = v as Record<string, unknown>
        for (const k2 of ['list', 'rows', 'records']) {
          if (Array.isArray(inner[k2])) return inner[k2] as unknown[]
        }
      }
    }
  }
  return []
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k]
  }
  return undefined
}

/** 解析 `iotRealTimeValue` 响应为通道无关行（tagName/latestValue/latestTime，与 SQL 路径同形）。 */
export function parseRealtimeValue(payload: unknown): QueryOutput['rows'] {
  const arr = extractArray(payload)
  const rows: QueryOutput['rows'] = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const tagName = pick(row, ['tagName', 'tagname', 'name'])
    if (tagName === undefined) continue
    const value = pick(row, ['value', 'val'])
    const time = pick(row, ['timestamp', 'time', 'ts'])
    rows.push({
      tagName: String(tagName),
      latestValue: value === undefined ? null : String(value),
      latestTime: time === undefined ? null : String(time),
    })
  }
  if (rows.length === 0) {
    throw askdataError('BACKEND_DOWN', 'TSDB REST 网关响应中没有可识别的实时值行（响应形态未对齐）')
  }
  return rows
}

/** REST 通道取一批 tag 的最新值（`GET {baseUrl}/iotRealTimeValue?tagNames=a,b,c`）。 */
export async function fetchLatestValuesViaRest(
  query: QueryConfig,
  tagNames: string[],
  limits: SystemLimits,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<QueryOutput> {
  if (tagNames.length === 0 || tagNames.length > MAX_TAGS_PER_CALL) {
    throw askdataError('INVALID_PARAM', `tag_names 数量必须在 1-${MAX_TAGS_PER_CALL}`)
  }
  const impl = options?.fetchImpl ?? fetch
  const base = query.rest.baseUrl.replace(/\/+$/, '')
  const url = `${base}/iotRealTimeValue?tagNames=${encodeURIComponent(tagNames.join(','))}`
  const headers: Record<string, string> = {
    'WT-APPID': query.rest.wtAppid,
    'WT-OPENID': query.rest.wtOpenid,
    'WT-TOKEN': query.rest.wtToken,
  }

  const timeout = AbortSignal.timeout(limits.queryTimeoutMs)
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let payload: unknown
  try {
    const res = await impl(url, { headers, signal })
    if (!res.ok) {
      throw askdataError('BACKEND_DOWN', `TSDB REST 网关返回 HTTP ${res.status}`)
    }
    payload = await res.json()
  } catch (err) {
    if (err instanceof Error && err.name === 'AskdataError') throw err
    const reason = (err as { cause?: { code?: string }; message?: string })?.cause?.code
      ?? (err instanceof Error ? err.message : String(err))
    throw askdataError('BACKEND_DOWN', `TSDB REST 网关调用失败: ${String(reason).slice(0, 200)}`)
  }
  const rows = parseRealtimeValue(payload)
  return { columns: ['tagName', 'latestValue', 'latestTime'], rows }
}
