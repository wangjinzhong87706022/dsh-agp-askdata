/**
 * askdata 工具行（`dsh-agp-askdata/tools`）：把服务的 **API 工具面**（12 个工具，
 * AGP REST API /s1M6_uE9/wz/）注册进 DSH 工具注册表。
 *
 * **本版本智能问数只走 API**：SQL 工具面（StarRocks/MySQL 直连）保留在
 * 服务 API（`service.tools`）供编程使用，但**不在 DSH 注册**——取数统一
 * 收口到 API 网关，避免两套取数路径并存。
 *
 * 本行只消费宿主服务（`tools` 注册表 + 宿主行提供的 `askdata` 服务面），
 * 满足 preset 守卫（preset 行只消费），由 `preset/askdata/agent.cordis.yml`
 * 挂载——宿主组合不挂本行，headless profile 不产生工具副作用。
 *
 * 审计哈希链游标（prev_hash）由本行的闭包跨调用维护；`audit.enabled=false`
 * 时 onAudit 不会被触发，链自然停摆。P0/P1 链仅存在于进程内（行构建 + 游标），
 * 落库（WT_QUERY_AUDIT）为 P2，需旁路写账号。
 * @module dsh-agp-askdata/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskdataService } from '../index.ts'
import type { ApiToolContext } from '../../tools-api/index.ts'
import z from 'schemastery'
import { adaptAskdataApiTool, type AskdataToolDefinition } from './adapter.ts'

/** Cordis 插件名（诊断用）。 */
export const name = 'askdata-tools'

/** 依赖宿主的工具注册表与宿主行提供的服务面。 */
export const inject = ['tools', 'askdata']

/** 本行无自有配置（全部配置在宿主行）。 */
export const Config = z.object({})

/**
 * 注册全部 API 工具（12 个）。每个 AskdataApiTool 适配为 DSH 工具定义；
 * 取消信号与审计链游标在每次调用时注入工具上下文。
 *
 * `ctx.tools` 由 DSH 宿主的 tools 服务合并进 Context（@deepseek-ai/dsh-tools
 * RC 依赖链暂不可安装，故此处用结构化视图桥接，不做模块声明合并——避免与
 * 宿主侧真实类型冲突）。运行时形状以 harness packages/core/tools 为准。
 */
export function apply(ctx: Context): void {
  const host = ctx as Context & { tools: { register(definition: AskdataToolDefinition): void } }
  const service: AskdataService = host.askdata
  let prevAuditHash = ''

  for (const tool of service.apiTools) {
    const definition: AskdataToolDefinition = adaptAskdataApiTool(tool, (signal?: AbortSignal): ApiToolContext => {
      return service.createApiContext({
        prevAuditHash,
        signal,
        onAudit: (row) => {
          prevAuditHash = row.resultHash
        },
      })
    })
    host.tools.register(definition)
  }
}
