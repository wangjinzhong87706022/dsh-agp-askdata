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

/** 关联串里谓词的长度上限（keywords 回退来源可能偏长）。 */
const MAX_PREDICATE_CHARS = 24

/**
 * 模型可见行数 = 实体预算（top_n / knowledge.maxGraphEntities），渲染层不再二次
 * 截断——预算旋钮就是截断旋钮，声明 1024（服务端 top_n 上限）让配置真实生效，
 * 避免落回 system.defaultPreviewLimit=20 后"配 60 只见 20"的旋钮失真。
 */
const PREVIEW_LIMIT = 1024

const FIELDS: ResultField[] = [
  { name: 'entity', title: '实体', type: 'string' },
  { name: 'type', title: '类型', type: 'string' },
  { name: 'description', title: '描述', type: 'string' },
  { name: 'relations', title: '关联（→出边 ←入边）', type: 'string' },
]

/** 一条关联边在聚合桶里的展示形态：对端 + 方向 + 谓词。 */
interface EdgeEntry {
  other: string
  predicate: string
  dir: 'out' | 'in'
}

/** 单实体的关联边聚合：shown 为截断后保留的边，total 为实际边数。 */
interface EdgeBucket {
  shown: EdgeEntry[]
  total: number
}

/**
 * 关联串渲染：`→沮河(位于)、←水库管理局(管理)`——方向与谓词保留（这是关系语义
 * 的全部：只有邻居名时模型只能说"相关"，说不清怎么相关）；同对端同向的多条
 * 关系各自成项；超出上限时标注总数。
 */
function renderRelations(bucket: EdgeBucket | undefined): string {
  if (!bucket || bucket.shown.length === 0) return ''
  const labels: string[] = []
  for (const e of bucket.shown) {
    const label = `${e.dir === 'out' ? '→' : '←'}${slugName(e.other)}${e.predicate ? `(${e.predicate})` : ''}`
    if (!labels.includes(label)) labels.push(label)
  }
  const text = labels.join('、')
  return bucket.total > bucket.shown.length
    ? `${text}（共 ${bucket.total} 条关联，仅列前 ${bucket.shown.length} 条）`
    : text
}

/** knowledge_graph 工具定义。 */
export const knowledgeGraphTool: AskdataTool = {
  name: 'knowledge_graph',
  description:
    '查询桃曲坡水利知识图谱的实体关系子图。给定实体名（如"桃曲坡水库""沮河"）展开其全部关联对象与关系，'
    + '或给定关键词取关系概览。用于回答"某工程/机构/河流与哪些对象相关"的结构化关联问题，'
    + '以及把中文别名归一到标准实体名。返回实体清单（含类型与描述）与关联串（→出边 ←入边，带关系谓词）。',
  layer: 'base_business',
  previewLimit: PREVIEW_LIMIT,
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
      top_n: { type: 'number', description: '实体预算，默认取 knowledge.maxGraphEntities（60），上限 1024；超过 200 会显著占用上下文，确有必要才调高' },
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
      // 部分数据集失败在 apiOrSql 留痕（审计哈希链可见），证据完整性受损不静默
      let partialFailure = ''
      const sub = await client.subgraph({
        node: entity || undefined,
        keywords: entity ? undefined : keywords,
        topN,
        signal: ctx.signal,
        onPartialFailure: (failed, total) => {
          partialFailure = `（${failed}/${total} 数据集失败，结果可能不完整）`
        },
      })
      const call = `GET /artifacts/graph ${entity ? `node="${entity}"` : `keywords="${truncate(keywords, 40)}"`}`

      if (sub.entities.length === 0) {
        return {
          apiOrSql: `${call} → 0 实体${partialFailure}`,
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

      // 关联边按实体聚合：一行实体 + 压缩的关系串（控制上下文体积；超限标注总数）
      const edgesBySlug = new Map<string, EdgeBucket>()
      const bump = (slug: string, other: string, predicate: string, dir: 'out' | 'in') => {
        const bucket = edgesBySlug.get(slug) ?? { shown: [], total: 0 }
        bucket.total += 1
        if (bucket.shown.length < MAX_ENTITY_EDGES) bucket.shown.push({ other, predicate, dir })
        edgesBySlug.set(slug, bucket)
      }
      for (const rel of sub.relations) {
        const predicate = truncate(rel.predicate, MAX_PREDICATE_CHARS)
        bump(rel.from, rel.to, predicate, 'out')
        bump(rel.to, rel.from, predicate, 'in')
      }

      const data = sub.entities.map((e) => ({
        entity: e.name,
        type: e.type,
        description: truncate(e.description, MAX_DESC_CHARS),
        relations: renderRelations(edgesBySlug.get(e.slug)),
      }))
      // 中心实体排第一（node 模式时即 center；概览模式按权重）
      if (entity) {
        const target = slugName(sub.center ?? `entity/${entity}`)
        data.sort((a, b) => (a.entity === target ? -1 : b.entity === target ? 1 : 0))
      }

      return {
        apiOrSql: `${call} top_n=${topN} → ${sub.entities.length} 实体 / ${sub.relations.length} 关系${partialFailure}`,
        apiUrl: `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/{id}/artifacts/graph`,
        fields: FIELDS,
        data,
      }
    })
  },
}

/** 供测试直接引用字段定义。 */
export const KNOWLEDGE_GRAPH_FIELDS = FIELDS
