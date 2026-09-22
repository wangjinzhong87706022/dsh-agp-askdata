/**
 * `knowledge_search`（知识面）：RAGFlow 知识库原文片段检索。
 *
 * 取数面（TSDB）回答"数值是多少"，知识面回答"依据是什么"。凡涉及规程、预案、
 * 标准、历史洪水过程等需要资料佐证的问题，先调本工具取证，再结合取数结果作答。
 *
 * 与 dsh-plugins/lingzhi-knowledge-tool 的 searchDatasets 契约一致
 * （POST /datasets/search；HTTP 200 + code≠0 = 业务失败）。
 * 增强（2026-09-22）：meta_filter 元数据硬过滤（按场次洪水/文档类型收敛证据）、
 * labels 标签分布回显（标签库软重排命中，引用可分类追溯）。
 * @module
 */

import type { AskdataTool } from './types.ts'
import type { ToolContext } from './types.ts'
import type { ResultField } from '../src/result.ts'
import { requireKnowledge, runKnowledgeTool, truncate } from './knowledge-common.ts'
import { askdataError } from '../src/errors.ts'
import type { KnowledgeLabels } from '../src/clients/ragflow.ts'

/** 单条片段进入模型上下文的正文上限（防止长片段挤占上下文）。 */
const MAX_CHUNK_CHARS = 800

const FIELDS: ResultField[] = [
  { name: 'rank', title: '序号', type: 'number' },
  { name: 'document', title: '出处文档', type: 'string' },
  { name: 'similarity', title: '相关度', type: 'number' },
  { name: 'content', title: '证据片段', type: 'string' },
  { name: 'chunkId', title: '片段ID', type: 'string' },
  { name: 'pageNum', title: '页码', type: 'number' },
]

/** 标签分布 → 一行可读摘要（"2021-09×2、洪水资料×1"）。 */
function renderLabels(labels: KnowledgeLabels): string {
  const entries = Object.entries(labels).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return ''
  return entries.map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join('、')
}

/** knowledge_search 工具定义。 */
export const knowledgeSearchTool: AskdataTool = {
  name: 'knowledge_search',
  description:
    '在桃曲坡水利知识库（RAGFlow）中检索原文证据片段。输入完整中文问题，返回按相关度排序的片段及出处文档名/页码。'
    + '凡需要依据行业资料回答的问题（规程、预案、标准、洪水过程、工程参数口径），都必须先调用本工具取证；'
    + '结论只能来自返回片段并标注出处；检索不到时明确说明资料不足，不得编造。'
    + '可按元数据收窄证据范围（如只查某场次洪水 flood_event=2021-09、只查表格类文档 doc_type=表格）。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索问题，用完整中文疑问句（例如"桃曲坡水库主汛期的汛限水位是多少"）',
      },
      top_k: { type: 'number', description: '返回条数，默认取 knowledge.maxChunks 配置，上限 50' },
      meta_filter: {
        type: 'object',
        description:
          '元数据硬过滤（可选）：{conditions:[{key,op,value}], logic:"and"|"or"} 或 [{key,op,value}]。'
          + '常用 key：flood_event（场次洪水，如 2021-09）、doc_type（文本/表格）、quality、doc_category；op 用 =',
      },
    },
    required: ['query'],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? '').trim()
    if (!query) {
      return runKnowledgeTool(knowledgeSearchTool, args, ctx, async () => {
        throw askdataError('INVALID_PARAM', 'query 不能为空')
      })
    }
    const requested = Number(args.top_k)
    const topK = Number.isFinite(requested)
      ? Math.min(50, Math.max(1, Math.trunc(requested)))
      : ctx.config.knowledge.maxChunks
    const metaFilter = args.meta_filter as Record<string, unknown> | Array<Record<string, unknown>> | undefined

    return runKnowledgeTool(knowledgeSearchTool, args, ctx, async () => {
      const client = requireKnowledge(ctx)
      const { chunks, labels } = await client.searchChunks(query, { topK, metaFilter, signal: ctx.signal })
      const apiUrl = `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/search`
      const filterNote = metaFilter ? ` meta=${truncate(JSON.stringify(metaFilter), 60)}` : ''
      const apiOrSql = `POST /datasets/search question="${truncate(query, 60)}" top_k=${topK}${filterNote} → ${chunks.length} 段`

      if (chunks.length === 0) {
        // 空结果不是错误：返回一行指引，模型据此说明"资料不足"
        return {
          apiOrSql: `${apiOrSql}（空）`,
          apiUrl,
          fields: FIELDS,
          data: [{
            rank: 0,
            document: '',
            similarity: 0,
            content: metaFilter
              ? '该元数据过滤条件下没有检索到证据片段。请放宽或去掉 meta_filter 重试；若仍为空，在结论中明确说明「现有资料无法支撑该问题」。'
              : '知识库中没有检索到相关证据片段。请换一种问法重试；若仍为空，在结论中明确说明「现有资料无法支撑该问题」。',
            chunkId: '',
            pageNum: 0,
          }],
        }
      }

      const labelText = renderLabels(labels)
      const data: Record<string, unknown>[] = []
      if (labelText) {
        // 标签汇总行（rank=0）：告知命中片段属于哪场洪水/哪类资料，引用可分类追溯
        data.push({
          rank: 0,
          document: '（命中标签）',
          similarity: 0,
          content: `命中片段的标签分布：${labelText}（来自标签库软重排，可作为引用分类标注）`,
          chunkId: '',
          pageNum: 0,
        })
      }
      for (const [index, chunk] of chunks.entries()) {
        data.push({
          rank: index + 1,
          document: chunk.documentName || chunk.documentId || '未知文档',
          similarity: chunk.similarity === null ? 0 : Number(chunk.similarity.toFixed(4)),
          content: truncate(chunk.content, MAX_CHUNK_CHARS),
          chunkId: chunk.chunkId ?? '',
          pageNum: chunk.pageNum ?? 0,
        })
      }
      return { apiOrSql, apiUrl, fields: FIELDS, data }
    })
  },
}

/** 供测试直接引用字段定义（避免魔法字符串）。 */
export const KNOWLEDGE_SEARCH_FIELDS = FIELDS
