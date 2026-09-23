/**
 * 事实包构建与 pack_hash（对照《防汛值班报告 Agent 规划清单》§六）。
 *
 * 三问判准落在字段分层：hard（测站数字/阈值/规则命中/禁则/调度意见/规程锚点/报讯路径）
 * 参与 pack_hash——删掉后值班无法执行、责任会变、或不可追溯的字段全部在此；
 * soft（claims）与 shell（queryId/generatedAt/shift 名）不参与——同义改写与公文
 * 外壳不换哈希。HTML 页脚、对话摘要、fact_pack 三者共用同一 pack_hash。
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DutyReporting } from '../config.ts'
import type { DutyAbstention, DutyCitation, DutyFactPack } from './types.ts'
import { buildAdvice, evaluateDutyRules, type EvaluateInput } from './rules.ts'

/** 禁则（hard 固定一条，渲染进第 5 段与出闸校验负面清单一致）。 */
export const DUTY_CONSTRAINTS: readonly string[] = [
  '本报告只输出研判建议、告警等级与通知对象，不含开闸、关闸、启泵、停泵等任何工程操作令；调度决策由防汛指挥机构作出。',
]

/** 事实包构建入参（evaluateDutyRules 的薄包装 + 元数据）。 */
export interface BuildFactPackInput extends EvaluateInput {
  project: string
  shift: { name: string; start: string; end: string }
  /** 生成时间（ISO8601；缺省当前时间）。 */
  generatedAt?: string
  /** 规程引用（auto=工具内检索 / provided=LLM 已取证）。 */
  citations?: DutyCitation[]
  /** 交接事项/用户补充（shell 层，进第 8 段，不参与 hash）。 */
  notes?: string
  /** 报讯路径（配置 duty.reporting）。 */
  reporting?: DutyReporting[]
}

/** hard 字段子集（pack_hash 的输入；键序稳定）。 */
interface HardSubset {
  telemetry: DutyFactPack['telemetry']
  thresholds: DutyFactPack['thresholds']
  ruleHits: DutyFactPack['ruleHits']
  citations: DutyFactPack['citations']
  constraints: readonly string[]
  advice: DutyFactPack['advice']
  reporting: DutyReporting[]
}

/** 稳定 JSON：键排序递归 + 无空白（对象键序不敏感，数组序敏感）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** hard 字段子集的 SHA-256 前 16 hex（pack_hash）。 */
export function packHashOf(hard: HardSubset): string {
  return createHash('sha256').update(stableStringify(hard), 'utf8').digest('hex').slice(0, 16)
}

/** 本地墙钟时间串（YYYY-MM-DD HH:mm:ss；报告头"编制时间"展示用，不用 UTC ISO）。 */
export function localTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 构建事实包：研判（阈值/命中/缺口）→ 调度意见 → 组装 → pack_hash。
 *
 * abstentions 顺序固定（fetchErrors 在前、逐测点缺测在后），claims 顺序跟台账——
 * 两者的*内容*不参与 hash（soft 层），但顺序确定性让报告渲染可复现。
 */
export function buildFactPack(input: BuildFactPackInput): DutyFactPack {
  const evaluated = evaluateDutyRules(input)
  const advice = buildAdvice(evaluated.ruleHits, input.reporting ?? [])
  const citations = input.citations ?? []
  const reporting = input.reporting ?? []
  const constraints = [...DUTY_CONSTRAINTS]
  const generatedAt = input.generatedAt ?? localTimestamp()
  const hard: HardSubset = {
    telemetry: evaluated.telemetry,
    thresholds: evaluated.thresholds,
    ruleHits: evaluated.ruleHits,
    citations,
    constraints,
    advice,
    reporting,
  }
  return {
    queryId: randomUUID(),
    generatedAt,
    project: input.project,
    shift: input.shift,
    telemetry: evaluated.telemetry,
    thresholds: evaluated.thresholds,
    ruleHits: evaluated.ruleHits,
    citations,
    constraints,
    advice,
    reporting,
    claims: evaluated.claims,
    abstentions: evaluated.abstentions,
    packHash: packHashOf(hard),
  }
}

/** 数据缺口分类码（abstentions 专用；规范错误码以外的两个补充码）。 */
export const DUTY_GAP_CODES = {
  /** 测点本轮无实时值。 */
  DATA_MISSING: 'DATA_MISSING',
  /** 知识面未装配或检索为空（规程引用缺口）。 */
  KNOWLEDGE_UNAVAILABLE: 'KNOWLEDGE_UNAVAILABLE',
} as const
