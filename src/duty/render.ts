/**
 * 值班报告 HTML 渲染（对照《防汛值班报告 Agent 规划清单》§五 8 段结构）。
 *
 * 单文件、内联 CSS、零外链资源：离线可打开、可打印、可归档。所有插值经
 * escapeHtml；hard 字段全部来自 fact_pack（与对话摘要、pack_hash 同源）。
 * 渲染产物内嵌 `<script type="application/json" id="duty-fact-pack">`——
 * 报告文件自身携带机器可读事实包，归档后仍可复验 pack_hash。
 *
 * 零依赖：模板字面量拼装（核心保持零 npm 运行时依赖，不引 jinja 类模板引擎）。
 * @module
 */

import type { DutyFactPack, DutyValidation } from './types.ts'
import { stableStringify } from './fact-pack.ts'

/** HTML 转义（报告全部插值必经；防测站名/片段里的标签逃逸）。 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fmt(value: number, decimals: number): string {
  return value.toFixed(Math.min(8, Math.max(0, decimals)))
}

function severityClass(severity: string): string {
  switch (severity) {
    case '红色': return 'sev-red'
    case '橙色': return 'sev-orange'
    case '黄色': return 'sev-yellow'
    default: return 'sev-blue'
  }
}

/** 8 段结构的锚点 id（出闸校验与测试共用）。 */
export const DUTY_SECTION_IDS = [
  'sec-head',
  'sec-telemetry',
  'sec-thresholds',
  'sec-rules',
  'sec-advice',
  'sec-citations',
  'sec-reporting',
  'sec-gaps',
] as const

/** 操作令负面清单（红线：全文不得出现开闸/关闸/启泵等命令式措辞）。 */
export const OPERATION_COMMAND_RE = /(开闸|关闸|启泵|停泵|开泵|关泵|开启闸门|关闭闸门|启动水泵|停止水泵)/

/**
 * 渲染值班报告单文件 HTML。
 *
 * @param pack 事实包（唯一数据源；渲染不增删 hard 字段）
 * @param options.title 报告标题覆盖（shell 层）
 * @param options.notes 交接事项补充（shell 层，进第 8 段）
 */
