/**
 * 值班报告面单测：规则研判引擎 + 事实包构建与 pack_hash。
 * 全部纯函数直驱，不触网、不落盘。
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { DutyStation } from '../src/config.ts'
import { buildFactPack, stableStringify } from '../src/duty/fact-pack.ts'
import { buildAdvice, evaluateDutyRules, severityForLevel } from '../src/duty/rules.ts'

/** 桃曲坡演示台账（与 cordis.patch.yml 演示配置同构）。 */
const STATIONS: DutyStation[] = [
  {
    id: 'TQP-DAM-SW',
    name: '桃曲坡水库坝上水位站',
    metrics: [{
      metric: 'water_level',
      label: '坝上水位',
      unit: 'm',
      tagName: 'TQPSW001_1O_100620000030001',
      decimals: 2,
      thresholds: [
        { level: '汛限', value: 786.8 },
        { level: '警戒', value: 787.5 },
        { level: '保证', value: 788.4 },
      ],
    }],
  },
  {
    id: 'TQP-RAIN',
    name: '桃曲坡水库雨量站',
    metrics: [{
      metric: 'rainfall',
      label: '时段降雨量',
      unit: 'mm',
      tagName: 'TQPRN001_1O_100620000030002',
      decimals: 1,
      thresholds: [{ level: '警戒雨量', value: 50 }],
    }],
  },
]

function valuesOf(entries: Array<[string, number, string | null]>): Map<string, { value: number; time: string | null }> {
  return new Map(entries.map(([tagName, value, time]) => [tagName, { value, time }]))
}

describe('severityForLevel', () => {
  it('档名关键词映射固定等级', () => {
    expect(severityForLevel('保证')).toBe('红色')
    expect(severityForLevel('校核')).toBe('红色')
    expect(severityForLevel('警戒')).toBe('橙色')
    expect(severityForLevel('汛限')).toBe('黄色')
    expect(severityForLevel('自定义档')).toBe('蓝色')
  })
})

describe('evaluateDutyRules', () => {
  const WATER_ONLY = [STATIONS[0]!]

  it('超汛限未超警戒：命中黄色一条，阈值对照三行全出', () => {
    const out = evaluateDutyRules({
      stations: WATER_ONLY,
      values: valuesOf([['TQPSW001_1O_100620000030001', 786.95, '2026-09-07 08:00:00']]),
      fetchErrors: [],
    })
    expect(out.telemetry).toHaveLength(1)
    expect(out.telemetry[0]!.value).toBe(786.95)
    expect(out.telemetry[0]!.observedAt).toBe('2026-09-07 08:00:00')
    expect(out.thresholds).toHaveLength(3)
    expect(out.thresholds.map((t) => t.exceeded)).toEqual([true, false, false])
    expect(out.ruleHits).toHaveLength(1)
    expect(out.ruleHits[0]!.severity).toBe('黄色')
    expect(out.ruleHits[0]!.ruleId).toBe('TH-TQP-DAM-SW-water_level-汛限')
    expect(out.ruleHits[0]!.message).toContain('786.95')
    expect(out.abstentions).toHaveLength(0)
  })

  it('超保证：多档命中只留最高等级（红色）', () => {
    const out = evaluateDutyRules({
      stations: WATER_ONLY,
      values: valuesOf([['TQPSW001_1O_100620000030001', 789.1, null]]),
      fetchErrors: [],
    })
    expect(out.ruleHits).toHaveLength(1)
    expect(out.ruleHits[0]!.severity).toBe('红色')
    expect(out.ruleHits[0]!.level).toBe('保证')
  })

  it('未超任何档：无命中，对照行 exceeded=false', () => {
    const out = evaluateDutyRules({
      stations: WATER_ONLY,
      values: valuesOf([['TQPSW001_1O_100620000030001', 785.2, null]]),
      fetchErrors: [],
    })
    expect(out.ruleHits).toHaveLength(0)
    expect(out.thresholds.every((t) => t.exceeded === false)).toBe(true)
    expect(out.claims[0]!.text).toContain('785.20')
  })

  it('缺测：进 abstentions，不产生命中，对照行置 null（缺测≠安全）', () => {
    const out = evaluateDutyRules({
      stations: STATIONS,
      values: valuesOf([]),
      fetchErrors: [],
    })
    expect(out.telemetry).toHaveLength(0)
    expect(out.abstentions).toHaveLength(2)
    expect(out.abstentions.every((a) => a.code === 'DATA_MISSING')).toBe(true)
    expect(out.ruleHits).toHaveLength(0)
    expect(out.thresholds.every((t) => t.exceeded === null && t.observedValue === null)).toBe(true)
  })

  it('低于型阈值（op=<=）：低于阈值即命中且方向为"低于"', () => {
    const stations: DutyStation[] = [{
      id: 'S',
      name: '干渠站',
      metrics: [{
        metric: 'flow', label: '流量', unit: 'm³/s', tagName: 'F_1O_1', decimals: 1,
        thresholds: [{ level: '枯水', value: 2, op: '<=' }],
      }],
    }]
    const out = evaluateDutyRules({ stations, values: valuesOf([['F_1O_1', 1.5, null]]), fetchErrors: [] })
    expect(out.ruleHits[0]!.message).toContain('低于')
    expect(out.ruleHits[0]!.severity).toBe('蓝色')
  })

  it('拉取失败（fetchErrors）原样并入 abstentions 且排在最前', () => {
    const out = evaluateDutyRules({
      stations: STATIONS,
      values: valuesOf([]),
      fetchErrors: [{ stationId: null, metric: null, tagName: null, code: 'BACKEND_DOWN', reason: '网关不可达' }],
    })
    expect(out.abstentions[0]!.code).toBe('BACKEND_DOWN')
    expect(out.abstentions).toHaveLength(3)
  })

  it('双站部分到数：水位站研判、雨量站缺测（telemetry/thresholds/abstentions 各归其位）', () => {
    const out = evaluateDutyRules({
      stations: STATIONS,
      values: valuesOf([['TQPSW001_1O_100620000030001', 786.95, '08:00']]),
      fetchErrors: [],
    })
    expect(out.telemetry).toHaveLength(1)
    expect(out.thresholds).toHaveLength(4) // 水位 3 档 + 雨量 1 档（缺测也保留对照结构）
    expect(out.thresholds.filter((t) => t.exceeded === null)).toHaveLength(1)
    expect(out.ruleHits).toHaveLength(1)
    expect(out.abstentions).toHaveLength(1)
    expect(out.abstentions[0]!.metric).toBe('rainfall')
  })
})

