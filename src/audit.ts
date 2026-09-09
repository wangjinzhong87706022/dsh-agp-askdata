/**
 * 审计哈希链（《工具实现规范》§1.5）。
 *
 * 每次工具执行（成功或失败）产出一行 WT_QUERY_AUDIT：
 * `result_hash = SHA256(sql_text || result_json)`，`prev_hash` 取同一用户上一条
 * 的 result_hash——仅追加、可验证篡改。P0 提供建行与 INSERT 模板，写库为尽力而为
 * （审计失败不阻断查询，但必须记入日志）。
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'

/** 审计行（与 WT_QUERY_AUDIT 列一一对应）。 */
export interface AuditRow {
  auditId: string
  userId: string
  appId: string
  orgId: string
  question: string
  sqlText: string
  apiUrl: string
  apiParams: string
  rowCount: number
  executionMs: number
  errorCode: string
  errorMessage: string
  resultHash: string
  prevHash: string
  createdAt: string
  toolName: string
  toolLayer: string
}

/** 计算哈希链节点：SHA256(sql_text || result_json)。 */
export function hashChainNode(sqlText: string, resultJson: string): string {
  return createHash('sha256').update(`${sqlText}|${resultJson}`).digest('hex')
}

/** 构造一行审计记录。`prevHash` 由调用方传入（上一条的 resultHash；首条传空串）。 */
export function buildAuditRow(input: {
  userId: string
  appId: string
  orgId: string
  question: string
  sqlText: string
  apiUrl?: string
  apiParams?: Record<string, unknown>
  rowCount: number
  executionMs: number
  errorCode?: string
  errorMessage?: string
  resultJson: string
  prevHash: string
  toolName: string
  toolLayer: string
  now?: Date
}): AuditRow {
  return {
    auditId: randomUUID(),
    userId: input.userId,
    appId: input.appId,
    orgId: input.orgId,
    question: input.question,
    sqlText: input.sqlText,
    apiUrl: input.apiUrl ?? '',
    apiParams: JSON.stringify(input.apiParams ?? {}),
    rowCount: input.rowCount,
    executionMs: input.executionMs,
    errorCode: input.errorCode ?? '',
    errorMessage: input.errorMessage ?? '',
    resultHash: hashChainNode(input.sqlText, input.resultJson),
    prevHash: input.prevHash,
    createdAt: (input.now ?? new Date()).toISOString(),
    toolName: input.toolName,
    toolLayer: input.toolLayer,
  }
}

/** 审计 INSERT 模板（固定列名，值全部经转义）。 */
export function insertAuditSql(table: string, row: AuditRow): string {
  const columns = [
    'audit_id',
    'user_id',
    'app_id',
    'org_id',
    'question',
    'sql_text',
    'api_url',
    'api_params',
    'row_count',
    'execution_ms',
    'error_code',
    'error_message',
    'result_hash',
    'prev_hash',
    'created_at',
    'tool_name',
    'tool_layer',
  ]
  const values = [
    row.auditId,
    row.userId,
    row.appId,
    row.orgId,
    row.question,
    row.sqlText,
    row.apiUrl,
    row.apiParams,
    String(row.rowCount),
    String(row.executionMs),
    row.errorCode,
    row.errorMessage,
    row.resultHash,
    row.prevHash,
    row.createdAt,
    row.toolName,
    row.toolLayer,
  ].map((v) => `'${v.replaceAll("'", "''")}'`)
  const columnLines = columns.map((col, i) => `  ${col}${i < columns.length - 1 ? ',' : ''}`)
  const valueLines = values.map((v, i) => `  ${v}${i < values.length - 1 ? ',' : ''}`)
  return [
    `INSERT INTO ${table} (`,
    ...columnLines,
    ') VALUES (',
    ...valueLines,
    ');',
  ].join('\n')
}
