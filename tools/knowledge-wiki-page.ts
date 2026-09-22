/**
 * `knowledge_wiki_page`（知识面）：RAGFlow wiki 百科页面全文。
 *
 * 对应 ragflow-import 的 wiki 能力（wiki_port 页面合成/互链在服务端的同构面）：
 * 每实体一页、带出链与关联页面。knowledge_search 命中出处后，用本工具取该实体
 * 的完整页面获得全景描述；也支持关键词直接定位页面。
 *
 * 数据源：`GET /datasets/{id}/artifacts`（清单）+ `GET /datasets/{id}/artifacts/{pt}/{slug}`（全文）。
 * @module
 */

import type { AskdataTool } from './types.ts'
import type { ResultField } from '../src/result.ts'
import { requireKnowledge, runKnowledgeTool, truncate } from './knowledge-common.ts'
import { askdataError } from '../src/errors.ts'

/** 页面正文进入上下文的长度上限（百科页 200-500 字，封顶从宽）。 */
const MAX_PAGE_CHARS = 4000

const FIELDS: ResultField[] = [
  { name: 'title', title: '页面标题', type: 'string' },
  { name: 'pageType', title: '页面类型', type: 'string' },
  { name: 'topic', title: '主题分组', type: 'string' },
  { name: 'summary', title: '摘要', type: 'string' },
  { name: 'content', title: '页面正文(Markdown)', type: 'string' },
  { name: 'outlinks', title: '出链页面', type: 'string' },
  { name: 'relatedPages', title: '关联页面', type: 'string' },
]

/** knowledge_wiki_page 工具定义。 */
export const knowledgeWikiPageTool: AskdataTool = {
  name: 'knowledge_wiki_page',
  description:
    '取桃曲坡水利知识库的 wiki 百科页面全文。输入实体页面 slug（如 "entity/桃曲坡水库"）或实体名/关键词'
    + '（自动定位最贴合的页面）。页面含摘要、正文与出链/关联页面，用于在 knowledge_search 命中后深入了解'
    + '某实体（工程、机构、规程、概念）的全景描述。',
  layer: 'base_business',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: '页面 slug（"<page_type>/<名称>"，如 entity/桃曲坡水库）；与 keywords 二选一，优先本参数',
      },
      keywords: {
        type: 'string',
        description: '实体名或关键词（slug 未提供时按它定位最贴合的页面）',
      },
    },
    required: [],
  },
  async run(args: Record<string, unknown>, ctx) {
    const slug = String(args.slug ?? '').trim()
    const keywords = String(args.keywords ?? '').trim()
    if (!slug && !keywords) {
      return runKnowledgeTool(knowledgeWikiPageTool, args, ctx, async () => {
        throw askdataError('INVALID_PARAM', 'slug 与 keywords 至少提供一个')
      })
    }

    return runKnowledgeTool(knowledgeWikiPageTool, args, ctx, async () => {
      const client = requireKnowledge(ctx)
      const page = await client.getPage(slug || keywords, { signal: ctx.signal })
      const base = `${ctx.config.knowledge.ragflowBaseUrl}/api/v1/datasets`
      if (!page) {
        return {
          apiOrSql: `GET /artifacts/${slug || keywords} → 未找到页面`,
          apiUrl: `${base}/{id}/artifacts`,
          fields: FIELDS,
          data: [{
            title: slug || keywords,
            pageType: '',
            topic: '',
            summary: '知识库中没有该 wiki 页面。请换用更规范的实体全称重试，或先用 knowledge_search 取证。',
            content: '',
            outlinks: '',
            relatedPages: '',
          }],
        }
      }
      return {
        apiOrSql: `GET /artifacts/${page.slug} → ${truncate(page.title, 30)}`,
        apiUrl: `${base}/${page.datasetId}/artifacts/${page.slug}`,
        fields: FIELDS,
        data: [{
          title: page.title,
          pageType: page.pageType,
          topic: page.topic,
          summary: page.summary,
          content: truncate(page.contentMd, MAX_PAGE_CHARS),
          outlinks: page.outlinks.slice(0, 30).join('、'),
          relatedPages: page.relatedPages.slice(0, 30).join('、'),
        }],
      }
    })
  },
}

/** 供测试直接引用字段定义。 */
export const KNOWLEDGE_WIKI_PAGE_FIELDS = FIELDS
