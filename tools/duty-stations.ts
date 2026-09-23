/**
 * `list_duty_stations`（值班报告面）：列出台账测站/指标/tagName/阈值档。
 *
 * 澄清槽位用（对照规划清单 T6）：模型在生成报告前用它确认可报测站与研判档位，
 * 避免编造 station_ids。纯配置投影，无网络调用。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { runKnowledgeTool } from './knowledge-common.ts'
import { askdataError } from '../src/errors.ts'
import type { ResultField } from '../src/result.ts'
import { severityForLevel } from '../src/duty/rules.ts'

const FIELDS: ResultField[] = [
  { name: 'stationId', title: '测站ID', type: 'string' },
  { name: 'stationName', title: '测站名称', type: 'string' },
  { name: 'metric', title: '指标', type: 'string' },
  { name: 'label', title: '指标名称', type: 'string' },
  { name: 'unit', title: '单位', type: 'string' },
  { name: 'tagName', title: 'AGP测点', type: 'string' },
  { name: 'thresholds', title: '阈值档', type: 'string' },
]

/** list_duty_stations 工具定义。 */
export const dutyStationsTool: AskdataTool = {
  name: 'list_duty_stations',
  description:
    '列出防汛值班报告的台账测站（id/名称/指标/AGP 测点/阈值档）。生成值班报告前用它确认 station_ids 与研判范围；台账未配置时返回配置指引。',
  layer: 'metadata',
  inputSchema: { type: 'object', properties: {} },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    return runKnowledgeTool(dutyStationsTool, args, ctx, async () => {
      const registry = ctx.config.duty.stations
      if (registry.length === 0) {
        throw askdataError(
          'INVALID_PARAM',
          '值班报告面未配置测站台账：在配置 duty.stations（测站/指标/tagName/阈值）与 duty.project 后可用',
        )
      }
      const data: Record<string, unknown>[] = []
      for (const station of registry) {
        for (const metric of station.metrics) {
          data.push({
            stationId: station.id,
            stationName: station.name,
            metric: metric.metric,
            label: metric.label,
            unit: metric.unit,
            tagName: metric.tagName,
            thresholds: (metric.thresholds ?? [])
              .map((t) => `${t.level}${t.op ?? '>='}${t.value} → ${severityForLevel(t.level)}`)
              .join('、') || '无（只汇总）',
          })
        }
      }
      return {
        apiOrSql: `duty.stations 台账投影：${registry.length} 站 / ${data.length} 指标`,
        apiUrl: '',
        fields: FIELDS,
        data,
      }
    })
  },
}

export const DUTY_STATIONS_FIELDS = FIELDS
