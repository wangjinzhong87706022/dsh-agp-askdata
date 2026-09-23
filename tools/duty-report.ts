/**
 * `generate_duty_report`（值班报告面，docs/architecture.md §19）：
 * 防汛值班报告编排入口（对照《防汛值班报告 Agent 规划清单》T1/T4 + 场景 A 单 Agent 流）。
 *
 * 工具内流水线（本插件不依赖宿主 subagent runtime，与 deep-analysis 同模式）：
 *   1. 测站台账解析（duty.stations，station_ids 可选子集）
 *   2. AGP API 实时值拉取（fetchAgpRealtime：POST /tag/realtime 主路 + GET 回落；
 *      **不走 SQL 通道**——失败记入 abstentions[]，缺测不编造、不邻站填空）
 *   3. 规则研判（evaluateDutyRules：阈值命中/告警等级/调度意见全由引擎产生，LLM 不自算）
 *   4. 规程引用（citations 入参优先；缺省时 RAGFlow 自动检索一次，失败不阻断）
 *   5. buildFactPack（pack_hash 覆盖 hard 字段）→ renderDutyReportHtml（8 段单文件）
 *   6. 出闸校验（validateDutyReportHtml：结构/哈希/建议全量/无操作令）→ 落盘 outputs
 *
 * 产物为沙盒文件（HTML 报告），只写 duty.outputDir 解析出的目录，不触碰数据库
 * （只读红线约束的是 SQL 写语句；报告文件是本工具的交付物本身）。
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AskdataTool, ToolContext } from './types.ts'
import { applyAudit } from './types.ts'
import { fail, ok, type ResultField } from '../src/result.ts'
import { askdataError, AskdataError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import type { DutyAbstention, DutyCitation, DutyFactPack } from '../src/duty/types.ts'
import { DUTY_GAP_CODES, buildFactPack } from '../src/duty/fact-pack.ts'
import { renderDutyReportHtml, validateDutyReportHtml } from '../src/duty/render.ts'
import { fetchAgpRealtime } from '../src/clients/tsdb-rest.ts'
import { validateTimeRange } from '../src/sql/validate.ts'
import type { DutyStation } from '../src/config.ts'

const FIELDS: ResultField[] = [
  { name: 'filename', title: '报告文件名', type: 'string' },
  { name: 'path', title: '报告文件路径', type: 'string' },
  { name: 'packHash', title: '事实包哈希', type: 'string' },
  { name: 'project', title: '工程/河段', type: 'string' },
  { name: 'shift', title: '值班时段', type: 'string' },
  { name: 'stationCount', title: '测站数', type: 'number' },
  { name: 'telemetryCount', title: '观测条数', type: 'number' },
  { name: 'ruleHitCount', title: '规则命中数', type: 'number' },
  { name: 'adviceCount', title: '研判建议条数', type: 'number' },
  { name: 'citationCount', title: '规程引用条数', type: 'number' },
  { name: 'abstentionCount', title: '数据缺口条数', type: 'number' },
  { name: 'validation', title: '出闸校验', type: 'string' },
  { name: 'limitations', title: '限制说明', type: 'string' },
]

/** 台账解析结果（station_ids 过滤后）。 */
function resolveStations(ctx: ToolContext, stationIds: string[]): DutyStation[] {
  const registry = ctx.config.duty.stations
  if (registry.length === 0) {
    throw askdataError(
      'INVALID_PARAM',
      '值班报告面未配置测站台账：请在 duty.stations 配置测站/指标/tagName/阈值后重试',
    )
  }
  if (stationIds.length === 0) return [...registry]
  const byId = new Map(registry.map((s) => [s.id, s]))
  const picked: DutyStation[] = []
  for (const id of stationIds) {
    const station = byId.get(id)
    if (!station) {
      throw askdataError('INVALID_PARAM', `station_ids 含未知测站 id: ${id}（可用：${registry.map((s) => s.id).join('、')}）`)
    }
    picked.push(station)
  }
  return picked
}

