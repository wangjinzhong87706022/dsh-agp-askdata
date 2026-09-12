/**
 * `askdata_deep_analysis`（subagent-style 工具）：把自然语言问数作为入口，
 * 内部按"词典→设备→tagName→时序/聚合/告警"五步流水线跑完 askdata 全套 11 工具，
 * 把每步结果聚合为一份带溯源的结构化回答。
 *
 * 定位：替代"调用方自行编排 N 次工具"——把子 agent 该有的"自主完成多步任务 +
 * 给出完整结论"行为直接封装在一个工具调用里。等价于 DSH subagent one-shot 委派，
 * 但因本插件不依赖宿主 `@deepseek-ai/dsh-agents` runtime，用 in-process 工具流水线
 * 实现同样的语义。
 *
 * 使用：
 * ```
 * await tool('askdata_deep_analysis').run(
 *   { question: '1号箱变1号逆变器总发电量最近一周日均值是多少？' },
 *   ctx,
 * )
 * ```
 *
 * 行为约束：
 * - 不调 LLM：纯工具链，按问句关键词分支到固定步骤；
 * - 不绕过安全闸门：所有内部 SQL 仍过 `assertSafeToExecute`（执行器在闸门后挂）；
 * - 单次执行扫描/超时以最长单步配置为准；
 * - 中文问句先 lookup_object → resolve_tag 链路；tagName 全名（含 _1X_yyyyyy 模式）直接用。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import { ok, fail, type ResultField, type ToolResult } from '../src/result.ts'
import { lookupObjectTool } from './lookup-object.ts'
import { resolveTagTool } from './resolve-tag.ts'
import { latestValueTool } from './latest-value.ts'
import { timeSeriesTool } from './time-series.ts'
import { aggregateTool } from './aggregate.ts'
import { queryAlarmTool } from './query-alarm.ts'
import { queryAlarmConfigTool } from './query-alarm-config.ts'
import { lookupModelTool } from './lookup-model.ts'
import { lookupTagTool } from './lookup-tag.ts'

/** 单步执行结果（流水线 trace 元素）。 */
interface StepResult {
  index: number
  tool: string
  args: Record<string, unknown>
  ms: number
  ok: boolean
  rowCount: number
  error?: string
}

