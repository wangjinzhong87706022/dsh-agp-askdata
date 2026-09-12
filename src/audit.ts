/**
 * 审计哈希链（《工具实现规范》§1.5）。
 *
 * 每次工具执行（成功或失败）产出一行 WT_QUERY_AUDIT：
 * `result_hash = SHA256(prev_hash || sql_text || result_json)`，`prev_hash` 取同一
 * 用户上一条的 result_hash——仅追加、可验证篡改。
 *
 * ⚠ 与上游规格的偏差（需回灌 docs/spec）：规格原文的公式是
 * `SHA256(sql || result_json)`，不含 prev_hash。若 prev_hash 不参与哈希，
 * 删除某行后只需改写后继行的 prev_hash 即可保持自洽（result_hash 与 prev_hash
 * 解耦，篡改者无需重算），"链式防删"不成立。本实现把 prev_hash 纳入哈希，
 * 并配 `verifyAuditChain` 校验链接；落库（P2）尚未实现，当前无历史数据兼容负担。
 *
 * P0 提供建行与 INSERT 模板，写库为尽力而为（审计失败不阻断查询，但必须记入日志）。
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

/** 计算哈希链节点：SHA256(prev_hash || sql_text || result_json)。prev_hash 纳入哈希，链不可无痕改写。 */
export function hashChainNode(prevHash: string, sqlText: string, resultJson: string): string {
  return createHash('sha256').update(`${prevHash}|${sqlText}|${resultJson}`).digest('hex')
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
    resultHash: hashChainNode(input.prevHash, input.sqlText, input.resultJson),
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

/** 链校验结果：`brokenAt` 为第一处断裂的行下标（0 基），链完整时为 -1。 */
export interface ChainVerification {
  valid: boolean
  brokenAt: number
  reason: string
}

const HEX64_RE = /^[0-9a-f]{64}$/

/**
 * 校验审计链完整性（管理端用）。逐行核对：
 *
 * 1. `result_hash` 为 64 位小写十六进制；
 * 2. `prev_hash` 与上一行的 `result_hash` 衔接（删除任一行即断链）。
 *
 * 可选传入 `resultJsonOf`：当原始 result_json 可取到（如旁路日志/落库通道）时，
 * 额外用 `hashChainNode` 重算 `result_hash` 以检出内容改写；取不到时只能做链接
 * 与格式校验。**完整防篡改要求 result_json 可获取**（落库为 P2，见
 * docs/architecture.md §4）。
 */
export function verifyAuditChain(
  rows: AuditRow[],
  resultJsonOf?: (row: AuditRow, index: number) => string | undefined,
): ChainVerification {
  let prev = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (!HEX64_RE.test(row.resultHash)) {
      return { valid: false, brokenAt: i, reason: `第 ${i + 1} 行 result_hash 不是 64 位十六进制` }
    }
    if (row.prevHash !== prev) {
      return { valid: false, brokenAt: i, reason: `第 ${i + 1} 行 prev_hash 与上行 result_hash 不衔接` }
    }
    const resultJson = resultJsonOf?.(row, i)
    if (resultJson !== undefined) {
      const recomputed = hashChainNode(row.prevHash, row.sqlText, resultJson)
      if (recomputed !== row.resultHash) {
        return { valid: false, brokenAt: i, reason: `第 ${i + 1} 行 result_hash 与内容不符（疑似改写）` }
      }
    }
    prev = row.resultHash
  }
  return { valid: true, brokenAt: -1, reason: '' }
}