export function renderDutyReportHtml(
  pack: DutyFactPack,
  options?: { title?: string; notes?: string },
): string {
  const title = options?.title?.trim() || `${pack.project}防汛值班报告`
  const period = `${pack.shift.start} ~ ${pack.shift.end}${pack.shift.name ? `（${pack.shift.name}）` : ''}`
  const generated = pack.generatedAt.slice(0, 19)

  const telemetryRows = pack.telemetry.map((t) => `
      <tr><td>${escapeHtml(t.stationName)}</td><td>${escapeHtml(t.label)}</td>
      <td class="num">${fmt(t.value, t.decimals)}</td><td>${escapeHtml(t.unit)}</td>
      <td>${escapeHtml(t.observedAt ?? '—')}</td><td class="mono">${escapeHtml(t.tagName)}</td></tr>`).join('\n')

  const thresholdRows = pack.thresholds.map((t) => {
    const verdict = t.exceeded === null
      ? '<span class="tag tag-na">缺测</span>'
      : t.exceeded
        ? `<span class="tag tag-hit">超${escapeHtml(t.level)}</span>`
        : '<span class="tag tag-ok">未超</span>'
    return `
      <tr><td>${escapeHtml(t.stationName)}</td><td>${escapeHtml(t.label)}</td>
      <td>${escapeHtml(t.level)}</td><td class="num">${fmt(t.thresholdValue, 2)}</td>
      <td class="num">${t.observedValue === null ? '—' : fmt(t.observedValue, 2)}</td>
      <td>${verdict}</td></tr>`
  }).join('\n')

  const ruleBlock = pack.ruleHits.length === 0
    ? '      <p class="muted">本班次无阈值命中。</p>'
    : `<ul class="hits">\n${pack.ruleHits.map((h) => `        <li><span class="tag ${severityClass(h.severity)}">${escapeHtml(h.severity)}预警</span>
          <strong>${escapeHtml(h.message)}</strong><span class="muted">（规则 ${escapeHtml(h.ruleId)}；证据：${escapeHtml(h.evidence)}）</span></li>`).join('\n')}\n      </ul>`

  const adviceItems = pack.advice.map((a) => `        <li class="${severityClass(a.severity)}"><span class="tag ${severityClass(a.severity)}">${escapeHtml(a.severity)}</span>
          ${escapeHtml(a.text)}<span class="muted">${a.basisRuleId ? `（依据 ${escapeHtml(a.basisRuleId)}）` : '（例行）'}</span></li>`).join('\n')

  const citationItems = pack.citations.length === 0
    ? '      <p class="muted">本班次未引用规程条文（见第 8 段缺口说明）。</p>'
    : `<ol class="cites">\n${pack.citations.map((c) => `        <li>《${escapeHtml(c.document)}》${c.page !== null ? `第 ${c.page} 页` : ''}："${escapeHtml(c.snippet)}"</li>`).join('\n')}\n      </ol>`

  const reportingRows = pack.reporting.length === 0
    ? '      <p class="muted">未配置报讯路径（duty.reporting）。</p>'
    : `<table class="grid">\n      <thead><tr><th>通知对象</th><th>通道</th><th>频次</th></tr></thead><tbody>\n${pack.reporting.map((r) => `        <tr><td>${escapeHtml(r.object)}</td><td>${escapeHtml(r.channel ?? '—')}</td><td>${escapeHtml(r.frequency ?? '—')}</td></tr>`).join('\n')}\n      </tbody></table>`

  const gapItems = pack.abstentions.length === 0
    ? '      <p class="muted">本班次无数据缺口。</p>'
    : `<ul class="gaps">\n${pack.abstentions.map((a) => `        <li><span class="mono">[${escapeHtml(a.code)}]</span> ${escapeHtml(a.stationId ?? '')}${a.metric ? ` / ${escapeHtml(a.metric)}` : ''}：${escapeHtml(a.reason)}</li>`).join('\n')}\n      </ul>`
  const notesBlock = options?.notes?.trim()
    ? `      <p><strong>交接事项（人工补充）：</strong>${escapeHtml(options.notes.trim())}</p>`
    : ''

  const claimsList = pack.claims.map((c) => escapeHtml(c.text)).join('；')
  const embedded = escapeHtml(stableStringify(pack))

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:"Microsoft YaHei","PingFang SC",SimSun,sans-serif;margin:0;color:#1a1a1a;background:#f5f5f2}
  .sheet{max-width:960px;margin:0 auto;padding:32px 40px;background:#fff;min-height:100vh}
  h1{font-size:22px;border-bottom:3px double #333;padding-bottom:10px;letter-spacing:2px}
  h2{font-size:16px;margin:28px 0 8px;border-left:4px solid #1a5276;padding-left:8px}
  table.grid{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}
  table.grid th,table.grid td{border:1px solid #999;padding:5px 8px;text-align:left}
  table.grid th{background:#eef2f5}
  td.num,td.mono{text-align:right;font-variant-numeric:tabular-nums}
  td.mono{font-family:Consolas,monospace;font-size:12px}
  .meta{font-size:13px;color:#444;line-height:1.9;margin-top:10px}
  .meta b{color:#000}
  .tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:9px;margin-right:6px;border:1px solid}
  .tag-hit{color:#fff;background:#c0392b;border-color:#c0392b}
  .tag-ok{color:#1e8449;border-color:#1e8449}
  .tag-na{color:#666;border-color:#999;background:#f0f0f0}
  .sev-red .tag{color:#fff;background:#c0392b;border-color:#c0392b}
  .sev-orange .tag{color:#fff;background:#d35400;border-color:#d35400}
  .sev-yellow .tag{color:#7d6608;background:#fcf3cf;border-color:#d4ac0d}
  .sev-blue .tag{color:#1a5276;border-color:#1a5276}
  ul.hits,ol.cites,ul.gaps{font-size:13px;line-height:1.9;padding-left:22px}
  li.sev-red{color:#7b241c}li.sev-orange{color:#9c4221}
  .muted{color:#777;font-size:12px}
  .constraint{background:#fdf2e9;border:1px solid #e59866;padding:8px 12px;font-size:13px;border-radius:4px}
  footer{margin-top:40px;border-top:1px solid #ccc;padding-top:10px;font-size:12px;color:#666}
  footer .hash{font-family:Consolas,monospace}
  @media print{body{background:#fff}.sheet{padding:0}h2{page-break-after:avoid}table.grid{page-break-inside:avoid}}
</style>
</head>
<body>
<div class="sheet">
  <section id="sec-head">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <div>值班时段：<b>${escapeHtml(period)}</b></div>
      <div>工程/河段：<b>${escapeHtml(pack.project)}</b>　编制时间：${escapeHtml(generated)}</div>
      <div>性质说明：本报告为值班研判产物（自动生成 + 规则引擎研判），只提供建议与预警等级，不含调度操作令。</div>
      <div>事实包哈希：<b class="hash">${escapeHtml(pack.packHash)}</b>　任务号：<span class="hash">${escapeHtml(pack.queryId)}</span></div>
    </div>
  </section>

  <section id="sec-telemetry">
    <h2>二、测站监测汇总</h2>
    ${pack.telemetry.length === 0 ? '<p class="muted">本班次无可用观测（见第 8 段缺口）。</p>' : `<table class="grid">
      <thead><tr><th>测站</th><th>指标</th><th>数值</th><th>单位</th><th>观测时间</th><th>AGP 测点</th></tr></thead><tbody>${telemetryRows}
      </tbody></table>`}
  </section>

  <section id="sec-thresholds">
    <h2>三、阈值对照</h2>
    ${thresholdRows.length === 0 ? '<p class="muted">未配置阈值档（duty.stations[].metrics[].thresholds）。</p>' : `<table class="grid">
      <thead><tr><th>测站</th><th>指标</th><th>档位</th><th>阈值</th><th>观测值</th><th>判定</th></tr></thead><tbody>${thresholdRows}
      </tbody></table>`}
  </section>

  <section id="sec-rules">
    <h2>四、预警与规则研判</h2>
${ruleBlock}
  </section>

  <section id="sec-advice">
    <h2>五、研判建议</h2>
    <ol class="hits">
${adviceItems}
    </ol>
    <p class="constraint">禁则：${escapeHtml(pack.constraints[0] ?? '')}</p>
  </section>

  <section id="sec-citations">
    <h2>六、规程依据</h2>
${citationItems}
  </section>

  <section id="sec-reporting">
    <h2>七、通知与报讯</h2>
${reportingRows}
  </section>

  <section id="sec-gaps">
    <h2>八、数据缺口与交接</h2>
${gapItems}
${notesBlock}
    <p class="muted">态势概述（soft 层，允许同义转述）：${claimsList || '无'}。</p>
  </section>

  <footer>
    <span>本报告由 dsh-agp-askdata 值班报告面自动生成（数据源：AGP API 实时值 + RAGFlow 规程知识库）。</span>
    <div>pack_hash：<span class="hash">${escapeHtml(pack.packHash)}</span>（hard 字段稳定哈希；校验：${DUTY_SECTION_IDS.length} 段结构 + 哈希一致 + 无操作令）</div>
  </footer>
</div>
<script type="application/json" id="duty-fact-pack">${embedded}</script>
</body>
</html>
`
}

/**
 * 报告出闸校验（对照规划清单 `duty-report-verifier`）：
 * 8 段结构齐全、页脚/内嵌事实包与 pack_hash 一致、研判建议全量渲染、无操作令。
 * `html` 为渲染产物；`pack` 为源事实包（同一工具调用内自校验，跨工具传入亦支持）。
 */
export function validateDutyReportHtml(html: string, pack: DutyFactPack): DutyValidation {
  const errors: string[] = []
  const warnings: string[] = []

  for (const id of DUTY_SECTION_IDS) {
    if (!html.includes(`id="${id}"`)) errors.push(`缺少报告段: #${id}`)
  }
  if (!html.includes(pack.packHash)) errors.push(`HTML 未包含 pack_hash ${pack.packHash}（页脚或内嵌事实包缺失）`)

  const embeddedMatch = /<script type="application\/json" id="duty-fact-pack">([\s\S]*?)<\/script>/.exec(html)
  if (!embeddedMatch) {
    errors.push('内嵌事实包 <script id="duty-fact-pack"> 缺失')
  } else {
    try {
      const embeddedRaw = embeddedMatch[1] ?? ''
      const decoded = JSON.parse(embeddedRaw
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&')) as DutyFactPack
      if (decoded.packHash !== pack.packHash) errors.push(`内嵌事实包 pack_hash 不一致: ${decoded.packHash} != ${pack.packHash}`)
      if (decoded.advice.length !== pack.advice.length) errors.push(`研判建议条数不一致: ${decoded.advice.length} != ${pack.advice.length}（advice 禁止压缩）`)
      // 键序不敏感比较（内嵌 JSON 是键排序的 canonical 形态，源对象是构造序）。
      if (stableStringify(decoded.telemetry) !== stableStringify(pack.telemetry)) errors.push('内嵌事实包 telemetry 与源不一致')
    } catch (err) {
      errors.push(`内嵌事实包不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 操作令检查跑在去标签文本上；两处豁免：① 禁则声明块（第 5 段 constraint）本身
  // 含"开闸…"字样但那是红线陈述不是命令；② 内嵌事实包 JSON（含禁则原文的机器可读副本）。
  // advice/正文其余部分仍然全检。
  const text = html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<p class="constraint">[\s\S]*?<\/p>/g, '')
    .replace(/<[^>]+>/g, ' ')
  const commandMatch = OPERATION_COMMAND_RE.exec(text)
  if (commandMatch !== null) {
    errors.push(`正文出现操作令措辞"${commandMatch[1] ?? commandMatch[0]}"（红线：只出研判建议）`)
  }

  if (pack.telemetry.length === 0) warnings.push('本班次无任何可用观测，报告仅有缺口信息')
  if (pack.citations.length === 0) warnings.push('未引用任何规程条文')
  return { valid: errors.length === 0, errors, warnings }
}
