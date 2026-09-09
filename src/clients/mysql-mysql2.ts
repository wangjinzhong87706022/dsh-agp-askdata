/**
 * MySQL 执行适配器（P1 元数据/告警工具用）：mysql2 驱动直连。
 *
 * 与 StarRocks 适配器共用 mysql2 驱动与 QueryOutput 接口，但连接的是 MySQL
 * 业务库（元数据库 wisetao_meta + 业务库 bole）。`dateStrings: true` 让 datetime
 * 以字符串返回，与 StarRocks 通道及 AGP fields 契约保持一致。
 *
 * 连接级/执行级错误统一映射为规范错误码；密码不进任何错误消息与日志。
 * 每次查询独立建连（与 StarRocks 通道语义一致），连接池是后续优化项。
 * @module
 */

import { askdataError, AskdataError } from '../errors.ts'
import type { MysqlConnection, SystemLimits } from '../config.ts'
import type { QueryOutput } from './starrocks.ts'

/** mysql2 驱动错误 → 规范错误码。 */
export function mapMysqlDriverError(err: unknown): ReturnType<typeof askdataError> {
  const e = err as { code?: string; sqlState?: string | null; message?: string }
  const message = String(e?.message ?? err ?? '未知错误').slice(0, 300)
  const connectionLost = new Set([
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOENT',
    'PROTOCOL_CONNECTION_LOST',
    'ER_ACCESS_DENIED_ERROR',
    'ER_BAD_DB_ERROR',
  ])
  if (e?.code !== undefined && connectionLost.has(e.code)) {
    return askdataError('BACKEND_DOWN', `MySQL 连接失败: ${message}`)
  }
  if ((e?.sqlState ?? '').startsWith('42')) {
    return askdataError('WT_SQL_PARSE_ERROR', `SQL 执行失败: ${message}`)
  }
  return askdataError('BACKEND_DOWN', `MySQL 查询失败: ${message}`)
}

/** 驱动行 → 通道无关行（dateStrings 已保证 datetime 为字符串；其余标量 String 化）。 */
export function normalizeMysqlRow(row: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === null || value === undefined ? null : typeof value === 'string' ? value : String(value)
  }
  return out
}

/** mysql2 通道执行一条模板 SQL（MySQL 业务库）。 */
export async function executeQueryViaMysql(
  connection: MysqlConnection,
  sql: string,
  limits: SystemLimits,
  options?: { signal?: AbortSignal },
): Promise<QueryOutput> {
  if (options?.signal?.aborted) throw askdataError('BACKEND_DOWN', '查询已被取消')
  let mysql: typeof import('mysql2/promise')
  try {
    mysql = await import('mysql2/promise')
  } catch {
    throw askdataError('BACKEND_DOWN', '未安装 mysql2 驱动（pnpm add mysql2）')
  }
  const conn = await mysql
    .createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      dateStrings: true,
      connectTimeout: limits.queryTimeoutMs,
    })
    .catch((err: unknown) => {
      throw mapMysqlDriverError(err)
    })
  const onAbort = (): void => conn.destroy()
  options?.signal?.addEventListener('abort', onAbort, { once: true })

  const runOnce = (): Promise<QueryOutput> =>
    new Promise<QueryOutput>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        conn.destroy()
        reject(askdataError('BACKEND_DOWN', `MySQL 查询超时（${limits.queryTimeoutMs}ms）`))
      }, limits.queryTimeoutMs)
      conn
        .query({ sql, timeout: limits.queryTimeoutMs })
        .then(([rows, fields]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const columns = (fields as Array<{ name: string }>).map((f) => f.name)
          const dataRows = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
          resolve({ columns, rows: dataRows.map(normalizeMysqlRow) })
        })
        .catch((err: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (options?.signal?.aborted) {
            reject(askdataError('BACKEND_DOWN', '查询已被取消'))
            return
          }
          reject(mapMysqlDriverError(err))
        })
    })

  try {
    return await runOnce()
  } finally {
    options?.signal?.removeEventListener('abort', onAbort)
    try {
      await conn.end()
    } catch {
      /* 连接已因超时或取消 destroy，或对端先关闭 */
    }
  }
}