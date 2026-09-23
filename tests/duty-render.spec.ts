/**
 * 值班报告 HTML 渲染与出闸校验单测：8 段结构、转义、pack_hash 同源、操作令红线。
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { DutyStation } from '../src/config.ts'
import { buildFactPack } from '../src/duty/fact-pack.ts'
import {
  DUTY_SECTION_IDS,
  escapeHtml,
  renderDutyReportHtml,
  validateDutyReportHtml,
} from '../src/duty/render.ts'
import type { DutyFactPack } from '../src/duty/types.ts'

const STATIONS: DutyStation[] = [
  {
    id: 'TQP-DAM-SW',
    name: '桃曲坡水库坝上水位站',
    metrics: [{
      metric: 'water_level', label: '坝上水位', unit: 'm',
      tagName: 'TQPSW001_1O_100620000030001', decimals: 2,
      thresholds: [{ level: '汛限', value: 786.8 }, { level: '警戒', value: 787.5 }],
    }],
  },
]

function packOf(overrides?: Partial<Parameters<typeof buildFactPack>[0]>): DutyFactPack {
  return buildFactPack({
    project: '桃曲坡水库',
    shift: { name: '白班', start: '2026-09-07T08:00', end: '2026-09-07T20:00' },
    stations: STATIONS,
    values: new Map([['TQPSW001_1O_100620000030001', { value: 786.95, time: '2026-09-07 08:00:00' }]]),
    fetchErrors: [],
    reporting: [{ object: '铜川市防汛抗旱指挥部', channel: '防汛专报', frequency: '每 2 小时一次' }],
    citations: [{ document: '03-汛期调度运用计划.pdf', snippet: '主汛期限制水位 786.80m', page: 18, chunkId: null, source: 'auto' }],
    generatedAt: '2026-09-07T20:05:00Z',
    ...overrides,
  })
}

describe('escapeHtml', () => {
  it('五类字符全转义', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
  })
})

describe('renderDutyReportHtml', () => {
  it('8 段结构齐全且 id 固定；标题/时段/工程进报告头', () => {
    const pack = packOf()
    const html = renderDutyReportHtml(pack, { notes: '请接班同志关注雨情' })
    for (const id of DUTY_SECTION_IDS) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('桃曲坡水库防汛值班报告')
    expect(html).toContain('白班')
    expect(html).toContain(pack.packHash)
    expect(html).toContain('请接班同志关注雨情')
  })

  it('观测行带值/单位/观测时间/tagName；超警判定单元格出现', () => {
    const html = renderDutyReportHtml(packOf())
    expect(html).toContain('786.95')
    expect(html).toContain('2026-09-07 08:00:00')
    expect(html).toContain('TQPSW001_1O_100620000030001')
    expect(html).toContain('超汛限')
  })

  it('规则命中与建议全量渲染（advice 禁止压缩），禁则块出现', () => {
    const html = renderDutyReportHtml(packOf())
    expect(html).toContain('TH-TQP-DAM-SW-water_level-汛限')
    expect(html).toContain('黄色')
    expect(html).toContain('禁则')
    expect(html).toContain('不含开闸、关闸、启泵、停泵等任何工程操作令'.slice(0, 8))
  })

  it('插值全转义：测点名带 HTML 不逃逸', () => {
    const pack = packOf({
      stations: [{
        id: 'X', name: '<script>alert(1)</script>站',
        metrics: [{ metric: 'm', label: 'L', unit: 'u', tagName: 'TX_1O_1', thresholds: [] }],
      }],
      values: new Map([['TX_1O_1', { value: 1.5, time: '2026-09-07 08:00:00' }]]),
    })
    const html = renderDutyReportHtml(pack)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  it('缺测：第 2 段显示无观测指引，第 8 段列缺口', () => {
    const pack = packOf({ values: new Map() })
    const html = renderDutyReportHtml(pack)
    expect(html).toContain('本班次无可用观测')
    expect(html).toContain('DATA_MISSING')
  })

  it('内嵌事实包 JSON 可解析还原且 packHash 一致', () => {
    const pack = packOf()
    const html = renderDutyReportHtml(pack)
    const m = /<script type="application\/json" id="duty-fact-pack">([\s\S]*?)<\/script>/.exec(html)
    expect(m).not.toBeNull()
    const decoded = JSON.parse(m![1]!
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
      .replaceAll('&amp;', '&')) as DutyFactPack
    expect(decoded.packHash).toBe(pack.packHash)
    expect(decoded.advice).toHaveLength(pack.advice.length)
  })
})

describe('validateDutyReportHtml', () => {
  it('正常产物通过（无 errors；缺引用给 warning）', () => {
    const pack = packOf({ citations: [] })
    const v = validateDutyReportHtml(renderDutyReportHtml(pack), pack)
    expect(v.valid).toBe(true)
    expect(v.errors).toHaveLength(0)
    expect(v.warnings.some((w) => w.includes('规程'))).toBe(true)
  })

  it('删段 / 破坏 hash / 塞操作令 → 各自报错', () => {
    const pack = packOf()
    const html = renderDutyReportHtml(pack)

    const noGaps = html.replace(/<section id="sec-gaps">[\s\S]*?<\/section>/, '')
    expect(validateDutyReportHtml(noGaps, pack).errors.some((e) => e.includes('sec-gaps'))).toBe(true)

    const noHash = html.replaceAll(pack.packHash, '0'.repeat(16))
    const v2 = validateDutyReportHtml(noHash, pack)
    expect(v2.valid).toBe(false)
    expect(v2.errors.some((e) => e.includes('pack_hash'))).toBe(true)

    const withCommand = html.replace('七、通知与报讯', '七、开闸泄洪')
    const v3 = validateDutyReportHtml(withCommand, pack)
    expect(v3.valid).toBe(false)
    expect(v3.errors.some((e) => e.includes('操作令'))).toBe(true)
  })

  it('advice 条数被压缩 → 报错', () => {
    const pack = packOf()
    const html = renderDutyReportHtml(pack)
    const decoded = JSON.parse((/<script type="application\/json" id="duty-fact-pack">([\s\S]*?)<\/script>/.exec(html))![1]!
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
      .replaceAll('&amp;', '&')) as DutyFactPack
    decoded.advice = decoded.advice.slice(1)
    const tampered = html.replace(
      /(<script type="application\/json" id="duty-fact-pack">)[\s\S]*?(<\/script>)/,
      (_m, p1, p2) => `${p1}${JSON.stringify(decoded).replaceAll('<', '\\u003c')}${p2}`,
    )
    const v = validateDutyReportHtml(tampered, pack)
    expect(v.errors.some((e) => e.includes('建议条数不一致'))).toBe(true)
  })
})
