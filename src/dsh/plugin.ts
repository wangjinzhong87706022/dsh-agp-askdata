/**
 * askdata 宿主行（包主入口）：解析插件配置、装配 AskdataService、
 * 提供 `askdata` 服务面，并把 `preset/askdata/` 安装为 DSH agent preset。
 *
 * **配置页**（对齐 examples/knowledge 模式）：schemastery Config 即 DSH 设置页的
 * 渲染来源——分组用嵌套 object + `.collapse()`，说明用 `.description()`，密文用
 * `.role('secret')`，JSON 映射用 `.role('textarea')`（加载期 parse + 校验，
 * 见 `toRuntimeConfig`）；端口/超时/时区带 `.pattern()/.min()/.max()`。
 * ragflow 式自建 loopback 页是 P2 备选（仅当目标部署的 Settings 不渲染
 * 第三方插件时启用，见 docs/architecture.md §14.10.7）。
 *
 * 工具注册在独立的 `dsh-agp-askdata/tools` 行（src/dsh/tools.ts）——该行由
 * `preset/askdata/agent.cordis.yml` 挂载（对齐 dsh-tool-str-replace-editor 的
 * preset 行模式），宿主行保持无工具副作用，可安全用于 headless profile。
 * @module dsh-agp-askdata
 */

