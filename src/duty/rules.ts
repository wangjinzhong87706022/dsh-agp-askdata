/**
 * 值班报告规则研判引擎（对照《防汛值班报告 Agent 规划清单》`evaluate_rules`）。
 *
 * 机理判定固定走本引擎，禁止 LLM 自算等级：阈值命中、告警等级映射、调度意见
 * 全部由确定性代码产生；LLM 只能补充交接说明（notes → abstentions 同层的
 * shell 字段），不能往 advice[] 塞自拟意见。
 * @module
 */

import type { DutyMetric, DutyStation, DutyThreshold } from '../config.ts'
import type {
  DutyAbstention,
  DutyAdvice,
  DutyClaim,
  DutyRuleHit,
  DutySeverity,
  DutyTelemetryRow,
  DutyThresholdRow,
} from './types.ts'

/** 档名 → 告警等级（关键词映射；未识别档位按蓝色提示档）。 */
export function severityForLevel(level: string): DutySeverity {
  if (/保证|校核|危险|溃坝/.test(level)) return '红色'
  if (/警戒|危急/.test(level)) return '橙色'
  if (/汛限|预警/.test(level)) return '黄色'
  return '蓝色'
}

/** 判超：op 缺省 '>='（达到阈值即超）。 */
export function compareThreshold(value: number, threshold: DutyThreshold): boolean {
  const op = threshold.op ?? '>='
  switch (op) {
    case '>=': return value >= threshold.value
    case '>': return value > threshold.value
    case '<=': return value <= threshold.value
    case '<': return value < threshold.value
  }
}

function formatValue(value: number, decimals: number): string {
  return value.toFixed(Math.min(8, Math.max(0, decimals)))
}

/**
 * 一次值班研判的全部输入：台账 + AGP API 实时值行 + 拉取缺口。
 * `values` 以 tagName 为键（tagName 是 AGP 数据面唯一锚点）。
 */
export interface EvaluateInput {
  stations: readonly DutyStation[]
  /** tagName → { value, time }（仅成功拉到的测点）。 */
  values: Map<string, { value: number; time: string | null }>
  /** 拉取缺口（AGP API 失败聚合；逐测点缺口在 buildTelemetry 里产生）。 */
  fetchErrors: DutyAbstention[]
}

/** 研判输出：三层对照 + 命中 + 缺口。 */
export interface EvaluateOutput {
  telemetry: DutyTelemetryRow[]
  thresholds: DutyThresholdRow[]
  ruleHits: DutyRuleHit[]
  abstentions: DutyAbstention[]
  claims: DutyClaim[]
}

/**
 * 阈值研判主入口：组装 telemetry → 阈值对照 → 规则命中 → 态势叙述。
 *
 * 缺测指标：进 abstentions、阈值对照行 observedValue/exceeded 置 null（保留对照
 * 结构完整性），不产生规则命中——缺测不等于安全。
 */
export function evaluateDutyRules(input: EvaluateInput): EvaluateOutput {
  const telemetry: DutyTelemetryRow[] = []
  const thresholds: DutyThresholdRow[] = []
  const ruleHits: DutyRuleHit[] = []
  const abstentions: DutyAbstention[] = [...input.fetchErrors]
  const claims: DutyClaim[] = []

  for (const station of input.stations) {
    for (const metric of station.metrics) {
      const observed = input.values.get(metric.tagName)
      if (observed === undefined) {
        abstentions.push({
          stationId: station.id,
          metric: metric.metric,
          tagName: metric.tagName,
          code: 'DATA_MISSING',
          reason: `测点 ${metric.tagName} 本班次未取到实时值（AGP API 无返回），缺测不研判、不邻站填空`,
        })
        for (const threshold of metric.thresholds ?? []) {
          thresholds.push({
            stationId: station.id,
            stationName: station.name,
            metric: metric.metric,
            label: metric.label,
            unit: metric.unit,
            level: threshold.level,
            thresholdValue: threshold.value,
            op: threshold.op ?? '>=',
            observedValue: null,
            exceeded: null,
          })
        }
        continue
      }

      const decimals = metric.decimals ?? 2
      const valueText = formatValue(observed.value, decimals)
      telemetry.push({
        stationId: station.id,
        stationName: station.name,
        metric: metric.metric,
        label: metric.label,
        unit: metric.unit,
        tagName: metric.tagName,
        value: observed.value,
        observedAt: observed.time,
        decimals,
      })

      let worstHit: DutyRuleHit | null = null
      for (const threshold of metric.thresholds ?? []) {
        const exceeded = compareThreshold(observed.value, threshold)
        thresholds.push({
          stationId: station.id,
          stationName: station.name,
          metric: metric.metric,
          label: metric.label,
          unit: metric.unit,
          level: threshold.level,
          thresholdValue: threshold.value,
          op: threshold.op ?? '>=',
          observedValue: observed.value,
          exceeded,
        })
        if (!exceeded) continue
        const severity = severityForLevel(threshold.level)
        const op = threshold.op ?? '>='
        const direction = op === '<=' || op === '<' ? '低于' : '达到或超过'
        const hit: DutyRuleHit = {
          ruleId: `TH-${station.id}-${metric.metric}-${threshold.level}`,
          stationId: station.id,
          stationName: station.name,
          metric: metric.metric,
          label: metric.label,
          level: threshold.level,
          severity,
          message: `${station.name} ${metric.label} ${valueText} ${metric.unit}，${direction}${threshold.level}阈值 ${formatValue(threshold.value, decimals)} ${metric.unit}，判定为${severity}预警`,
          evidence: `value=${valueText} ${metric.unit} vs ${threshold.level} ${threshold.op ?? '>='} ${formatValue(threshold.value, decimals)} ${metric.unit} @ ${observed.time ?? '时间未回'}`,
        }
        // 同一指标多档命中时保留最高等级一条（红色>橙色>黄色>蓝色）。
        if (worstHit === null || severityRank(hit.severity) > severityRank(worstHit.severity)) {
          worstHit = hit
        }
      }
      if (worstHit !== null) ruleHits.push(worstHit)

      claims.push({
        text: `${station.name} ${metric.label} ${valueText} ${metric.unit}${observed.time ? `（观测时间 ${observed.time}）` : ''}`,
        basis: `telemetry:${station.id}:${metric.metric}`,
      })
    }
  }

  return { telemetry, thresholds, ruleHits, abstentions, claims }
}

