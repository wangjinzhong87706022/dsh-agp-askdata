/**
 * StarRocks 执行层：外部 mysql CLI（StarRocks 兼容 MySQL 协议）。
 *
 * 凭据约定（对齐 dsh-data-agent）：密码经 `MYSQL_PWD` 环境变量注入，
 * 绝不出现在 argv、日志或返回值里。TSV 解析按 mysql `--batch` 语义
 * （制表符分隔、`\t`/`\n` 转义、NULL 字面量）。
 * @module
 */

import { spawn } from 'node:child_process'
import { askdataError } from '../errors.ts'
import type { StarRocksConnection, SystemLimits } from '../config.ts'

/** 一次查询的结果：列名 + 行（值为字符串，NULL 已还原为 null）。 */
export interface QueryOutput {
  columns: string[]
  rows: Record<string, string | null>[]
}

/**
 * 构造 mysql CLI 参数。密码绝不入参；SQL 走 stdin（不进 argv——
 * 进程列表不可见、不受命令行长度限制，对齐 dsh-data-agent 的通道约定）。
 */
export function buildMysqlArgs(connection: StarRocksConnection, limits: SystemLimits): string[] {
  return [
    connection.cliPath ?? 'mysql',
    '-h',
    connection.host,
    '-P',
    String(connection.port),
    '-u',
    connection.user,
    '-D',
    connection.database,
    '--batch',
    '--default-character-set=utf8mb4',
    `--connect-timeout=${Math.max(1, Math.min(15, Math.ceil(limits.queryTimeoutMs / 1000)))}`,
    `--init-command=SET time_zone='${limits.timeZone}'`,
  ]
}

/** mysql --batch 转义还原：`\t` `\n` `\r` `\0` `\\`；'NULL' 字面量 → null。 */
export function unescapeField(raw: string): string | null {
  if (raw === 'NULL') return null
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i]!
      switch (next) {
        case 't':
          out += '\t'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case '0':
          out += '\0'
          break
        case '\\':
          out += '\\'
          break
        default:
          out += `\\${next}`
      }
    } else {
      out += ch
    }
  }
  return out
}

/** 解析 mysql --batch 输出（首行列名，其余为数据行）。 */
export function parseTsvOutput(stdout: string): QueryOutput {
  const lines = stdout.split('\n').filter((line, index, all) => line !== '' || index === all.length - 1)
  const nonEmpty = lines.filter((line) => line !== '')
  if (nonEmpty.length === 0) return { columns: [], rows: [] }
  const columns = nonEmpty[0]!.split('\t').map((c) => unescapeField(c) ?? '')
  const rows = nonEmpty.slice(1).map((line) => {
    const cells = line.split('\t')
    const row: Record<string, string | null> = {}
    columns.forEach((col, i) => {
      row[col] = cells[i] !== undefined ? unescapeField(cells[i]!) : null
    })
    return row
  })
  return { columns, rows }
}

/** 执行一条 SQL（模板生成、已过校验层）。SQL 经 stdin 送达；超时或客户端缺失抛 BACKEND_DOWN；signal 中止立即终止。 */
export function executeQuery(
  connection: StarRocksConnection,
  sql: string,
  limits: SystemLimits,
  options?: { signal?: AbortSignal },
): Promise<QueryOutput> {
  const args = buildMysqlArgs(connection, limits)
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(askdataError('BACKEND_DOWN', '查询已被取消'))
      return
    }
    const child = spawn(args[0]!, args.slice(1), {
      env: { ...process.env, MYSQL_PWD: connection.password },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // 客户端提前退出（如 SQL 被拒）时 stdin 写入会触发 EPIPE，吞掉避免掩盖原始错误
    child.stdin.on('error', () => {})
    child.stdin.end(sql)
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(askdataError('BACKEND_DOWN', `StarRocks 查询超时（${limits.queryTimeoutMs}ms）`))
    }, limits.queryTimeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      reject(
        err.code === 'ENOENT'
          ? askdataError('BACKEND_DOWN', `找不到 mysql 客户端（${args[0]}），请安装或配置 connection.cliPath`)
          : askdataError('BACKEND_DOWN', `mysql 客户端启动失败: ${err.message}`),
      )
    })
    child.on('close', (code) => {
      cleanup()
      if (options?.signal?.aborted) {
        reject(askdataError('BACKEND_DOWN', '查询已被取消'))
        return
      }
      if (code !== 0) {
        reject(
          askdataError(
            'BACKEND_DOWN',
            `StarRocks 查询失败（exit ${code}）：${stderr.trim().slice(0, 500) || '无 stderr'}`,
          ),
        )
        return
      }
      resolve(parseTsvOutput(stdout))
    })
  })
}
