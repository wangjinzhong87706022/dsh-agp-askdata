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
