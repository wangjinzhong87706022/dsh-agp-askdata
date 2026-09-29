/**
 * 知识面评测锚点探针（运维用，不随 vitest 跑）：只读端点拉线上真实产物，
 * 输出 JSON 供 docs/knowledge-eval-*.md 的锚点快照对照/刷新。
 *
 * 用法：RAGFLOW_API_KEY=<该租户key> pnpm tsx scripts/knowledge-eval-probe.ts [tqp|jhq|zuhe]
 * （API key 走环境变量注入，不落盘不进输出；租户 id 决定 datasetIds。）
 */
import { RagflowClient } from '../src/clients/ragflow.ts'
import { resolveKnowledgeConfig } from '../src/config.ts'

/** 各租户的检索目标数据集（与 AGENTS.md「RAGFlow 多租户凭据」表保持同步）。 */
const TENANT_DATASETS: Record<string, string[]> = {
  tqp: ['fda7a510a87c11f1998b3dc126099a8d', 'fdfee2e4a87c11f1998b3dc126099a8d'],
  jhq: ['7a96e5eab69211f18f992bf5359454d9', '7a92958ab69211f18f992bf5359454d9', '7a8d7082b69211f18f992bf5359454d9'],
  zuhe: ['ec5591d4ac0d11f1b8ab3155a5f51bf7'],
}

const tenant = (process.argv[2] ?? 'tqp').trim()
const datasetIds = TENANT_DATASETS[tenant]
if (!datasetIds) {
  console.error(`未知租户: ${tenant}（可选：${Object.keys(TENANT_DATASETS).join(' / ')}）`)
  process.exit(1)
}

const config = resolveKnowledgeConfig({
  ragflowBaseUrl: 'https://labragf.openagp.top:9080',
  datasetIds,
  timeoutMs: 30_000,
  maxChunks: 8,
  maxGraphEntities: 80,
})
const client = new RagflowClient(config)
const out: Record<string, unknown> = { tenant }

/** 各租户的种子问句（与对应评测文档的用例集同源）。 */
const TENANT_QUERIES: Record<string, string[]> = {
  tqp: [
    '桃曲坡水库主汛期的汛限水位是多少',
    '水库的防洪标准是多少年一遇',
    '应急响应分为几级',
    '2021年9月洪水的降雨量情况',
  ],
  zuhe: [
    '溃坝波的波形有哪几个公式',
    '土体颗粒在坝坡上的受力示意图',
    '2.5次抛物线表有哪些数据',
    '数字孪生建设对智能大坝的要求',
  ],
  jhq: ['泾惠渠的灌溉范围包括哪些', '泾惠渠的水源是什么'],
}

// 1. 检索：种子问句（含 meta_filter 场次限定，仅 tqp 洪水资料库有该元数据）
const queries = TENANT_QUERIES[tenant] ?? []
out.search = []
for (const q of queries) {
  const { chunks, labels } = await client.searchChunks(q, { topK: 5 })
  out.search.push({
    q,
    labels,
    chunks: chunks.slice(0, 3).map((c) => ({
      doc: c.documentName, page: c.pageNum, sim: c.similarity,
      imageId: c.imageId, positions: c.positions,
      head: c.content.slice(0, 80),
    })),
  })
}
if (tenant === 'tqp') {
  const { chunks: mChunks, labels: mLabels } = await client.searchChunks('2021年9月洪水降雨量', {
    topK: 5,
    metaFilter: [{ key: 'flood_event', op: '=', value: '2021-09' }],
  })
  out.searchMetaFilter = { labels: mLabels, chunks: mChunks.slice(0, 3).map((c) => ({ doc: c.documentName, page: c.pageNum, head: c.content.slice(0, 80) })) }
}

// 2. 图谱 node 模式（实体+谓词）
const sub = await client.subgraph({ node: '桃曲坡水库', topN: 30 })
out.graphNode = {
  center: sub.center,
  entities: sub.entities.map((e) => ({ name: e.name, type: e.type, aliases: e.aliases.slice(0, 3), desc: e.description.slice(0, 40), w: e.weight })),
  relations: sub.relations.map((r) => ({ from: r.from, to: r.to, predicate: r.predicate, w: r.weight })),
}

// 3. 图谱 keywords 模式
const sub2 = await client.subgraph({ keywords: '防洪调度', topN: 15 })
out.graphKeywords = { entities: sub2.entities.slice(0, 12).map((e) => ({ name: e.name, type: e.type, w: e.weight })), relations: sub2.relations.slice(0, 10).map((r) => `${r.from} -[${r.predicate}]-> ${r.to}`) }

// 4. wiki 清单 + 页面
out.wikiList = await client.listPages({ limit: 10 })
const page = await client.getPage('entity/桃曲坡水库')
out.wikiPage = page && {
  slug: page.slug, title: page.title, pageType: page.pageType, topic: page.topic,
  summary: page.summary.slice(0, 120), contentLen: page.contentMd.length,
  outlinks: page.outlinks.slice(0, 15), outlinkTotal: page.outlinks.length,
  related: page.relatedPages.slice(0, 10),
}

// 5. 脑图全量（层级路径 + 预算可见性）
const mm = await client.mindmap()
const rows: Array<{ lv: number; path: string; type: string }> = []
const walk = (n: typeof mm.forest[number], lv: number, parents: string[]) => {
  rows.push({ lv, path: [...parents, n.name].join(' > '), type: n.type })
  for (const c of n.children) walk(c, lv + 1, [...parents, n.name])
}
for (const root of mm.forest) walk(root, 0, [])
out.mindmap = { totalNodes: mm.totalNodes, expandedNodes: mm.expandedNodes, incomplete: mm.incomplete, rows: rows.slice(0, 60), rowCount: rows.length }

// 6. structure(graph) 类型分布
const st = await client.structure('graph')
const typeDist: Record<string, number> = {}
for (const e of st.entities) typeDist[e.type] = (typeDist[e.type] ?? 0) + 1
out.structureGraph = { entities: st.entities.length, relations: st.relations.length, typeDist, sample: st.entities.slice(0, 15).map((e) => `${e.name}(${e.type})`) }

console.log(JSON.stringify(out, null, 1))
