/**
 * StarRocks 执行适配器（默认通道）：mysql2 驱动直连。
 *
 * StarRocks 兼容 MySQL 线协议，mysql2 可直连 FE 查询端口。刻意使用 text
 * protocol（`conn.query()` 而非 `conn.execute()`）：规避 StarRocks 服务端
 * prepared statement 的版本差异；`dateStrings: true` 让 datetime 以字符串
 * 返回，与 CLI 通道及 AGP fields 契约保持一致。
 *
 * 连接级/执行级错误统一映射为规范错误码；密码不进任何错误消息与日志。
 * P0 每次查询独立建连（与 CLI 通道语义一致），连接池是 P1 优化项。
 * @module
 */

import { askdataError, AskdataError } from '../errors.ts'
import type { StarRocksConnection, SystemLimits } from '../config.ts'
import type { QueryOutput } from './starrocks.ts'

/** mysql2 驱动错误 → 规范错误码。 */
export function mapDriverError(err: unknown): ReturnType<typeof askdataError> {
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
    return askdataError('BACKEND_DOWN', `StarRocks 连接失败: ${message}`)
  }
  if ((e?.sqlState ?? '').startsWith('42')) {
    return askdataError('WT_SQL_PARSE_ERROR', `SQL 执行失败: ${message}`)
  }
  return askdataError('BACKEND_DOWN', `StarRocks 查询失败: ${message}`)
}

/** 驱动行 → 通道无关行（dateStrings 已保证 datetime 为字符串；其余标量 String 化）。 */
export function normalizeDriverRow(row: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === null || value === undefined ? null : typeof value === 'string' ? value : String(value)
  }
  return out
}

/** FE planner 瞬态慢优化（e2e 实证：memo 阶段 >3s 报错），重试一次即可恢复。 */
const PLANNER_TRANSIENT = /planner use long time|memo phase/i

/** mysql2 通道执行一条模板 SQL。查询超时由本适配器强制执行（conn.destroy）——mysql2 自带 timeout 选项在部分场景不生效。signal 中止同样销毁连接。 */
export async function executeQueryViaMysql2(
  connection: StarRocksConnection,
  sql: string,
  limits: SystemLimits,
  options?: { signal?: AbortSignal },
): Promise<QueryOutput> {
  if (options?.signal?.aborted) throw askdataError('BACKEND_DOWN', '查询已被取消')
  let mysql: typeof import('mysql2/promise')
  try {
    mysql = await import('mysql2/promise')
  } catch {
    throw askdataError(
      'BACKEND_DOWN',
      '未安装 mysql2 驱动（pnpm add mysql2），或将 connection.driver 设为 "cli" 使用外部客户端',
    )
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
      throw mapDriverError(err)
    })
  const onAbort = (): void => conn.destroy()
  options?.signal?.addEventListener('abort', onAbort, { once: true })

  const runOnce = (): Promise<QueryOutput> =>
    new Promise<QueryOutput>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        conn.destroy()
        reject(askdataError('BACKEND_DOWN', `StarRocks 查询超时（${limits.queryTimeoutMs}ms），请缩小时间范围或加大聚合粒度`))
      }, limits.queryTimeoutMs)
      conn
        .query({ sql, timeout: limits.queryTimeoutMs })
        .then(([rows, fields]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const columns = (fields as Array<{ name: string }>).map((f) => f.name)
          const dataRows = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
          resolve({ columns, rows: dataRows.map(normalizeDriverRow) })
        })
        .catch((err: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (options?.signal?.aborted) {
            reject(askdataError('BACKEND_DOWN', '查询已被取消'))
            return
          }
          reject(mapDriverError(err))
        })
    })

  try {
    try {
      return await runOnce()
    } catch (err) {
      if (err instanceof AskdataError && PLANNER_TRANSIENT.test(err.message)) {
        return await runOnce()
      }
      throw err
    }
  } finally {
    options?.signal?.removeEventListener('abort', onAbort)
    // 超时/取消路径已 destroy 连接，end() 会再抛一次；吞掉它避免掩盖原始错误。
    try {
      await conn.end()
    } catch {
      /* 连接已因超时或取消 destroy，或对端先关闭 */
    }
  }
}