function severityRank(severity: DutySeverity): number {
  return { '红色': 4, '橙色': 3, '黄色': 2, '蓝色': 1 }[severity]
}

/**
 * 调度意见生成：规则命中 → 固定模板（量值/时限/通知对象完整），外加例行报讯项。
 *
 * 红线：只出研判建议、告警等级、通知对象；模板措辞不含任何开闸/关闸/启泵操作令
 * （渲染后另有出闸校验兜底）。意见里"加密观测/上报/通知"是值班动作，不是工程操作令。
 */
export function buildAdvice(
  ruleHits: readonly DutyRuleHit[],
  reporting: readonly { object: string; channel?: string; frequency?: string }[],
): DutyAdvice[] {
  const advice: DutyAdvice[] = []
  const sorted = [...ruleHits].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
  for (const [index, hit] of sorted.entries()) {
    const template = ADVICE_TEMPLATES[hit.severity]
    advice.push({
      id: `AD-${String(index + 1).padStart(2, '0')}`,
      severity: hit.severity,
      text: template(hit),
      basisRuleId: hit.ruleId,
    })
  }
  // 例行报讯项（无命中也保留：值班报告的报讯义务不依赖告警）。
  if (reporting.length > 0) {
    const objects = reporting.map((r) => r.object).join('、')
    const frequency = reporting.find((r) => r.frequency)?.frequency ?? '按值班制度例行'
    advice.push({
      id: `AD-${String(advice.length + 1).padStart(2, '0')}`,
      severity: '蓝色',
      text: `按报讯制度向 ${objects} 报送本班次水情信息（频次：${frequency}）；当前无更高等级命中时维持例行观测频次。`,
      basisRuleId: '',
    })
  }
  if (advice.length === 0) {
    advice.push({
      id: 'AD-01',
      severity: '蓝色',
      text: '本班次无阈值命中，维持例行观测与交接班检查；继续关注气象水文预报。',
      basisRuleId: '',
    })
  }
  return advice
}

/** 等级 → 建议模板（研判建议 + 通知对象 + 时限，无操作令）。 */
const ADVICE_TEMPLATES: Record<DutySeverity, (hit: DutyRuleHit) => string> = {
  '红色': (hit) => `${hit.stationName} ${hit.label}已${hit.level}标准（${hit.evidence}）。建议：立即按${hit.severity}预警程序向防汛责任人与当地防汛部门报告，加密观测至每 30 分钟一次并持续盯守，同时核对上下游测站相互印证；人员转移与工程抢险等决策由防汛指挥机构作出。`,
  '橙色': (hit) => `${hit.stationName} ${hit.label}已${hit.level}标准（${hit.evidence}）。建议：2 小时内向防汛责任人报告本班次量值与趋势，加密观测至每 1 小时一次，通知相关防汛值守点位加强巡查。`,
  '黄色': (hit) => `${hit.stationName} ${hit.label}已${hit.level}标准（${hit.evidence}）。建议：本班次内通知防汛值班负责人，加密观测至每 2 小时一次，关注后续水雨情变化并做好升级准备。`,
  '蓝色': (hit) => `${hit.stationName} ${hit.label}命中${hit.level}关注档（${hit.evidence}）。建议：记录在案并提高关注等级，下一班次复核量值趋势。`,
}
