import type { QueryOutput } from '../src/clients/starrocks.ts'
import type { SystemLimits } from '../src/config.ts'

/** 测试用系统限额（与 resolveConfig 默认值一致，显式声明避免测试耦合解析器）。 */
export const DEFAULT_LIMITS_FOR_TEST: SystemLimits = {
  maxScanRows: 100_000_000,
  maxTimeRangeDays: 365,
  badValueMask: 128,
  queryTimeoutMs: 15_000,
  maxLimit: 10_000,
  defaultLimit: 1000,
  defaultLookupLimit: 100,
  defaultAlarmLimit: 100,
  timeZone: '+08:00',
}

/** 按 SQL 子串匹配响应的假执行器工厂（未命中即抛错，防止测试静默通过）。 */
export function byIncludes(map: Array<[string, QueryOutput]>): (sql: string) => QueryOutput {
  return (sql) => {
    const hit = map.find(([needle]) => sql.includes(needle))
    if (!hit) throw new Error(`fake executor: 未匹配的 SQL: ${sql.slice(0, 80)}`)
    return hit[1]
  }
}
