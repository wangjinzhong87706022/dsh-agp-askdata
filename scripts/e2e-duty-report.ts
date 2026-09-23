/**
 * 值班报告面 E2E（工具级，直驱 createAskdataService，不依赖 DSH web / LLM）。
 *
 * 前置：`node scripts/mock-agp-api.mjs 8410` 已启动（mock AGP API 网关）。
 * 可选环境变量：RAGFLOW_API_KEY + duty.datasetIds 走真实 RAGFlow（否则规程引用
 * 按缺口渲染——不影响本 E2E 的结构断言）。
 *
 * 验收（对照《防汛值班报告 Agent 规划清单》十三）：
 *   1. list_duty_stations 台账投影
 *   2. generate_duty_report：AGP API 取数（无 SQL）→ 超警戒命中 → 8 段 HTML 落盘
 *   3. HTML 单文件离线可开：无外链资源、内嵌 fact-pack、页脚 hash 一致、无操作令
 *   4. 浏览器级再验证（file:// 打开 + 截图）由 Playwright 脚本接力
 *
 * 用法：node_modules/.bin/tsx scripts/e2e-duty-report.ts
 * @module
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAskdataService } from '../src/index.ts'
import { renderDutyReportHtml, validateDutyReportHtml } from '../src/duty/render.ts'

const MOCK_BASE = process.env.MOCK_AGP_BASE ?? 'http://127.0.0.1:8410/iot-etl/iot'
const OUTPUT_DIR = await mkdtemp(join(tmpdir(), 'duty-e2e-'))

const service = createAskdataService({
  connection: { host: 'unused-for-duty', port: 9030, user: 'u', password: 'p', database: 'WT_DB' },
  knowledge: {
    datasetIds: (process.env.RAGFLOW_DATASET_IDS ?? '').split(',').filter(Boolean),
    ...(process.env.RAGFLOW_BASE_URL ? { ragflowBaseUrl: process.env.RAGFLOW_BASE_URL } : {}),
  },
  query: { rest: { baseUrl: MOCK_BASE, wtOpenid: 'e2e-openid', wtToken: 'e2e-token', fallbackToSql: false } },
  duty: {
    project: '桃曲坡水库',
    outputDir: OUTPUT_DIR,
    stations: [
      {
        id: 'TQP-DAM-SW', name: '桃曲坡水库坝上水位站',
        metrics: [{
          metric: 'water_level', label: '坝上水位', unit: 'm',
          tagName: 'TQPSW001_1O_100620000030001', decimals: 2,
          thresholds: [{ level: '汛限', value: 786.8 }, { level: '警戒', value: 787.5 }, { level: '保证', value: 788.4 }],
        }],
      },
      {
        id: 'TQP-RAIN', name: '桃曲坡水库雨量站',
        metrics: [{ metric: 'rainfall', label: '时段降雨量', unit: 'mm', tagName: 'TQPRN001_1O_100620000030002', decimals: 1, thresholds: [{ level: '警戒雨量', value: 50 }] }],
      },
      {
        id: 'TQP-INFLOW', name: '桃曲坡水库入库水文站',
        metrics: [{ metric: 'inflow', label: '入库流量', unit: 'm³/s', tagName: 'TQPQF001_1O_100620000030003', decimals: 1 }],
      },
    ],
    reporting: [
      { object: '铜川市防汛抗旱指挥部', channel: '防汛专报', frequency: '超汛限期间每 2 小时一次' },
      { object: '桃曲坡水库灌区管理单位', channel: '值班交接', frequency: '每班次' },
    ],
  },
})

const results: Array<[string, boolean, string]> = []
function check(name: string, passed: boolean, detail = ''): void {
  results.push([name, passed, detail])
  console.log(`${passed ? '✅' : '❌'} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
}

// ── 1. list_duty_stations ──
const stationsRes = await service.tools.find((t) => t.name === 'list_duty_stations')!.run({}, service.createContext())
check('list_duty_stations 台账投影', stationsRes.success && stationsRes.rowCount === 3,
  `${stationsRes.rowCount} 指标行`)

// ── 2. generate_duty_report ──
const reportTool = service.tools.find((t) => t.name === 'generate_duty_report')!
const res = await reportTool.run({
  shift_start: '2024-08-14T08:00',
  shift_end: '2024-08-14T20:00',
  shift_name: '白班',
  notes: 'E2E 演示交接：夜间关注降雨趋势。',
}, service.createContext())

check('generate_duty_report 成功', res.success, res.success ? '' : `${res.errorCode}: ${res.errorMessage.slice(0, 160)}`)
if (!res.success) {
  console.log('\n（E2E 终止：报告生成失败）')
  process.exit(1)
}
const row = res.data[0]!
console.log(`   产物: ${String(row.path)}`)
console.log(`   pack_hash: ${String(row.packHash)}  命中 ${String(row.ruleHitCount)} / 建议 ${String(row.adviceCount)} / 缺口 ${String(row.abstentionCount)}`)

check('返回 16 位 pack_hash', /^[0-9a-f]{16}$/.test(String(row.packHash)))
check('3 站 3 观测全量入报', Number(row.telemetryCount) === 3 && Number(row.stationCount) === 3)
check('超警戒命中 1 条（橙色）', Number(row.ruleHitCount) === 1)
check('出闸校验通过', String(row.validation).includes('通过'))

// ── 3. HTML 单文件离线可开 ──
const html = await readFile(String(row.path), 'utf8')
const sections = ['sec-head', 'sec-telemetry', 'sec-thresholds', 'sec-rules', 'sec-advice', 'sec-citations', 'sec-reporting', 'sec-gaps']
check('8 段结构齐全', sections.every((id) => html.includes(`id="${id}"`)))
check('无外链资源（离线单文件）', !/<(script|img|link)[^>]+(src|href)="https?:/.test(html))
check('观测值/观测时间/tagName 入表', html.includes('787.62') && html.includes('2024-08-14 08:00:00') && html.includes('TQPSW001_1O_100620000030001'))
check('页脚 pack_hash 一致', html.includes(String(row.packHash)))
check('内嵌 fact-pack 可还原', (/<script type="application\/json" id="duty-fact-pack">[\s\S]*?<\/script>/).test(html))
check('超警判定单元格（超警戒）', html.includes('超警戒'))

const repack = JSON.parse((/<script type="application\/json" id="duty-fact-pack">([\s\S]*?)<\/script>/.exec(html))![1]
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replaceAll('&amp;', '&')) as Parameters<typeof renderDutyReportHtml>[0]
const reRendered = renderDutyReportHtml(repack)
const reValidation = validateDutyReportHtml(reRendered, repack)
check('渲染幂等（内嵌包重渲染通过校验）', reValidation.valid, reValidation.errors.join('；'))

// 知识引用：真实 RAGFlow 可用时命中规程文档；未配置时按缺口渲染（两种都算通过，打印实际情况）
const hasCitation = html.includes('《') && !html.includes('未引用规程条文')
const hasCitationGap = html.includes('KNOWLEDGE_UNAVAILABLE')
check('规程引用段（引用或缺口二选一）', hasCitation || hasCitationGap,
  hasCitation ? '命中规程引用' : '知识面未配置，按缺口渲染')

console.log(`\n产物目录（保留供人工/Playwright 复核）: ${OUTPUT_DIR}`)
const failed = results.filter(([, ok]) => !ok)
console.log(`\n════════ 值班报告工具级 E2E：${results.length - failed.length}/${results.length} 通过 ════════`)
if (process.env.DUTY_E2E_KEEP !== '1' && failed.length === 0) {
  await rm(OUTPUT_DIR, { recursive: true, force: true })
  console.log('（临时产物已清理；DUTY_E2E_KEEP=1 可保留）')
}
process.exit(failed.length === 0 ? 0 : 1)
