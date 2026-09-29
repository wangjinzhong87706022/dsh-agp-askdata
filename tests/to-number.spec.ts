/**
 * toNumber 闸门单测：网关/SQL 通道的字符串值 → number | null。
 * 红线背景：Number('')/Number(' ')=0、Number('Infinity')=Infinity、Number('0x10')=16
 * 都会把非数值静默变成可用观测值（值班报告缺测不编造红线，latest_value 同源）。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { toNumber } from '../tools/types.ts'

describe('toNumber', () => {
  it('合法十进制形态：数值、带符号、小数、科学计数、首尾空白', () => {
    expect(toNumber('787.62')).toBe(787.62)
    expect(toNumber('-3.5')).toBe(-3.5)
    expect(toNumber('+12')).toBe(12)
    expect(toNumber('.5')).toBe(0.5)
    expect(toNumber('12.')).toBe(12)
    expect(toNumber('1e3')).toBe(1000)
    expect(toNumber('2.5E-2')).toBe(0.025)
    expect(toNumber('  787.62  ')).toBe(787.62)
    expect(toNumber('0')).toBe(0)
  })

  it('null/undefined → null（不产出 0）', () => {
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
  })

  it('JSON number 原生值直通（meta 面行形态），非有限数 → null', () => {
    expect(toNumber(787.62)).toBe(787.62)
    expect(toNumber(0)).toBe(0)
    expect(toNumber(Number.NaN)).toBeNull()
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('空串/纯空白 → null（Number(\'\')=0 陷阱）', () => {
    expect(toNumber('')).toBeNull()
    expect(toNumber(' ')).toBeNull()
    expect(toNumber('\t')).toBeNull()
  })

  it('非数值串 → null', () => {
    expect(toNumber('N/A')).toBeNull()
    expect(toNumber('12abc')).toBeNull()
    expect(toNumber('0.1.2')).toBeNull()
  })

  it('非十进制/非有限形态 → null（hex 静默变 16、Infinity 放行都是假观测）', () => {
    expect(toNumber('0x10')).toBeNull()
    expect(toNumber('Infinity')).toBeNull()
    expect(toNumber('-Infinity')).toBeNull()
    expect(toNumber('NaN')).toBeNull()
    expect(toNumber('1e999')).toBeNull() // 正则通过但超有限范围
  })
})