import { access, cp, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import {
  createAskdataService,
  type AskdataService,
} from '../index.ts'
import {
  DEFAULT_CUBE_TYPE_MAP,
  DEFAULT_GRANULARITY_MAP,
  DEFAULT_MYSQL_TABLE_WHITELIST,
} from '../config.ts'

/** Cordis 插件名（诊断用）。 */
export const name = 'askdata'

/** 宿主行无额外服务依赖（服务自包含；工具行走 `inject = ['tools', 'askdata']`）。 */
export const inject: string[] = []

/**
 * 插件配置 schema（DSH 设置页渲染来源 + cordis.yml 部署默认值载体）。
 *
 * 密码为进程内配置项（`.role('secret')` 页面遮蔽回显）；credential-reference
 * 集成在 P2 接 `@deepseek-ai/dsh-credentials`（ragflow 模式）。
 * `security.readOnly` 不出现在页面：P0 红线恒为 true，只允许在 yml 层显式配置
 * （且 resolveConfig 会拒绝 false）。
 */
export const Config = z.object({
  connection: z.object({
    host: z.string().required().description('StarRocks FE 地址（MySQL 协议查询端口所在节点）'),
    port: z.number().default(9030).min(1).max(65535).description('StarRocks FE 查询端口'),
    user: z.string().default('askdata_ro').description('数据库账号（生产必须只读账号）'),
    password: z.string().role('secret').default('').description('数据库密码（进程内使用，不落盘不进日志）'),
    database: z.string().required().description('默认数据库（如 WT_DB）'),
    driver: z.union([z.const('mysql2'), z.const('cli')]).default('mysql2')
      .description('执行通道：mysql2 驱动直连（默认）/ cli 外部 mysql 客户端（回落）'),
    cliPath: z.string().default('mysql').description('cli 通道的 mysql 可执行文件路径'),
  }).collapse().description('StarRocks TSDB 连接（P0 必配）'),

  mysqlConnection: z.object({
    host: z.string().default('').description('MySQL 业务库地址；留空则 P0 面可用、P1 元数据/告警工具不可用'),
    port: z.number().default(3306).min(1).max(65535).description('MySQL 端口'),
    user: z.string().default('').description('MySQL 账号（生产必须只读账号）'),
    password: z.string().role('secret').default('').description('MySQL 密码（进程内使用，不落盘不进日志）'),
    database: z.string().default('wisetao_meta').description('元数据库（告警配置 bole 库走跨库引用）'),
  }).collapse().description('MySQL 业务库连接（P1 元数据/告警工具需要）'),

  appId: z.number().default(10062).description('光伏应用 ID（lookup_model / lookup_object / 告警查询的过滤范围）'),

  tables: z.object({
    tag: z.string().default('WT_TAG').description('测点字典表'),
    data: z.string().default('WT_DATA').description('时序主表'),
    cube: z.string().default('WT_CUBE').description('预聚合表（光伏特定；aggregate 自动路由的目标）'),
    device: z.string().default('WT_DEVICE').description('设备维度表'),
  }).collapse().description('表名映射（不同部署可能改名）'),

  query: z.object({
    tsdbChannel: z.union([z.const('sql'), z.const('rest')]).default('sql')
      .description('层1 时序取数通道优先级：sql = StarRocks 直连（默认，已验证）；rest = TSDB HTTP 网关实时值接口（需下方 baseUrl + 鉴权三头；latest_value 走网关，失败按"REST 失败回落 SQL"处理）'),
    rest: z.object({
      baseUrl: z.string().default('').description('TSDB HTTP 网关基址（tsdbChannel=rest 时必填，如 http://host/iot-etl/iot）'),
      wtAppid: z.string().default('').description('鉴权头 WT-APPID'),
      wtToken: z.string().role('secret').default('').description('鉴权头 WT-TOKEN（密文）'),
      wtOpenid: z.string().default('').description('鉴权头 WT-OPENID'),
      fallbackToSql: z.boolean().default(true).description('REST 调用失败（网关不可达/响应不合法）时自动回落 SQL 通道；关闭则失败直接返回'),
    }).collapse().description('REST 通道（TSDB HTTP 网关）'),
    useAggregateTable: z.boolean().default(true)
      .description('是否使用 WT_CUBE 预聚合路由：开启后 aggregate 对 1H/1D/1M/1Y 粒度 tag 自动查聚合表（快）；关闭 = 强制只用 WT_DATA 全聚合（非光伏行业/口径存疑时）'),
    aggregateTable: z.string().default('WT_CUBE')
      .description('层2 聚合表名（useAggregateTable 开启时生效；置空串等效关闭路由）'),
    cubeTypeMapJson: z.string().role('textarea').default(JSON.stringify(DEFAULT_CUBE_TYPE_MAP, null, 2))
      .description('cubeType → 中文口径映射（JSON 对象；aggregate 路由与解释用。留空 {} = 不做 cubeType 路由）'),
    granularityMapJson: z.string().role('textarea').default(JSON.stringify(DEFAULT_GRANULARITY_MAP, null, 2))
      .description('粒度后缀 → WT_CUBE granularity 值映射（JSON 对象，如 {"1H":1,"1D":2}）'),
  }).collapse().description('查询路由（§14.10 三层：通道 → 聚合表 → 粒度；LLM 不感知路由细节）'),

  system: z.object({
    maxScanRows: z.number().default(100_000_000).min(1).description('扫描护栏阈值（行）；区间估算超过即拒绝并提示 LLM 缩窗'),
    maxTimeRangeDays: z.number().default(365).min(1).description('单次查询最大时间跨度（天）'),
    badValueMask: z.number().default(128).min(0).max(65535).description('质量位坏值掩码（AGP 默认 128 = 剔除 BAD）'),
    queryTimeoutMs: z.number().default(15_000).min(1000).description('单条 SQL 超时（毫秒；超时由适配器强制执行 conn.destroy）'),
    maxLimit: z.number().default(10_000).min(1).description('单次返回行数硬上限'),
    defaultLimit: z.number().default(1000).min(1).description('时序/聚合工具默认返回行数'),
    defaultLookupLimit: z.number().default(100).min(1).description('字典/设备反查工具默认返回行数'),
    defaultAlarmLimit: z.number().default(100).min(1).description('告警工具默认返回行数（控制进入模型上下文的量）'),
    timeZone: z.string().default('+08:00').pattern(/^[+-]\d{2}:\d{2}$/)
      .description('会话时区，仅接受 ±HH:MM（如 +08:00）；时间字面量统一按此偏移换算'),
  }).collapse().description('护栏阈值（全部在执行前机械生效，与 LLM 无关）'),

  security: z.object({
    tableWhitelist: z.array(z.string()).default(['WT_TAG', 'WT_DATA', 'WT_CUBE', 'WT_DEVICE'])
      .description('StarRocks 基础库白名单：模板 SQL 引用的表必须全部命中，否则 SENSITIVE_TABLE'),
    mysqlTableWhitelist: z.array(z.string()).default(DEFAULT_MYSQL_TABLE_WHITELIST)
      .description('MySQL 白名单（跨库全限定格式 db.table）'),
    scanGuard: z.boolean().default(true).description('区间查询前强制扫描估算（aggregate 命中 WT_CUBE 路由时自动跳过）'),
  }).collapse().description('安全（只读红线恒开：security.readOnly 不开放配置，P0 恒为 true）'),

  audit: z.object({
    enabled: z.boolean().default(true).description('启用审计哈希链（默认开启：进程内行构建 + 游标；落库为 P2，需旁路写账号）'),
    table: z.string().default('WT_QUERY_AUDIT').description('审计表名'),
    userId: z.string().default('askdata').description('审计写入者身份：用户'),
    appId: z.string().default('dsh-agp-askdata').description('审计写入者身份：应用'),
    orgId: z.string().default('').description('审计写入者身份：组织'),
  }).collapse().description('审计'),

  knowledge: z.object({
    ragflowBaseUrl: z.string().default('https://labragf.openagp.top:9080')
      .description('RAGFlow 实例基址（不含 /api/v1；客户端自动拼接）'),
    ragflowApiKey: z.string().role('secret').default('')
      .description('RAGFlow API Key（Bearer；进程内使用不落盘。留空回退环境变量 RAGFLOW_API_KEY）'),
    datasetIds: z.array(z.string()).default([])
      .description('知识检索目标数据集 id 列表（RAGFlow dataset id；空 = 知识工具不可用，取数面不受影响）'),
    timeoutMs: z.number().default(20_000).min(1000).description('单次知识调用超时（毫秒）'),
    maxChunks: z.number().default(8).min(1).max(50).description('knowledge_search 默认返回片段数'),
    maxGraphEntities: z.number().default(60).min(1).max(1024).description('knowledge_graph 默认实体预算（服务端上限 1024）'),
  }).collapse().description('RAGFlow 知识面（graph/wiki/原文检索；问数的第二数据源：TSDB 给数值，知识库给依据）'),

  installPreset: z.boolean().default(true).description('启动时把 preset/askdata/ 安装到 $DSH_HOME/.agent-presets/（已存在则跳过，绝不覆盖）'),
  presetId: z.string().default('askdata').description('preset 目录名（Web/TUI 里的"AGP问数"入口）'),
})

/** 配置 schema 的已解析形态（loader 应用默认值后传入 apply）。 */
export type Config = ReturnType<typeof Config>

/**
 * JSON 映射字段解析：页面编辑产出 JSON 字符串，cordis.yml 部署默认值可以直接
 * 给对象——两种形态都接受；解析失败在加载期报出字段名（misconfiguration fails loud）。
 */
export function parseJsonMapField(
  field: string,
  value: unknown,
): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* 落入下方统一报错 */
    }
  }
  throw new Error(`配置错误：${field} 必须是 JSON 对象（如 {"1H":1}）或留空`)
}