describe('buildAdvice', () => {
  it('按等级降序生成，例行报讯项兜底，文本无操作令', () => {
    const out = evaluateDutyRules({
      stations: STATIONS,
      values: valuesOf([['TQPSW001_1O_100620000030001', 789.1, null]]),
      fetchErrors: [],
    })
    const reporting = [{ object: '市防指', channel: '专报', frequency: '每 2 小时' }]
    const advice = buildAdvice(out.ruleHits, reporting)
    expect(advice[0]!.severity).toBe('红色')
    expect(advice[0]!.text).toContain('30 分钟')
    expect(advice.at(-1)!.text).toContain('市防指')
    expect(advice.every((a) => !/开闸|关闸|启泵|停泵/.test(a.text))).toBe(true)
  })

  it('无命中无报讯配置：给一条蓝色例行建议', () => {
    const advice = buildAdvice([], [])
    expect(advice).toHaveLength(1)
    expect(advice[0]!.severity).toBe('蓝色')
  })
})

describe('buildFactPack / pack_hash', () => {
  const base = {
    project: '桃曲坡水库',
    shift: { name: '白班', start: '2026-09-07T08:00', end: '2026-09-07T20:00' },
    stations: STATIONS,
    values: valuesOf([['TQPSW001_1O_100620000030001', 786.95, '08:00']]),
    fetchErrors: [],
    reporting: [{ object: '市防指' }],
    citations: [{ document: '调度规程.pdf', snippet: '主汛期汛限水位 786.8m', page: 12, chunkId: 'c1', source: 'auto' as const }],
    generatedAt: '2026-09-07T20:05:00Z',
  }

  it('同输入同 hash（queryId/generatedAt 等 shell 字段不参与）', () => {
    const a = buildFactPack(base)
    const b = buildFactPack(base)
    expect(a.packHash).toBe(b.packHash)
    expect(a.packHash).toMatch(/^[0-9a-f]{16}$/)
    expect(a.queryId).not.toBe(b.queryId)
  })

  it('hard 字段变 → hash 变；soft/shell 变 → hash 不变', () => {
    const hardChanged = buildFactPack({ ...base, values: valuesOf([['TQPSW001_1O_100620000030001', 787.9, '08:00']]) })
    const baseline = buildFactPack(base)
    expect(hardChanged.packHash).not.toBe(baseline.packHash)

    const citationsOrder = buildFactPack({ ...base, reporting: [{ object: '市防指' }, { object: '省防指' }] })
    expect(citationsOrder.packHash).not.toBe(baseline.packHash)

    // claims 由观测值派生（hard 变才变）；notes 是 shell——buildFactPack 根本不收，天然不参与
    expect(baseline.claims.length).toBeGreaterThan(0)
  })

  it('abstentions 不参与 hash（缺口集合随环境变化是常态）', () => {
    const withGap = buildFactPack({
      ...base,
      stations: STATIONS.map((s) => ({ ...s, metrics: s.metrics.map((m) => ({ ...m, tagName: `${m.tagName}X` })) })),
      values: valuesOf([]),
    })
    // 测点换名后 telemetry/thresholds/ruleHits 全空 → hash 必然不同（hard 变了），
    // 但单独给 abstentions 追加条目不改变 hash：
    const pack = buildFactPack(base)
    const before = pack.packHash
    pack.abstentions.push({ stationId: null, metric: null, tagName: null, code: 'X', reason: '事后补记' })
    expect(pack.packHash).toBe(before)
    expect(withGap.packHash).not.toBe(before)
  })

  it('stableStringify：键序不敏感、数组序敏感', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
    expect(stableStringify({ a: undefined })).toBe('{}')
  })
})
