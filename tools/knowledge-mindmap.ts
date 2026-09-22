/**
 * `knowledge_mindmap`（知识面）：RAGFlow 脑图（mindmap 编译产物）层级导航。
 *
 * 对应 ragflow-import 的 mindmap_setup.py 在服务端的编译产物：规程/预案类文档的
 * 中心主题 → 主分支 → 子分支层级（has_branch/has_sub_branch 父子边）。
 * 与 knowledge_graph（关系网络）互补：脑图回答"某主题下有哪些分支、怎么分层"，
 * 适合应急响应分级、险情分类、物资保障这类结构化导航问题。
 *
 * 数据源：`GET /datasets/{id}/artifacts/structure?kind=mindmap`。
 * @module
 */

import type { AskdataTool } from './types.ts'
import type { ResultField } from '../src/result.ts'
import { requireKnowledge, runKnowledgeTool, truncate } from './knowledge-common.ts'
import { askdataError } from '../src/errors.ts'
import type { MindmapNode } from '../src/clients/ragflow.ts'

/** 单节点描述进入上下文的长度上限。 */
const MAX_DESC_CHARS = 160

const FIELDS: ResultField[] = [
  { name: 'level', title: '层级', type: 'number' },
  { name: 'path', title: '分支路径', type: 'string' },
  { name: 'node', title: '节点', type: 'string' },
  { name: 'nodeType', title: '节点类型', type: 'string' },
  { name: 'description', title: '说明', type: 'string' },
]

/** 深度优先展开森林为行（path 用 " > " 串起祖先，模型据此理解层级）。 */
function flatten(forest: MindmapNode[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  const walk = (node: MindmapNode, level: number, parents: string[]) => {
    rows.push({
      level,
      path: [...parents, node.name].join(' > '),
      node: node.name,
      nodeType: node.type,
      description: truncate(node.description, MAX_DESC_CHARS),
    })
    for (const child of node.children) walk(child, level + 1, [...parents, node.name])
  }
  for (const root of forest) walk(root, 0, [])
  return rows
}

/** knowledge_mindmap 工具定义。 */
export const knowledgeMindmapTool: AskdataTool = {
  name: 'knowledge_mindmap',
  description:
    '查桃曲坡水利知识库的脑图（mindmap）层级结构。给定关键词（如"应急响应""险情""物资"）过滤相关分支，'
    + '或留空取全量脑图概览。返回中心主题→主分支→子分支的层级导航（节点+路径+说明）。'
    + '适合回答"应急响应分几级""险情有哪些类型""抢险物资有哪些"这类结构化分层问题；'
    + '与 knowledge_graph（实体关系网络）互补。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        description: '分支关键词（中文，如"应急响应"）；留空返回全量脑图概览',
      },
    },
    required: [],
  },
  async run(args: Record<string, unknown>, ctx) {
    const keywords = String(args.keywords ?? '').trim()

    return runKnowledgeTool(knowledgeMindmapTool, args, ctx, async () => {
      const client = requireKnowledge(ctx)
      const forest = await client.mindmap({ keywords: keywords || undefined, signal: ctx.signal })
      const apiUrl = `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets/{id}/artifacts/structure`

      if (forest.length === 0) {
        return {
          apiOrSql: `GET /artifacts/structure?kind=mindmap${keywords ? ` keywords="${truncate(keywords, 30)}"` : ''} → 空`,
          apiUrl,
          fields: FIELDS,
          data: [{
            level: 0,
            path: '',
            node: keywords || '（全量）',
            nodeType: '',
            description: '知识库中没有已编译的脑图分支。该库可能未启用 mindmap 编译；可改用 knowledge_search 取证或 knowledge_graph 查关系。',
          }],
        }
      }

      const rows = flatten(forest)
      return {
        apiOrSql: `GET /artifacts/structure?kind=mindmap${keywords ? ` keywords="${truncate(keywords, 30)}"` : ''} → ${rows.length} 节点`,
        apiUrl,
        fields: FIELDS,
        data: rows,
      }
    })
  },
}

/** 供测试直接引用字段定义。 */
export const KNOWLEDGE_MINDMAP_FIELDS = FIELDS