/**
 * 页面/部署配置 → `createAskdataService` 入参（运行时模型）。
 *
 * 唯一的形态转换点：`cubeTypeMapJson` / `granularityMapJson`（JSON 字符串或对象）
 * → 运行时 Record。其余分段原样透传，最终仍由 `resolveConfig` 统一校验。
 */
export function toRuntimeConfig(config: Config): Parameters<typeof createAskdataService>[0] {
  return {
    connection: config.connection,
    mysqlConnection: config.mysqlConnection,
    appId: config.appId,
    tables: config.tables,
    query: {
      tsdbChannel: config.query.tsdbChannel,
      rest: config.query.rest,
      useAggregateTable: config.query.useAggregateTable,
      aggregateTable: config.query.aggregateTable,
      cubeTypeMap: parseJsonMapField('query.cubeTypeMapJson', config.query.cubeTypeMapJson) as Record<number, string>,
      granularityMap: parseJsonMapField('query.granularityMapJson', config.query.granularityMapJson) as Record<string, number>,
    },
    system: config.system,
    security: config.security,
    audit: config.audit,
    knowledge: config.knowledge,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    askdata: AskdataService
  }
}

/**
 * 解析配置 → 装配服务 → 提供服务面 → 安装 preset。
 *
 * 配置错误（连接缺失、非法标识符、JSON 映射不合法、readOnly=false）在加载期
 * 直接抛出（misconfiguration fails loud）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = createAskdataService(toRuntimeConfig(config))
  ctx.provide('askdata', service)
  ctx.effect(() => () => {
    /* P1 无持久资源：连接为每查询独立建连，销毁时无需清理 */
  }, 'askdata: dispose service')

  if (config.installPreset) {
    await installPreset(ctx, config.presetId)
  }
}

/** 按 `$DSH_HOME`（缺省 `~/.dsh`）解析 harness 主目录。 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(selected.startsWith('~/') ? join(homedir(), selected.slice(2)) : selected)
}

/**
 * 安装 `preset/askdata/` 到 `$DSH_HOME/.agent-presets/<presetId>/`。
 *
 * 幂等：目标已存在（以 agent.cordis.yml 为准）则跳过，绝不覆盖用户改动；
 * 尽力而为：失败仅告警并给出手动安装指引，不阻断启动。
 */
export async function installPreset(ctx: Context, presetId: string): Promise<boolean> {
  const targetDir = join(resolveDshHome(), '.agent-presets', presetId)
  const sourceDir = fileURLToPath(new URL('../../preset/askdata/', import.meta.url))
  try {
    const exists = await access(join(targetDir, 'agent.cordis.yml')).then(
      () => true,
      () => false,
    )
    if (exists) {
      ctx.logger.info('askdata: preset "%s" already present at %s, skipping install', presetId, targetDir)
      return false
    }
    await mkdir(targetDir, { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true })
    ctx.logger.info('askdata: installed preset "%s" to %s', presetId, targetDir)
    return true
  } catch (error) {
    ctx.logger.warn(
      'askdata: failed to install preset "%s" to %s (%s); copy preset/askdata/ manually to enable the AGP问数 preset',
      presetId,
      targetDir,
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
