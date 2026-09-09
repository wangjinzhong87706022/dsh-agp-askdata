import { describe, expect, it } from 'vitest'
import { classifyStatement, assertSafeToExecute, extractTables } from '../src/sql/whitelist.ts'
import { AskdataError } from '../src/errors.ts'

describe('classifyStatement', () => {
  it('识别只读语句', () => {
    expect(classifyStatement('SELECT 1')).toBe('read')
    expect(classifyStatement('show tables')).toBe('read')
    expect(classifyStatement('DESCRIBE WT_TAG')).toBe('read')
    expect(classifyStatement('EXPLAIN SELECT 1')).toBe('read')
  })

  it('识别 DML/DDL/DCL', () => {
    expect(classifyStatement('DELETE FROM WT_DATA')).toBe('dml')
    expect(classifyStatement("insert into t values (1)")).toBe('dml')
    expect(classifyStatement('DROP TABLE WT_DATA')).toBe('ddl')
    expect(classifyStatement('GRANT ALL ON *.* TO u')).toBe('dcl')
  })

  it('字符串与注释里的关键字不参与判定', () => {
    expect(classifyStatement("SELECT 'delete from x'")).toBe('read')
    expect(classifyStatement('SELECT 1 -- drop table')).toBe('read')
    expect(classifyStatement('/* insert */ SELECT 1')).toBe('read')
  })

  it('字符串字面量先于注释剥离：串内 --/# 不破坏语句识别', () => {
    const sql = "SELECT tagName FROM WT_TAG WHERE `comment` LIKE '%a--b#c%'"
    expect(classifyStatement(sql)).toBe('read')
    expect(extractTables(sql)).toEqual(['WT_TAG'])
  })

  it('多语句与空串拒绝', () => {
    expect(classifyStatement('SELECT 1; DROP TABLE t')).toBe('unknown')
    expect(classifyStatement('   ')).toBe('unknown')
  })
})

describe('extractTables', () => {
  it('提取 FROM/JOIN 表名并大写化', () => {
    expect(extractTables('SELECT * FROM wt_data a LEFT JOIN `wt_tag` b ON a.tagIndex = b.tagIndex')).toEqual([
      'WT_DATA',
      'WT_TAG',
    ])
  })

  it('支持跨库 db.table 格式', () => {
    expect(extractTables('SELECT * FROM bole.wt_cus_alarmdynamicconfig')).toEqual([
      'BOLE.WT_CUS_ALARMDYNAMICCONFIG',
    ])
    expect(extractTables('SELECT * FROM wisetao_meta.meta_class_info')).toEqual([
      'WISETAO_META.META_CLASS_INFO',
    ])
  })

  it('注释里的表名不算引用', () => {
    expect(extractTables('SELECT 1 -- FROM secret_table')).toEqual([])
  })
})

describe('assertSafeToExecute', () => {
  const whitelist = ['WT_TAG', 'WT_DATA']

  it('放行白名单内只读查询', () => {
    expect(() =>
      assertSafeToExecute('SELECT a.value FROM WT_DATA a LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex', whitelist),
    ).not.toThrow()
  })

  it('DML 抛 DML_FORBIDDEN', () => {
    try {
      assertSafeToExecute('UPDATE WT_DATA SET value = 0', whitelist)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AskdataError)
      expect((err as AskdataError).code).toBe('DML_FORBIDDEN')
    }
  })

  it('白名单外表抛 SENSITIVE_TABLE', () => {
    try {
      assertSafeToExecute('SELECT * FROM mysql.user', whitelist)
      expect.unreachable()
    } catch (err) {
      expect((err as AskdataError).code).toBe('SENSITIVE_TABLE')
    }
  })

  it('不可识别语句抛 WT_SQL_PARSE_ERROR', () => {
    try {
      assertSafeToExecute('SELECT 1; SELECT 2', whitelist)
      expect.unreachable()
    } catch (err) {
      expect((err as AskdataError).code).toBe('WT_SQL_PARSE_ERROR')
    }
  })
})
