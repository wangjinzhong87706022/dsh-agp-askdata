/**
 * 防汛值班报告事实包（Fact Pack）类型（对照《防汛值班报告 Agent 规划清单》§六）。
 *
 * 三层一致性：hard（telemetry/thresholds/ruleHits/constraints/advice/citations/reporting）
 * 参与 pack_hash，缺字段或改语义 = 整条撤回；soft（claims）允许同义改写不换哈希；
 * shell（标题/编制时间等公文外壳）不参与。报告 HTML、对话摘要与 pack_hash 同源。
 * @module
 */

import type { DutyReporting, DutyStation, DutyThreshold } from '../config.ts'

/** 一条测站观测（hard：测站数字 + 观测时间，缺观测时间 = 整条不可执行）。 */
export interface DutyTelemetryRow {
  stationId: string
  stationName: string
  /** 指标键（water_level / rainfall / inflow …）。 */
  metric: string
  label: string
  unit: string
  /** AGP 测点全名（数据来源锚点）。 */
  tagName: string
  /** 观测值（null = 缺测，进 abstentions，不进本行）。 */
  value: number
  /** AGP API 返回的观测时间（原样字符串；null = 网关未回时间）。 */
  observedAt: string | null
  decimals: number
}

/** 一条阈值对照（hard：删掉后超警判定会变）。 */
export interface DutyThresholdRow {
  stationId: string
  stationName: string
  metric: string
  label: string
  unit: string
  /** 档名（汛限/警戒/保证/校核/自定义）。 */
  level: string
  thresholdValue: number
  op: NonNullable<DutyThreshold['op']>
  /** 本次观测值（对照用；null = 缺测未对照）。 */
  observedValue: number | null
  exceeded: boolean | null
}

/** 告警等级（颜色语义对齐防汛惯例，映射由规则引擎固定，禁止 LLM 自算）。 */
export type DutySeverity = '红色' | '橙色' | '黄色' | '蓝色'

/** 一条规则命中（hard：可追溯到阈值档 + 测站 + 证据值）。 */
export interface DutyRuleHit {
  /** 规则 id（TH-<station>-<metric>-<level>，稳定可引用）。 */
  ruleId: string
  stationId: string
  stationName: string
  metric: string
  label: string
  level: string
  severity: DutySeverity
  /** 命中描述（含量值与时限语义）。 */
  message: string
  /** 证据：观测值 + 阈值原文。 */
  evidence: string
}

/** 一条规程引用锚点（hard：删掉后不能追溯条款出处）。 */
export interface DutyCitation {
  /** 出处文档名（如"03-汛期调度运用计划.pdf"）。 */
  document: string
  /** 证据片段（规程原文节选）。 */
  snippet: string
  /** 页码（知识面 positions 投影；缺失为 null）。 */
  page: number | null
  /** RAGFlow chunk id（缺失为 null）。 */
  chunkId: string | null
  /** 来源：auto = 工具内自动检索；provided = LLM 已取证后传入。 */
  source: 'auto' | 'provided'
}

/** 一条调度意见（hard：禁则/量值/时限完整，由规则引擎按命中等级生成）。 */
export interface DutyAdvice {
  id: string
  severity: DutySeverity
  /** 意见全文（含量值、时限、通知对象；只出研判建议，无操作令）。 */
  text: string
  /** 依据规则 id（空 = 报讯例行项）。 */
  basisRuleId: string
}

/** 一条数据缺口/拒答（不参与 pack_hash——缺口集合随环境变化是常态）。 */
export interface DutyAbstention {
  stationId: string | null
  metric: string | null
  tagName: string | null
  /** 规范错误码（BACKEND_DOWN / INVALID_PARAM …）或 DATA_MISSING / KNOWLEDGE_UNAVAILABLE。 */
  code: string
  reason: string
}

/** 态势叙述（soft：声明集合不变，允许同义改写）。 */
export interface DutyClaim {
  text: string
  /** 叙述依据的 telemetry 下标或规则 id（追溯锚）。 */
  basis: string
}

/** 值班报告事实包。 */
export interface DutyFactPack {
  /** 任务标识（本轮报告生成的 uuid）。 */
  queryId: string
  /** 编制时间（ISO8601，报告头展示；shell 层不参与 hash）。 */
  generatedAt: string
  project: string
  shift: { name: string; start: string; end: string }
  telemetry: DutyTelemetryRow[]
  thresholds: DutyThresholdRow[]
  ruleHits: DutyRuleHit[]
  citations: DutyCitation[]
  /** 禁则（固定一条：只出研判建议与通知对象，禁止开闸/关闸/启泵等操作令）。 */
  constraints: string[]
  advice: DutyAdvice[]
  reporting: DutyReporting[]
  claims: DutyClaim[]
  abstentions: DutyAbstention[]
  /** hard 字段子集的稳定哈希（SHA-256 前 16 hex）。 */
  packHash: string
}

/** 值班报告工具的测站台账视图（配置形态的运行时投影）。 */
export type DutyStationRegistry = readonly DutyStation[]

/** 值班报告出闸校验结果。 */
export interface DutyValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}
