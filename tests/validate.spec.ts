import { describe, expect, it } from 'vitest'
import {
  validateTimeRange,
  validateFilterText,
  validateTagNames,
  validateLimit,
  validateAggFunc,
  validateGroupBy,
  validateBucket,
  validateDataType,
  validateGranularity,
  toSqlTimestamp,
} from '../src/sql/validate.ts'
import { AskdataError } from '../src/errors.ts'
import { DEFAULT_LIMITS_FOR_TEST } from './helpers.ts'

const limits = DEFAULT_LIMITS_FOR_TEST

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(AskdataError)
    expect((err as AskdataError).code).toBe(code)
  }
}

describe('validateTimeRange', () => {
  it('合法区间通过', () => {
    expect(() => validateTimeRange('2026-08-01T00:00:00+08:00', '2026-08-02T00:00:00+08:00', limits)).not.toThrow()
  })
  it('非法时间 / 倒序 / 超跨度', () => {
    expectCode(() => validateTimeRange('not-a-time', '2026-08-02T00:00:00Z', limits), 'INVALID_PARAM')
    expectCode(() => validateTimeRange('2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z', limits), 'INVALID_PARAM')
    expectCode(
      () => validateTimeRange('2025-01-01T00:00:00Z', '2026-08-01T00:00:00Z', limits),
      'EXCEED_LIMIT',
    )
  })
})

describe('validateFilterText', () => {
  it('正常正则通过', () => {
    expect(validateFilterText('^HWNBYC174_1O_')).toBe('^HWNBYC174_1O_')
  })
  it('注入特征拒绝（; -- /*）', () => {
    expectCode(() => validateFilterText("x'; DROP TABLE t"), 'INVALID_PARAM')
    expectCode(() => validateFilterText('a --comment'), 'INVALID_PARAM')
    expectCode(() => validateFilterText('a /*b'), 'INVALID_PARAM')
  })
  it('超长拒绝', () => {
    expectCode(() => validateFilterText('a'.repeat(1025)), 'INVALID_PARAM')
  })
})

describe('validateTagNames', () => {
  it('去重并保序', () => {
    expect(validateTagNames(['a_1O_D1', 'a_1O_D1', 'b_2O_D2'])).toEqual(['a_1O_D1', 'b_2O_D2'])
  })
  it('空数组 / 非字符串 / 超 1000 拒绝', () => {
    expectCode(() => validateTagNames([]), 'INVALID_PARAM')
    expectCode(() => validateTagNames([1]), 'INVALID_PARAM')
    expectCode(() => validateTagNames(Array.from({ length: 1001 }, (_, i) => `t${i}`)), 'INVALID_PARAM')
  })
})

describe('toSqlTimestamp', () => {
  it('完整 ISO 按 timeZone 偏移换算', () => {
    expect(toSqlTimestamp('2026-08-01T00:00:00+08:00')).toBe("'2026-08-01 00:00:00'")
    expect(toSqlTimestamp('2026-08-01T00:00:00Z', '+08:00')).toBe("'2026-08-01 08:00:00'")
    expect(toSqlTimestamp('2026-08-01T05:00:00Z', '-05:00')).toBe("'2026-08-01 00:00:00'")
  })
  it('纯日期按会话时区零点取墙钟（不被 Date.parse 拉到 UTC 零点）', () => {
    expect(toSqlTimestamp('2026-08-01')).toBe("'2026-08-01 00:00:00'")
  })
  it('非法时区格式抛 INVALID_PARAM（不静默按 UTC）', () => {
    expectCode(() => toSqlTimestamp('2026-08-01T00:00:00Z', 'Asia/Shanghai'), 'INVALID_PARAM')
  })
})

describe('枚举与数值', () => {
  it('limit 边界', () => {
    expect(validateLimit(undefined, limits, 1000)).toBe(1000)
    expect(validateLimit(5, limits, 1000)).toBe(5)
    expectCode(() => validateLimit(0, limits, 1000), 'INVALID_PARAM')
    expectCode(() => validateLimit(10001, limits, 1000), 'INVALID_PARAM')
  })
  it('聚合函数大小写规范化', () => {
    expect(validateAggFunc('avg')).toBe('AVG')
    expectCode(() => validateAggFunc('MEDIAN'), 'INVALID_PARAM')
  })
  it('group_by / bucket / dataType / granularity', () => {
    expect(validateGroupBy(undefined)).toBe('none')
    expectCode(() => validateGroupBy('week'), 'INVALID_PARAM')
    expect(validateBucket('1h')).toBe('1h')
    expectCode(() => validateBucket('2h'), 'INVALID_PARAM')
    expect(validateDataType('6')).toBe(6)
    expectCode(() => validateDataType(3), 'INVALID_PARAM')
    expect(validateGranularity('1o')).toBe('1O')
    expect(validateGranularity(undefined)).toBeUndefined()
  })
})