/** 值班时段规范化（'YYYY-MM-DD' 补 T00:00；ISO8601 原样）→ 展示串。 */
function normalizeShiftBoundary(raw: string, field: string): string {
  const text = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`
  if (Number.isNaN(Date.parse(text))) {
    throw askdataError('INVALID_PARAM', `${field} 不是合法 ISO8601 时间或日期: ${raw}`)
  }
  return text
}

/** 台账全部 tagName（保序去重）。 */
function collectTagNames(stations: readonly DutyStation[]): string[] {
  const names: string[] = []
  for (const station of stations) {
    for (const metric of station.metrics) {
      if (!names.includes(metric.tagName)) names.push(metric.tagName)
    }
  }
  return names
}

/** 产出目录解析：duty.outputDir > $DSH_HOME/outputs > ./outputs。 */
function resolveOutputDir(ctx: ToolContext): string {
  const configured = ctx.config.duty.outputDir.trim()
  if (configured !== '') return resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  if (dshHome !== undefined && dshHome !== '') return join(dshHome, 'outputs')
  return resolve('outputs')
}

/** 文件名净化：工程名/班次名里可进文件名的字符（中文/字母/数字/下划线/连字符）。 */
function sanitizeFilePart(raw: string): string {
  const cleaned = raw.replace(/[^\p{Script=Han}A-Za-z0-9_-]+/gu, '').slice(0, 40)
  return cleaned !== '' ? cleaned : 'report'
}

/** 时间戳 → 文件名段（20240814-0800；剔除冒号等 Windows 非法字符）。 */
function fileStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
}

/** 工具入参 citations → 事实包引用（provided 来源）。 */
function toProvidedCitations(raw: unknown): DutyCitation[] {
  if (!Array.isArray(raw)) return []
  const citations: DutyCitation[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const document = typeof row.document === 'string' ? row.document.trim() : ''
    const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : ''
    if (document === '' || snippet === '') continue
    const page = typeof row.page === 'number' && Number.isFinite(row.page) ? Math.trunc(row.page) : null
    const chunkId = typeof row.chunk_id === 'string' && row.chunk_id.trim() !== '' ? row.chunk_id.trim() : null
    citations.push({ document, snippet, page, chunkId, source: 'provided' })
  }
  return citations
}

/** 知识面自动检索：规程依据 top3（失败/未装配返回 null，缺口由调用方记录）。 */
async function autoCitations(
  ctx: ToolContext,
  project: string,
  kbQuery: string,
): Promise<DutyCitation[] | null> {
  if (!ctx.knowledge) return null
  const question = kbQuery.trim() !== '' ? kbQuery.trim() : `${project} 汛限水位 警戒水位 调度 规程`
  const outcome = await ctx.knowledge.searchChunks(question, { topK: 3, signal: ctx.signal })
  return outcome.chunks.slice(0, 3).map((chunk) => ({
    document: chunk.documentName || chunk.documentId || '未知文档',
    snippet: chunk.content.slice(0, 200),
    page: chunk.pageNum ?? null,
    chunkId: chunk.chunkId ?? null,
    source: 'auto' as const,
  }))
}

/** AGP API 拉数：全部 tagName 一次调用；失败抛错由调用方整体记缺口。 */
async function fetchTelemetry(
  ctx: ToolContext,
  tagNames: string[],
): Promise<Map<string, { value: number; time: string | null }>> {
  const out = await fetchAgpRealtime(ctx.config.query, ctx.config.appId, tagNames, ctx.config.system, {
    signal: ctx.signal,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    log: (message) => ctx.log?.(message),
  })
  const values = new Map<string, { value: number; time: string | null }>()
  for (const row of out.rows) {
    if (row.tagName === null || row.tagName === undefined) continue
    const value = Number(row.latestValue)
    if (!Number.isFinite(value)) continue
    values.set(row.tagName, { value, time: row.latestTime ?? null })
  }
  return values
}

/**
 * generate_duty_report 工具定义。
 *
 * 走 `runKnowledgeTool` 式手工管线（不进 runSqlTool：本工具不执行 SQL，也不发
 * 单一 HTTP 调用，而是编排 AGP API + RAGFlow + 文件产物），审计行在收尾处落。
 */
export const dutyReportTool: AskdataTool = {
  name: 'generate_duty_report',
  description:
    '生成防汛值班报告（单文件 HTML，8 段固定结构：报告头/测站汇总/阈值对照/预警研判/建议/规程依据/通知报讯/缺口交接）。'
    + '实时水雨情经 AGP API 拉取（不走 SQL）；阈值研判与建议由规则引擎产生，禁止在对话里自算等级；'
    + '规程依据优先用你在调用前通过 knowledge_search 取到的片段（citations 入参传入），未传则工具自动检索。'
    + '缺测项进入报告"数据缺口"段，不编造数值。报告落盘后返回文件路径与 pack_hash。',
  layer: 'scenario',
  inputSchema: {
    type: 'object',
    properties: {
      shift_start: { type: 'string', description: '值班时段开始（ISO8601 或 YYYY-MM-DD，如 2026-09-07T08:00）' },
      shift_end: { type: 'string', description: '值班时段结束（同上，须晚于开始）' },
      shift_name: { type: 'string', description: '班次名（如 白班/夜班；缺省自动按时段推断）' },
      title: { type: 'string', description: '报告标题覆盖（缺省 "{工程}防汛值班报告"）' },
      station_ids: { type: 'array', items: { type: 'string' }, description: '测站 id 子集（缺省全部台账测站；先 list_duty_stations 查看）' },
      notes: { type: 'string', description: '交接事项/人工补充（进报告第 8 段，不参与 pack_hash）' },
      citations: {
        type: 'array',
        description: '规程引用片段（来自 knowledge_search 取证）：[{document, snippet, page?, chunk_id?}]',
        items: {
          type: 'object',
          properties: {
            document: { type: 'string', description: '出处文档名' },
            snippet: { type: 'string', description: '规程原文片段' },
            page: { type: 'number', description: '页码（可选）' },
            chunk_id: { type: 'string', description: 'RAGFlow chunk id（可选）' },
          },
          required: ['document', 'snippet'],
        },
      },
      kb_query: { type: 'string', description: '自动检索规程时的问句改写（缺省 "{工程} 汛限水位 警戒水位 调度 规程"）' },
    },
    required: ['shift_start', 'shift_end'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const started = Date.now()
    let pack: DutyFactPack | null = null
    try {
      if (ctx.signal?.aborted) throw askdataError('BACKEND_DOWN', '工具调用已被取消')
      pack = await buildReport(args, ctx)
      const html = renderDutyReportHtml(pack, {
        title: typeof args.title === 'string' ? args.title : undefined,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
      })
      const validation = validateDutyReportHtml(html, pack)
      if (!validation.valid) {
        throw askdataError('REPORT_INVALID', `报告出闸校验未通过: ${validation.errors.join('；')}`)
      }

      const dir = resolveOutputDir(ctx)
      await mkdir(dir, { recursive: true })
      const filename = `duty-report-${sanitizeFilePart(pack.project)}-${fileStamp(pack.shift.start)}-${sanitizeFilePart(pack.shift.name)}.html`
      const path = join(dir, filename)
      await writeFile(path, html, 'utf8')

      const limitations: string[] = []
      if (pack.abstentions.length > 0) {
        limitations.push(`${pack.abstentions.length} 条数据缺口（详见报告第 8 段）`)
      }
      if (pack.citations.length === 0) {
        limitations.push('未引用规程条文（知识面未装配或检索为空）')
      }
      if (limitations.length === 0) limitations.push('无')

      const result = ok(dutyReportTool.name, {
        apiOrSql: `AGP API realtime ×${collectTagNames(resolveStations(ctx, stationIdsOf(args))).length} tags + 规程引用 ×${pack.citations.length} → ${filename}`,
        params: args,
        fields: FIELDS,
        data: [{
          filename,
          path,
          packHash: pack.packHash,
          project: pack.project,
          shift: `${pack.shift.start} ~ ${pack.shift.end}${pack.shift.name ? `（${pack.shift.name}）` : ''}`,
          stationCount: new Set(pack.telemetry.map((t) => t.stationId)).size,
          telemetryCount: pack.telemetry.length,
          ruleHitCount: pack.ruleHits.length,
          adviceCount: pack.advice.length,
          citationCount: pack.citations.length,
          abstentionCount: pack.abstentions.length,
          validation: `通过（warnings: ${validation.warnings.length}）`,
          limitations: limitations.join('；'),
        }],
        executionMs: Date.now() - started,
      })
      applyAudit(dutyReportTool, args, ctx, `duty-report ${filename}`, result, started)
      return result
    } catch (err) {
      const askErr = err instanceof AskdataError ? err : null
      const code: ErrorCode = askErr ? askErr.code : 'BACKEND_DOWN'
      const message = askErr ? askErr.message : `值班报告生成异常: ${err instanceof Error ? err.message : String(err)}`
      const result = fail(dutyReportTool.name, {
        params: args,
        code,
        message,
        executionMs: Date.now() - started,
      })
      applyAudit(dutyReportTool, args, ctx, pack !== null ? `duty-report ${pack.packHash}` : 'duty-report', result, started)
      return result
    }
  },
}

function stationIdsOf(args: Record<string, unknown>): string[] {
  const raw = args.station_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

/** 报告构建主链（台账 → AGP API → 研判 → 引用 → 事实包）。 */
async function buildReport(args: Record<string, unknown>, ctx: ToolContext): Promise<DutyFactPack> {
  const shiftStartRaw = typeof args.shift_start === 'string' ? args.shift_start.trim() : ''
  const shiftEndRaw = typeof args.shift_end === 'string' ? args.shift_end.trim() : ''
  if (shiftStartRaw === '' || shiftEndRaw === '') {
    throw askdataError('INVALID_PARAM', 'shift_start / shift_end 必填（值班时段）')
  }
  const shiftStart = normalizeShiftBoundary(shiftStartRaw, 'shift_start')
  const shiftEnd = normalizeShiftBoundary(shiftEndRaw, 'shift_end')
  validateTimeRange(shiftStart, shiftEnd, ctx.config.system)

  const shiftName = typeof args.shift_name === 'string' && args.shift_name.trim() !== ''
    ? args.shift_name.trim()
    : inferShiftName(shiftStart)
  const stations = resolveStations(ctx, stationIdsOf(args))
  const project = ctx.config.duty.project.trim() !== '' ? ctx.config.duty.project.trim() : '未命名工程'
  const tagNames = collectTagNames(stations)

  // 2. AGP API 拉数（不走 SQL）：整体失败 → 全部测点记缺口；部分回行 → 缺失测点逐条记缺口。
  const fetchErrors: DutyAbstention[] = []
  let values = new Map<string, { value: number; time: string | null }>()
  try {
    values = await fetchTelemetry(ctx, tagNames)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fetchErrors.push({
      stationId: null,
      metric: null,
      tagName: null,
      code: err instanceof AskdataError ? err.code : 'BACKEND_DOWN',
      reason: `AGP API 实时值拉取失败（${tagNames.length} 个测点全部缺测）: ${message}`,
    })
    ctx.log?.(`generate_duty_report AGP API 拉取失败，报告按全缺口渲染: ${message.slice(0, 120)}`)
  }

  // 4. 规程引用：入参 provided 优先；否则知识面自动检索（失败不阻断，记缺口）。
  let citations = toProvidedCitations(args.citations)
  let citationGap: string | null = null
  if (citations.length === 0) {
    try {
      const auto = await autoCitations(ctx, project, typeof args.kb_query === 'string' ? args.kb_query : '')
      if (auto !== null) citations = auto
      else citationGap = '知识面未装配（knowledge.datasetIds 未配置），规程依据留空'
    } catch (err) {
      citationGap = `规程自动检索失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const pack = buildFactPack({
    project,
    shift: { name: shiftName, start: shiftStart, end: shiftEnd },
    stations,
    values,
    fetchErrors,
    reporting: ctx.config.duty.reporting,
    citations,
  })
  if (citationGap !== null) {
    pack.abstentions.push({
      stationId: null,
      metric: null,
      tagName: null,
      code: DUTY_GAP_CODES.KNOWLEDGE_UNAVAILABLE,
      reason: citationGap,
    })
  }
  return pack
}

/** 白班/夜班推断（08:00-20:00 白班；shell 层展示用）。 */
function inferShiftName(startIso: string): string {
  const hour = Number(startIso.slice(11, 13))
  if (Number.isNaN(hour)) return ''
  return hour >= 8 && hour < 20 ? '白班' : '夜班'
}

/** 供测试引用字段定义。 */
export const DUTY_REPORT_FIELDS = FIELDS
