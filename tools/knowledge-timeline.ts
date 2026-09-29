/**
 * `knowledge_timeline`（知识面）：RAGFlow 时间线（timeline 编译产物，timestamp
 * 实体 + ordered 时序边）。回答"某场洪水/某时段的事件时间线、先后顺序、过程
 * 回顾"这类时序结构问题——与 knowledge_search（原文取证）互补：search 给片段，
 * timeline 给按时间排序的结构化事件轴。
 *
 * 时间归一：年/年月/年月日[时分[秒]] 升序排列；月日+时刻但无年份的实体单独归
 * "未定时"组附后（跨年歧义不硬排）；非时间名的抽取噪声同样不入轴（T4 用例）。
 * 数据源：`GET /datasets/{id}/artifacts/structure?kind=timeline`（仅在洪水
 * 资料库编译，规程库为空——空结果给指引行）。
 * @module
 */

import type { AskdataTool } from './types.ts'
import type { ResultField } from '../src/result.ts'
import { requireKnowledge, runKnowledgeTool, truncate } from './knowledge-common.ts'
import type { ToolContext } from './types.ts'

/** 单事件摘要进入上下文的长度上限。 */
const MAX_EVENT_CHARS = 200

/**
 * 模型可见行数上限：事件表即答案本体，预算（knowledge.maxGraphEntities，服务端
 * 413 实体上限）封顶后全部可见，渲染层不再二次截断。
 */
const PREVIEW_LIMIT = 1024

const FIELDS: ResultField[] = [
  { name: 'seq', title: '序号', type: 'number' },
  { name: 'time', title: '时间（原始口径）', type: 'string' },
  { name: 'granularity', title: '粒度', type: 'string' },
  { name: 'event', title: '事件（报汛/洪峰/调度动作）', type: 'string' },
  { name: 'sourceChunks', title: '来源片段数', type: 'number' },
]

/** knowledge_timeline 工具定义。 */
export const knowledgeTimelineTool: AskdataTool = {
  name: 'knowledge_timeline',
  description:
    '查询桃曲坡水利知识库的时间线（timeline）：按时间顺序列出某场次洪水/某时段的报汛、洪峰、调度动作等关键节点。'
    + '给定关键词（如"2021年9月"、"2021-10"、场次描述）过滤相关时段，留空返回全量概览。'
    + '适合回答"那场洪水的过程时间线""先后发生了什么""关键节点有哪些"这类时序结构问题；'
    + '与 knowledge_search（原文片段取证）互补。',
  layer: 'base_business',
  previewLimit: PREVIEW_LIMIT,
  inputSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        description: '时段/场次关键词（如"2021-09"、"2021年9月"、"2021-10"）；留空返回全量概览',
      },
    },
    required: [],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const keywords = String(args.keywords ?? '').trim()

    return runKnowledgeTool(knowledgeTimelineTool, args, ctx, async () => {
      const client = requireKnowledge(ctx)
      let partialFailure = ''
      const outcome = await client.timeline({
        keywords: keywords || undefined,
        signal: ctx.signal,
        onPartialFailure: (failed, total) => {
          partialFailure = `（${failed}/${total} 数据集失败，结果可能不完整）`
        },
      })
      const apiUrl = `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/{id}/artifacts/structure`
      const call = `GET /artifacts/structure?kind=timeline${keywords ? ` keywords="${truncate(keywords, 30)}"` : ''}`
      const budgetNote = outcome.truncated
        ? `（仅展开 ${outcome.events.length + outcome.undated.length}/${outcome.total} 节点：受 knowledge.maxGraphEntities 预算限制）`
        : ''

      if (outcome.events.length === 0 && outcome.undated.length === 0) {
        return {
          apiOrSql: `${call} → 空${partialFailure}${budgetNote}`,
          apiUrl,
          fields: FIELDS,
          data: [{
            seq: 0,
            time: keywords || '（全量）',
            granularity: '',
            event: '知识库中没有该时段的时间线节点。该库可能未编译 timeline；可改用 knowledge_search（可加 meta_filter 限定场次）取证。',
            sourceChunks: 0,
          }],
        }
      }

      const data: Record<string, unknown>[] = []
      outcome.events.forEach((e, i) => {
        data.push({
          seq: i + 1,
          time: e.time,
          granularity: e.granularity,
          event: truncate(e.event, MAX_EVENT_CHARS),
          sourceChunks: e.sourceChunks,
        })
      })
      for (const e of outcome.undated) {
        data.push({
          seq: data.length + 1,
          time: e.time,
          granularity: '未定时',
          event: truncate(e.event, MAX_EVENT_CHARS),
          sourceChunks: e.sourceChunks,
        })
      }
      return {
        apiOrSql: `${call} → ${outcome.events.length} 定时事件 / ${outcome.undated.length} 未定时${partialFailure}${budgetNote}`,
        apiUrl,
        fields: FIELDS,
        data,
      }
    })
  },
}

/** 供测试直接引用字段定义。 */
export const KNOWLEDGE_TIMELINE_FIELDS = FIELDS
