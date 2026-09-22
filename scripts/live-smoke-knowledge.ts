/**
 * 知识面直连冒烟（运维用，不随 vitest 跑）：真实 RAGFlow API key 打六个只读端点。
 * 用法：RAGFLOW_API_KEY=... pnpm tsx scripts/live-smoke-knowledge.ts
 */
import { RagflowClient } from '../src/clients/ragflow.ts'
import { resolveKnowledgeConfig } from '../src/config.ts'

const config = resolveKnowledgeConfig({
  ragflowBaseUrl: 'https://labragf.openagp.top:9080',
  datasetIds: ['fda7a510a87c11f1998b3dc126099a8d', 'fdfee2e4a87c11f1998b3dc126099a8d'],
  timeoutMs: 30_000,
  maxChunks: 5,
  maxGraphEntities: 20,
})
const client = new RagflowClient(config)

const chunks = await client.searchChunks('桃曲坡水库主汛期的汛限水位是多少')
console.log('1. searchChunks →', chunks.length, '段')
for (const [i, c] of chunks.slice(0, 3).entries()) {
  console.log(`   [${i + 1}] ${c.documentName} sim=${c.similarity} :: ${c.content.slice(0, 60)}`)
}

const sub = await client.subgraph({ node: '桃曲坡水库', topN: 15 })
console.log('2. subgraph(node) →', sub.entities.length, '实体 /', sub.relations.length, '关系 | center =', sub.center)
console.log('   实体:', sub.entities.slice(0, 5).map((e) => e.name).join(', '))
console.log('   关系:', sub.relations.slice(0, 5).map((r) => `${r.from} → ${r.to}`).join(' | '))

const sub2 = await client.subgraph({ keywords: '防洪调度', topN: 10 })
console.log('3. subgraph(keywords) →', sub2.entities.length, '实体 /', sub2.relations.length, '关系')
console.log('   top:', sub2.entities.slice(0, 8).map((e) => e.name).join(', '))

const pages = await client.listPages({ keywords: '桃曲坡水库', limit: 5 })
console.log('4. listPages →', pages.length, '页')
for (const p of pages) console.log(`   - ${p.slug} [${p.pageType}] topic=${p.topic}`)

const page = await client.getPage('entity/桃曲坡水库')
console.log('5. getPage →', page ? `${page.title} | ${page.topic} | 正文 ${page.contentMd.length} 字 | 出链 ${page.outlinks.length}` : 'null')

const st = await client.structure('graph')
console.log('6. structure(graph) →', st.entities.length, '实体 /', st.relations.length, '关系')
console.log('   sample:', st.entities.slice(0, 5).map((e) => `${e.name}(${e.type})`).join(', '))
