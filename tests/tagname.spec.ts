import { describe, expect, it } from 'vitest'
import { parseTagName, buildTagRegexp, parseTagFilterPrefix, splitSegment } from '../src/sql/tagname.ts'
import { AskdataError } from '../src/errors.ts'

describe('parseTagName（四段式，§1.3.1）', () => {
  it('解析三段式生产实例：HWNBYC174_1O_DEV001', () => {
    const parts = parseTagName('HWNBYC174_1O_DEV001')
    expect(parts.tagCode).toBe('HWNBYC174')
    expect(parts.granularity).toBe('1O')
    expect(parts.device).toBe('DEV001')
    expect(parts.pointType).toBe('analog')
    expect(parts.granularityChar).toBe('O')
  })

  it('解析状态量：HWNBYC042_2O_DEV001', () => {
    const parts = parseTagName('HWNBYC042_2O_DEV001')
    expect(parts.pointType).toBe('digit')
  })

  it('解析派生粒度：zcdllsl_1H_100620000005933', () => {
    const parts = parseTagName('zcdllsl_1H_100620000005933')
    expect(parts.tagCode).toBe('zcdllsl')
    expect(parts.granularity).toBe('1H')
    expect(parts.granularityChar).toBe('H')
    expect(parts.device).toBe('100620000005933')
  })

  it('段数不足抛 INVALID_PARAM', () => {
    expect(() => parseTagName('only_two')).toThrow(AskdataError)
  })
})

describe('buildTagRegexp', () => {
  it('正则必须带 ^ 锚定（§1.3.1 三件套）', () => {
    expect(buildTagRegexp('HWNBYC174', '1O')).toBe('^HWNBYC174_1O_')
    expect(buildTagRegexp('zcdllsl')).toBe('^zcdllsl_')
  })

  it('正则元字符按正则语义转义（% _ 是正则字面量，不转义）', () => {
    expect(buildTagRegexp('A%B_C')).toBe('^A%B_C_')
    expect(buildTagRegexp('组串.1')).toBe('^组串\\.1_')
  })
})

describe('parseTagFilterPrefix（WT_CUBE 路由用）', () => {
  it('开式前缀 ^tagCode_粒度_ 解析 tagCode + 粒度', () => {
    expect(parseTagFilterPrefix('^HWNBYC174_1H_')).toEqual({
      tagCode: 'HWNBYC174',
      granularity: '1H',
    })
  })
  it('钉死 device 的前缀解析出 deviceId', () => {
    expect(parseTagFilterPrefix('^HWNBYC174_1D_100620000015524')).toEqual({
      tagCode: 'HWNBYC174',
      granularity: '1D',
      deviceId: '100620000015524',
    })
  })
  it('含正则元字符 / 无粒度段 → null（调用方回退通用路径）', () => {
    expect(parseTagFilterPrefix('^HWNBYC.*_1H_')).toBeNull()
    expect(parseTagFilterPrefix('^no_granularity')).toBeNull()
    expect(parseTagFilterPrefix('HWNBYC174_1H_')).toBeNull()
  })
})

describe('splitSegment', () => {
  it('StarRocks split 为 1 基下标（禁止 0 基）', () => {
    expect(splitSegment('b.tagName', 1)).toBe("split(b.tagName, '_')[1]")
    expect(splitSegment('b.tagName', 3)).toBe("split(b.tagName, '_')[3]")
  })
})
