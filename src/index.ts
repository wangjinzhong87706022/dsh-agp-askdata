/**
 * dsh-agp-askdata 服务入口。
 *
 * P0 交付框架无关的服务工厂：给定配置即得到"执行器 + 工具面"。
 * 两个执行器都在此过 `assertSafeToExecute` 机械闸门（只读 + 白名单）——
 * 闸门在服务咽喉点统一收口，工具层调用点即使遗漏也无法绕过。
 * DSH cordis 插件装配（config schema、patch 行、preset 挂载、工具注册）
 * 参见 docs/architecture.md §8，装配模式照搬 dsh-data-agent 的
 * `cordis.patch.yml` + preset 结构，不改变本服务 API。
 * @module
 */

import { resolveConfig, type AskdataConfig, type StarRocksConnection, type MysqlConnection, type QueryConfig } from './config.ts'
import { executeQuery } from './clients/starrocks.ts'
import { executeQueryViaMysql2 } from './clients/starrocks-mysql2.ts'
import { executeQueryViaMysql } from './clients/mysql-mysql2.ts'
import { randomUUID } from 'node:crypto'
import { allTools } from '../tools/index.ts'
import type { AskdataTool, SqlExecutor, ToolContext } from '../tools/index.ts'
import type { AuditRow } from './audit.ts'
import { assertSafeToExecute } from './sql/whitelist.ts'
import { askdataError } from './errors.ts'

/** 装配完成的问数服务。 */
export interface AskdataService {
  config: AskdataConfig
  /** 全部工具面（P0 五工具 + P1 六工具，共 11 个）。 */
  tools: AskdataTool[]
  /** 构造一次工具调用的上下文；宿主持有 prevAuditHash 以延续审计链。 */
  createContext(options?: {
    prevAuditHash?: string
    signal?: AbortSignal
    onAudit?(row: AuditRow): void
  }): ToolContext
}

/** 执行器包装：派发前强制过白名单闸门（服务级咽喉点，防御调用点遗漏）。 */
function gate(executor: SqlExecutor, tableWhitelist: string[]): SqlExecutor {
  return {
    async execute(sql: string, options?: { signal?: AbortSignal }) {
      assertSafeToExecute(sql, tableWhitelist)
      return executor.execute(sql, options)
    },
  }
}

/**
 * 创建问数服务。配置错误（非法标识符、缺连接信息）在创建期立即抛出。
 *
 * `mysqlConnection` 可留空：P0 纯 TSDB 部署不受影响，P1 元数据/告警工具在
 * 调用期收到明确的 BACKEND_DOWN 提示。
 */
export function createAskdataService(input: {
  connection: StarRocksConnection
  mysqlConnection?: Partial<MysqlConnection>
  appId?: number
  tables?: Partial<AskdataConfig['tables']>
  query?: Partial<QueryConfig>
  system?: Partial<AskdataConfig['system']>
  security?: Partial<AskdataConfig['security']>
  audit?: Partial<AskdataConfig['audit']>
}): AskdataService {
  const config = resolveConfig(input)
  const mysqlConfigured = config.mysqlConnection.host !== ''
  const mysqlExecutor: SqlExecutor = gate(
    {
      execute(sql: string, options?: { signal?: AbortSignal }) {
        if (!mysqlConfigured) {
          throw askdataError(
            'BACKEND_DOWN',
            'MySQL 业务库未配置：请在配置中填写 mysqlConnection（P1 元数据/告警工具需要），或仅使用 TSDB 工具',
          )
        }
        return executeQueryViaMysql(config.mysqlConnection, sql, config.system, options)
      },
    },
    config.security.mysqlTableWhitelist,
  )
  const executor: SqlExecutor = gate(
    {
      execute(sql: string, options?: { signal?: AbortSignal }) {
        return config.connection.driver === 'cli'
          ? executeQuery(config.connection, sql, config.system, options)
          : executeQueryViaMysql2(config.connection, sql, config.system, options)
      },
    },
    config.security.tableWhitelist,
  )
  return {
    config,
    tools: allTools,
    createContext(options) {
      return {
        config,
        executor,
        mysqlExecutor,
        signal: options?.signal,
        prevAuditHash: options?.prevAuditHash,
        onAudit: options?.onAudit,
        log: (message) => console.log(`[askdata] ${message}`),
      }
    },
  }
}

/** 生成审计链的首个锚（宿主持久化上一条 result_hash 之前使用）。 */
export function newAuditAnchor(): string {
  return randomUUID()
}