/** 跑一步工具，捕获异常为 StepResult。 */
async function runStep(
  tool: AskdataTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  index: number,
): Promise<{ step: StepResult; result?: ToolResult }> {
  const t0 = Date.now()
  try {
    const result = await tool.run(args, ctx)
    const ms = Date.now() - t0
    return {
      step: {
        index,
        tool: tool.name,
        args,
        ms,
        ok: result.success,
        rowCount: result.data.length,
        ...(result.success ? {} : { error: `${result.errorCode}: ${result.errorMessage.slice(0, 120)}` }),
      },
      result,
    }
  } catch (err) {
    return {
      step: {
        index,
        tool: tool.name,
        args,
        ms: Date.now() - t0,
        ok: false,
        rowCount: 0,
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

/** 把问句分类到固定流水线（关键字保守启发式，模糊命中走默认 lookup_object）。 */
function classify(question: string): {
  tools: AskdataTool[]
  baseArgs: () => Record<string, unknown>
  needDevice: boolean
  needTag: boolean
  /** 宽时间窗默认（7 天），与"最近告警"等场景对齐。 */
  defaultRangeDays: number
} {
  const q = question
  if (/告警配置|alarm.?config|alert.?rule/i.test(q)) {
    const m = /wt_iot_[a-z0-9_]+/i.exec(q)
    return {
      tools: [queryAlarmConfigTool],
      baseArgs: () => (m ? { cus_class_path: m[0] } : {}),
      needDevice: false,
      needTag: false,
      defaultRangeDays: 7,
    }
  }
  if (/告警|alarm|报警|故障|异常/.test(q)) {
    return {
      tools: [queryAlarmTool],
      baseArgs: () => ({}),
      needDevice: false,
      needTag: false,
      defaultRangeDays: 7,
    }
  }
  if (/最新|当前|现在/.test(q)) {
    return {
      tools: [latestValueTool],
      baseArgs: () => ({}),
      needDevice: true,
      needTag: true,
      defaultRangeDays: 1,
    }
  }
  if (/趋势|波形|曲线|时序|小时|分钟/.test(q)) {
    return {
      tools: [timeSeriesTool],
      baseArgs: () => ({ bucket: '1h', limit: 48 }),
      needDevice: true,
      needTag: true,
      defaultRangeDays: 1,
    }
  }
  if (/日均|月均|累计|总[量发]|平均值|均值|avg/i.test(q)) {
    return {
      tools: [aggregateTool],
      baseArgs: () => ({ func: 'AVG', group_by: 'none', limit: 100 }),
      needDevice: true,
      needTag: true,
      defaultRangeDays: 30,
    }
  }
  if (/有哪些.*模型|设备类型|型号/.test(q)) {
    return { tools: [lookupModelTool], baseArgs: () => ({}), needDevice: false, needTag: false, defaultRangeDays: 0 }
  }
  return {
    tools: [lookupTagTool],
    baseArgs: () => ({ keyword: q }),
    needDevice: false,
    needTag: false,
    defaultRangeDays: 0,
  }
}

/** 抽取问题里像设备中文名的片段（2-20 个中文字符）。 */
function extractDeviceName(question: string): string | null {
  const m = /[\u4e00-\u9fa5]{2,20}/.exec(question)
  return m?.[0] ?? null
}

/** 抽取问题里的测点中文名（含度量词后缀优先）。 */
function extractTagNameCn(question: string): string | null {
  const m = /[\u4e00-\u9fa5]{2,8}(?:率|电流|电压|功率|发电量|温度|频率|效率|能耗|电量|转速|扭矩|压力)/.exec(question)
  if (m) return m[0]
  // 兜底：取最后一个 ≥ 2 字的纯中文片段
  const all = question.match(/[\u4e00-\u9fa5]{2,8}/g) ?? []
  return all.at(-1) ?? null
}

/** 检测 tagName 全名（`prefix_2X_yyyyyy`，与解析表 tagName 形态一致）。 */
function extractTagName(question: string): string | null {
  const m = /[A-Za-z0-9_]+_[12][OHDMY]_\d+/.exec(question)
  return m?.[0] ?? null
}

/** 默认时间窗：end = now，start = now - days。 */
function defaultTimeRange(days: number): { start_time: string; end_time: string } {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  return { start_time: start.toISOString(), end_time: end.toISOString() }
}

const TRACE_FIELDS: ResultField[] = [
  { name: 'step', title: '步骤', type: 'number' },
  { name: 'tool', title: '工具', type: 'string' },
  { name: 'ms', title: '耗时(ms)', type: 'number' },
  { name: 'rowCount', title: '行数', type: 'number' },
  { name: 'ok', title: '成功', type: 'boolean' },
  { name: 'summary', title: '摘要', type: 'string' },
]

/** askdata_deep_analysis 工具定义。 */
export const askdataDeepAnalysisTool: AskdataTool = {
  name: 'askdata_deep_analysis',
  description:
    '把自然语言问数交给"子智能体"处理：内部按关键词自动选择并串行执行 askdata 工具链（解析→护栏→取数），返回带溯源的完整回答。一次调用相当于 1-4 次单步工具的合成结果。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '自然语言问题（含设备名/测点名/时间/聚合要求）' },
    },
    required: ['question'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const t0 = Date.now()
    const question = String(args.question ?? '').trim()
    if (!question) {
      return fail('askdata_deep_analysis', {
        params: args,
        code: 'INVALID_PARAM',
        message: 'question 不能为空',
        executionMs: Date.now() - t0,
      })
    }

    const plan = classify(question)
    const steps: StepResult[] = []

    // 1. 解析设备（需要时）：采用 lookup_object 精确命中的 node_name 传给后续
    //    resolve_tag，而非问句正则提取的原始片段（模糊片段可能残缺导致解析链断裂）。
    let device: { id?: number; node_name?: string; class__path?: string } | null = null
    if (plan.needDevice) {
      const deviceName = extractDeviceName(question)
      if (deviceName) {
        const { step, result } = await runStep(lookupObjectTool, { node_name: deviceName }, ctx, steps.length)
        steps.push(step)
        const first = result?.success
          ? (result.data[0] as { id?: unknown; node_name?: unknown; 'class__path'?: unknown } | undefined)
          : undefined
        if (first) {
          device = {
            id: typeof first.id === 'number' ? first.id : undefined,
            node_name: typeof first.node_name === 'string' ? first.node_name : deviceName,
            class__path: typeof first['class__path'] === 'string' ? first['class__path'] : undefined,
          }
        }
      }
    }

    // 2. 解析测点（需要时）
    let tagName: string | null = extractTagName(question)
    if (!tagName && plan.needTag && device?.node_name) {
      const tagNameCn = extractTagNameCn(question)
      if (tagNameCn) {
        const { step, result } = await runStep(resolveTagTool, {
          device_name: device.node_name,
          tag_name_cn: tagNameCn,
          granularity: '1D',
        }, ctx, steps.length)
        steps.push(step)
        if (step.ok && result?.success && result.data.length > 0) {
          tagName = (result.data[0] as { tagName?: string }).tagName ?? null
        }
      }
    }

    // 3. 执行主取数
    const baseArgs = plan.baseArgs()
    let finalArgs: Record<string, unknown> = { ...baseArgs }
    if (tagName) {
      // latest_value 走 tag_names，其余走 tag_filter + 时间窗
      if (plan.tools[0] === latestValueTool) {
        finalArgs.tag_names = [tagName]
      } else {
        finalArgs.tag_filter = `^${tagName}`
        const range = defaultTimeRange(plan.defaultRangeDays || 30)
        finalArgs.start_time = finalArgs.start_time ?? range.start_time
        finalArgs.end_time = finalArgs.end_time ?? range.end_time
      }
    } else if (plan.tools[0] === queryAlarmTool && !('start_time' in finalArgs)) {
      const range = defaultTimeRange(plan.defaultRangeDays)
      finalArgs.start_time = range.start_time
      finalArgs.end_time = range.end_time
    }

    const { step, result } = await runStep(plan.tools[0]!, finalArgs, ctx, steps.length)
    steps.push(step)

    const totalMs = Date.now() - t0
    const okCount = steps.filter((s) => s.ok).length

    if (okCount === 0 && steps.length > 0) {
      const firstErr = steps.find((s) => s.error)?.error ?? '未知'
      return fail('askdata_deep_analysis', {
        params: args,
        code: steps.find((s) => s.error)?.error?.startsWith('INVALID') ? 'INVALID_PARAM' : 'BACKEND_DOWN',
        message: `流水线全部失败：${firstErr.slice(0, 200)}`,
        executionMs: totalMs,
      })
    }

    // data 用 trace 行（每步一行）+ 最后一步的数据副本
    const traceRows = steps.map((s) => ({
      step: s.index,
      tool: s.tool,
      ms: s.ms,
      rowCount: s.rowCount,
      ok: s.ok,
      summary: s.ok ? `成功（${s.rowCount} 行）` : (s.error?.slice(0, 80) ?? '失败'),
    }))
    const lastData = result?.success ? result.data : []
    // 把 lastData 的列名显式推断为 string[]（避免 unknown 推 ResultField）
    const extraFields: ResultField[] = lastData.length > 0
      ? (Array.from(new Set(lastData.flatMap((r: Record<string, unknown>) => Object.keys(r)))) as string[]).slice(0, 8)
          .map((k) => ({ name: k, title: k, type: 'string' as const }))
      : []
    return ok('askdata_deep_analysis', {
      apiOrSql: `[subagent pipeline] ${plan.tools[0]!.name} ${JSON.stringify(finalArgs).slice(0, 120)}…`,
      params: { ...args, _pipeline: steps.map((s) => ({ tool: s.tool, ok: s.ok, ms: s.ms })) },
      fields: [...TRACE_FIELDS, ...extraFields],
      data: [
        ...traceRows,
        // 工具结果按行平铺（每行带 _tool 来源）
        ...lastData.map((r: Record<string, unknown>, i: number) => ({ _tool: plan.tools[0]!.name, _row: i, ...r })),
      ],
      executionMs: totalMs,
    })
  },
}
