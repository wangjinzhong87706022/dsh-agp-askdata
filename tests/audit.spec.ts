import { describe, expect, it } from 'vitest'
import { hashChainNode, buildAuditRow, insertAuditSql } from '../src/audit.ts'

describe('hashChainNode', () => {
  it('确定性：同输入同哈希', () => {
    expect(hashChainNode('SELECT 1', '[]')).toBe(hashChainNode('SELECT 1', '[]'))
  })
  it('不同输入不同哈希', () => {
    expect(hashChainNode('SELECT 1', '[]')).not.toBe(hashChainNode('SELECT 2', '[]'))
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
    expect(second.resultHash).toBe(hashChainNode('SELECT 2', '[{}]'))
    expect(second.auditId).not.toBe(first.auditId)
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
