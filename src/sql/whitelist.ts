/**
 * 校验层：语句分类 + 基础库表白名单（《架构设计》§7 / 安全红线）。
 *
 * 安全红线："AI 不能直接拼裸 SQL"、"数据源必须限制在基础库内"。
 * P0 的全部 SQL 由模板生成，本模块作为派发前的最后一道机械闸门：
 * 任何语句都必须分类为只读、且引用的表全部落在白名单内才允许执行。
 * @module
 */

import { askdataError } from '../errors.ts'

/** 语句类别。 */
export type StatementKind = 'read' | 'dml' | 'ddl' | 'dcl' | 'unknown'

const DML_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'LOAD', 'CALL'] as const
const DDL_KEYWORDS = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'] as const
const DCL_KEYWORDS = ['GRANT', 'REVOKE', 'SET', 'USE'] as const
const READ_KEYWORDS = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'] as const

/** 去掉注释与字符串字面量后取首 token，判定语句类别。 */
export function classifyStatement(sql: string): StatementKind {
  const cleaned = stripCommentsAndLiterals(sql).trim()
  if (cleaned === '') return 'unknown'
  // 多语句在模板层不可能产生；此处再拦一次分号分隔的第二条语句。
  if (cleaned.includes(';')) return 'unknown'
  const first = (cleaned.match(/^[A-Za-z]+/) ?? [''])[0]!.toUpperCase()
  if ((DML_KEYWORDS as readonly string[]).includes(first)) return 'dml'
  if ((DDL_KEYWORDS as readonly string[]).includes(first)) return 'ddl'
  if ((DCL_KEYWORDS as readonly string[]).includes(first)) return 'dcl'
  if ((READ_KEYWORDS as readonly string[]).includes(first)) return 'read'
  return 'unknown'
}

/**
 * 去 SQL 字面量与注释，反引号标识符保留内容供表名提取。
 *
 * 顺序必须是先字符串后注释：`--`/`#` 若先按注释剥离，字符串字面量内部的
 * 注释样式片段（如 `'a--b'`）会把后续 SQL 误当注释吞掉，闸门看到的语句
 * 与数据库实际执行的语句不一致。先剥字符串则无此歧义。
 */
function stripCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** 从 SQL 里提取 FROM / JOIN 引用的表名（支持 db.table 跨库格式）。 */
export function extractTables(sql: string): string[] {
  const cleaned = stripCommentsAndLiterals(sql)
  const tables = new Set<string>()
  const pattern = /\b(?:FROM|JOIN)\s+`?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)`?/gi
  for (const match of cleaned.matchAll(pattern)) {
    tables.add(match[1]!.toUpperCase())
  }
  return [...tables]
}

/**
 * 派发前闸门：只读 + 白名单。
 *
 * 违反时抛 DML_FORBIDDEN / SENSITIVE_TABLE / WT_SQL_PARSE_ERROR。
 */
export function assertSafeToExecute(sql: string, tableWhitelist: string[]): void {
  const kind = classifyStatement(sql)
  if (kind === 'dml' || kind === 'ddl' || kind === 'dcl') {
    throw askdataError('DML_FORBIDDEN', `检测到 ${kind.toUpperCase()} 语句，系统强制只读`)
  }
  if (kind !== 'read') {
    throw askdataError('WT_SQL_PARSE_ERROR', '无法将语句识别为只读查询，拒绝执行')
  }
  const whitelist = new Set(tableWhitelist.map((t) => t.toUpperCase()))
  for (const table of extractTables(sql)) {
    if (!whitelist.has(table)) {
      throw askdataError('SENSITIVE_TABLE', `表 ${table} 不在基础库白名单内`)
    }
  }
}
