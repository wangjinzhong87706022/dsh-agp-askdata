import { describe, expect, it } from 'vitest'
import { hashChainNode, buildAuditRow, insertAuditSql, verifyAuditChain } from '../src/audit.ts'

describe('hashChainNode', () => {
  it('确定性：同输入同哈希', () => {
    expect(hashChainNode('', 'SELECT 1', '[]')).toBe(hashChainNode('', 'SELECT 1', '[]'))
  })
  it('不同输入不同哈希', () => {
    expect(hashChainNode('', 'SELECT 1', '[]')).not.toBe(hashChainNode('', 'SELECT 2', '[]'))
  })
  it('prev_hash 参与哈希：换上行前缀即换哈希（链式不可解耦）', () => {
    expect(hashChainNode('prev-a', 'SELECT 1', '[]')).not.toBe(hashChainNode('prev-b', 'SELECT 1', '[]'))
  })
})

describe('buildAuditRow', () => {
  it('携带 prevHash 形成链', () => {
    const first = buildAuditRow({
      userId: 'u',
      appId: 'a',
      orgId: 'o',
      question: 'q',
      sqlText: 'SELECT 1',
      rowCount: 0,
      executionMs: 1,
      resultJson: '[]',
      prevHash: '',
      toolName: 'time_series',
      toolLayer: 'base_business',
    })
    const second = buildAuditRow({
      userId: 'u',
      appId: 'a',
      orgId: 'o',
      question: 'q2',
      sqlText: 'SELECT 2',
      rowCount: 1,
      executionMs: 2,
      resultJson: '[{}]',
      prevHash: first.resultHash,
      toolName: 'aggregate',
      toolLayer: 'base_business',
    })
    expect(second.prevHash).toBe(first.resultHash)
    expect(second.resultHash).toBe(hashChainNode(first.resultHash, 'SELECT 2', '[{}]'))
    expect(second.auditId).not.toBe(first.auditId)
  })
})

/** 按给定 result_json 序列构造一条自洽审计链。 */
function chainOf(results: string[]) {
  const rows = []
  let prev = ''
  for (const resultJson of results) {
    const row = buildAuditRow({
      userId: 'u',
      appId: 'a',
      orgId: '',
      question: 'q',
      sqlText: `SELECT ${resultJson.length}`,
      rowCount: 0,
      executionMs: 1,
      resultJson,
      prevHash: prev,
      toolName: 'tag_real',
      toolLayer: 'metadata',
    })
    rows.push(row)
    prev = row.resultHash
  }
  return rows
}

describe('verifyAuditChain', () => {
  it('链路完整：链接与格式均通过', () => {
    const rows = chainOf(['[]', '[{}]', '[{"v":1}]'])
    expect(verifyAuditChain(rows)).toEqual({ valid: true, brokenAt: -1, reason: '' })
  })

  it('提供 result_json 解析器时重算哈希，检出内容改写', () => {
    const rows = chainOf(['[]', '[{}]'])
    // 解析器返回与写入时不一致的 result_json（模拟内容被改）
    const forged = verifyAuditChain(rows, (_row, i) => (i === 0 ? '[1]' : '[{}]'))
    expect(forged.valid).toBe(false)
    expect(forged.brokenAt).toBe(0)
    expect(forged.reason).toContain('改写')
  })

  it('删除一行导致 prev_hash 断链', () => {
    const rows = chainOf(['[]', '[{}]', '[{"v":1}]'])
    const removed = [rows[0]!, rows[2]!]
    const verdict = verifyAuditChain(removed)
    expect(verdict.valid).toBe(false)
    expect(verdict.brokenAt).toBe(1)
    expect(verdict.reason).toContain('不衔接')
  })

  it('result_hash 非 64 位十六进制即判无效', () => {
    const rows = chainOf(['[]'])
    const broken = verifyAuditChain([{ ...rows[0]!, resultHash: 'ZZZ' }])
    expect(broken.valid).toBe(false)
    expect(broken.reason).toContain('十六进制')
  })
})

describe('insertAuditSql', () => {
  it('单引号翻倍，值完整落列', () => {
    const row = buildAuditRow({
      userId: "u'",
      appId: 'a',
      orgId: '',
      question: "问'题",
      sqlText: 'SELECT 1',
      rowCount: 0,
      executionMs: 1,
      resultJson: '[]',
      prevHash: '',
      toolName: 'lookup_tag',
      toolLayer: 'metadata',
    })
    const sql = insertAuditSql('WT_QUERY_AUDIT', row)
    expect(sql).toContain("'u'''")
    expect(sql).toContain('INSERT INTO WT_QUERY_AUDIT')
    expect(sql).toContain('tool_name')
    expect(sql).toContain('tool_layer')
  })
})
