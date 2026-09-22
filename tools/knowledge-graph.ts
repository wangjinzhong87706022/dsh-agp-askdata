/**
 * `knowledge_graph`（知识面）：RAGFlow 实体关系子图查询。
 *
 * 对应 ragflow-import 的 graph 能力（graphrag_port 抽取产物在服务端的同构面）：
 * 以实体为中心展开一跳关系，或按关键词取关系概览。回答"某工程/某机构/某河流
 * 与哪些对象相关"这类结构化关联问题，也用于把问数里的中文名归一到标准实体
 * （实体别名表来自服务端 graph/wiki 编译产物）。
 *
 * 数据源：`GET /datasets/{id}/artifacts/graph`（node 中心扩展 / keywords 概览）。
 * @module
 */

import type { AskdataTool, ToolContext } from './types.ts'
import type { ResultField } from '../src/result.ts'
import { requireKnowledge, runKnowledgeTool, truncate } from './knowledge-common.ts'
import { askdataError } from '../src/errors.ts'
import { slugName } from '../src/clients/ragflow.ts'

/** 单实体描述进入上下文的长度上限。 */
const MAX_DESC_CHARS = 200

/** 单实体最大关联边数（防 hub 实体炸上下文）。 */
const MAX_ENTITY_EDGES = 30

const FIELDS: ResultField[] = [
  { name: 'entity', title: '实体', type: 'string' },
  { name: 'type', title: '类型', type: 'string' },
  { name: 'description', title: '描述', type: 'string' },
  { name: 'relations', title: '关联（出/入）', type: 'string' },
]

/** knowledge_graph 工具定义。 */
export const knowledgeGraphTool: AskdataTool = {
  name: 'knowledge_graph',
  description:
    '查询桃曲坡水利知识图谱的实体关系子图。给定实体名（如"桃曲坡水库""沮河"）展开其全部关联对象与关系，'
    + '或给定关键词取关系概览。用于回答"某工程/机构/河流与哪些对象相关"的结构化关联问题，'
    + '以及把中文别名归一到标准实体名。返回实体清单（含类型与描述）与关系边清单。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        description: '中心实体名（中文，如"桃曲坡水库"）；与 keywords 二选一，优先本参数',
      },
      keywords: {
        type: 'string',
        description: '概览种子关键词（entity 未提供时生效，如"防洪调度"）',
      },
      top_n: { type: 'number', description: '实体预算，默认取 knowledge.maxGraphEntities，上限 1024' },
    },
    required: [],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const entity = String(args.entity ?? '').trim()
    const keywords = String(args.keywords ?? '').trim()
    if (!entity && !keywords) {
      return runKnowledgeTool(knowledgeGraphTool, args, ctx, async () => {
        throw askdataError('INVALID_PARAM', 'entity 与 keywords 至少提供一个')
      })
    }
    const requested = Number(args.top_n)
    const topN = Number.isFinite(requested)
      ? Math.min(1024, Math.max(1, Math.trunc(requested)))
      : ctx.config.knowledge.maxGraphEntities

    return runKnowledgeTool(knowledgeGraphTool, args, ctx, async () => {
      const client = requireKnowledge(ctx)
      const sub = await client.subgraph({ node: entity || undefined, keywords: entity ? undefined : keywords, topN, signal: ctx.signal })

      if (sub.entities.length === 0) {
        return {
          apiOrSql: `GET /artifacts/graph ${entity ? `node="${entity}"` : `keywords="${truncate(keywords, 40)}"`} → 0 实体`,
          apiUrl: `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/{id}/artifacts/graph`,
          fields: FIELDS,
          data: [{
            entity: entity || keywords,
            type: '',
            description: '知识图谱中没有检索到相关实体。请换用更规范的名称（全称）重试；若仍为空，说明图谱未覆盖该对象。',
            relations: '',
          }],
        }
      }

      // 关联边按实体聚合：一行实体 + 压缩的关系串（控制上下文体积）
      const edgesBySlug = new Map<string, string[]>()
      for (const rel of sub.relations) {
        const push = (slug: string, other: string) => {
          const list = edgesBySlug.get(slug) ?? []
          if (list.length < MAX_ENTITY_EDGES) {
            list.push(other)
            edgesBySlug.set(slug, list)
          }
        }
        push(rel.from, rel.to)
        push(rel.to, rel.from)
      }

      const data = sub.entities.map((e) => ({
        entity: e.name,
        type: e.type,
        description: truncate(e.description, MAX_DESC_CHARS),
        relations: (edgesBySlug.get(e.slug) ?? [])
          .map((s) => slugName(s))
          .join('、'),
      }))
      // 中心实体排第一（node 模式时即 center；概览模式按权重）
      if (entity) {
        const target = slugName(sub.center ?? `entity/${entity}`)
        data.sort((a, b) => (a.entity === target ? -1 : b.entity === target ? 1 : 0))
      }

      return {
        apiOrSql: `GET /artifacts/graph ${entity ? `node="${entity}"` : `keywords="${truncate(keywords, 40)}"`} top_n=${topN} → ${sub.entities.length} 实体 / ${sub.relations.length} 关系`,
        apiUrl: `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/{id}/artifacts/graph`,
        fields: FIELDS,
        data,
      }
    })
  },
}

/** 供测试直接引用字段定义。 */
export const KNOWLEDGE_GRAPH_FIELDS = FIELDS
