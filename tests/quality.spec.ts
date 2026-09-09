import { describe, expect, it } from 'vitest'
import { qualityFilter, decodeQuality } from '../src/sql/quality.ts'

describe('qualityFilter', () => {
  it('默认掩码 128 的三件套谓词', () => {
    expect(qualityFilter('a.`quality`', 128)).toBe('bitand(a.`quality`, 128) != 128')
  })
})

describe('decodeQuality（2 字节 4 nibble，§1.3）', () => {
  it('0 = GOOD/RAWDATA/NORMAL', () => {
    const d = decodeQuality(0)
    expect(d.originalStatus).toBe('GOOD')
    expect(d.dataSrc).toBe('RAWDATA')
    expect(d.curStatus).toBe('NORMAL')
    expect(d.isBad).toBe(false)
  })

  it('128 = BAD（低 nibble bit7）', () => {
    expect(decodeQuality(128).isBad).toBe(true)
    expect(decodeQuality(128).originalStatus).toBe('BAD')
  })

  it('0x0200 = HANDIN 手工录入', () => {
    const d = decodeQuality(0x0200)
    expect(d.isHandInput).toBe(true)
    expect(d.dataSrc).toBe('HANDIN')
  })

  it('0x8000 = 告警态', () => {
    const d = decodeQuality(0x8000)
    expect(d.isAlarm).toBe(true)
    expect(d.curStatus).toBe('HITALARMSCRIPT')
  })

  it('组合位同时识别', () => {
    const d = decodeQuality(0x0200 | 0x8000)
    expect(d.isHandInput).toBe(true)
    expect(d.isAlarm).toBe(true)
  })
})
