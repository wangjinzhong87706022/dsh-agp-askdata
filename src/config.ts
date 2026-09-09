/**
 * 插件配置模型与解析。
 *
 * 所有可调参数（护栏阈值、表名、白名单、客户端路径）都是显式配置项，
 * 默认值来自《工具实现规范》与架构设计的约定；运行时禁止在实现里内嵌第二套默认值。
 * @module
 */

/** StarRocks 连接（MySQL 协议）。密码只在进程内使用，不落盘、不进日志。 */
export interface StarRocksConnection {
  host: string
  port: number
  user: string
  /** 进程内注入 `MYSQL_PWD`（CLI 通道）或驱动连接参数（mysql2 通道），不进日志。 */
  password: string
  database: string
  /** 执行通道：`mysql2` 驱动直连（默认）或外部 `mysql` CLI（`cli`，回落项）。 */
  driver?: 'mysql2' | 'cli'
  /** mysql CLI 可执行文件路径，仅 `driver: 'cli'` 时使用，默认走 PATH。 */
  cliPath?: string
}

/** MySQL 连接（元数据库 + 业务库）。密码只在进程内使用，不落盘、不进日志。 */
export interface MysqlConnection {
  host: string
  port: number
  user: string
  /** 进程内传驱动连接参数，不进日志。 */
  password: string
  database: string
}

/** 时序表与测点字典表名。不同部署可能改名，故全部可配置。 */
export interface TableNames {
  tag: string
  data: string
  /** 聚合表名（光伏 WT_CUBE）。 */
  cube: string
  /** 设备维度表名（WT_DEVICE）。 */
  device: string
}

/** 查询通道与聚合路由配置（§14.10 三层路由）。 */
export interface QueryConfig {
  /** 层1：时序数据查询通道。 */
  tsdbChannel: 'sql' | 'rest'
  /** REST 通道配置（tsdbChannel='rest' 时生效）。 */
  rest: {
    baseUrl: string
    wtAppid: string
    wtToken: string
    wtOpenid: string
  }
  /** 层2：聚合表名（空串 = 强制只用 WT_DATA，通用行业）。 */
  aggregateTable: string
  /** 层2：cubeType 映射（光伏特定，空对象 = 不做 cubeType 路由）。 */
  cubeTypeMap: Record<number, string>
  /** 层3：粒度后缀 → granularity 值映射。 */
  granularityMap: Record<string, number>
}

/** 系统护栏与阈值。 */
export interface SystemLimits {
  /** 单次查询允许的最大扫描行数估算，默认 1 亿。 */
  maxScanRows: number
  /** 单次查询允许的最大时间跨度（天），默认 365。 */
  maxTimeRangeDays: number
  /** 质量位坏值掩码，AGP 默认 128（剔除 BAD）。 */
  badValueMask: number
  /** 单条 SQL 执行超时（毫秒）。 */
  queryTimeoutMs: number
  /** 单次返回行数上限。 */
  maxLimit: number
  /** 未显式传 limit 时时序/聚合类工具的默认返回行数。 */
  defaultLimit: number
  /** 未显式传 limit 时字典/设备反查类工具的默认返回行数。 */
  defaultLookupLimit: number
  /** 告警类工具的默认返回行数（低于 defaultLimit，控制进入模型上下文的行数）。 */
  defaultAlarmLimit: number
  /** 会话时区，必须为 ±HH:MM 格式，默认 +08:00。 */
  timeZone: string
}

/** 安全配置：基础库白名单与只读锁。 */
export interface SecurityConfig {
  /** 允许查询的 StarRocks 表全集；模板生成的 SQL 里出现的表必须都在其中。 */
  tableWhitelist: string[]
  /** 允许查询的 MySQL 表全集（跨库引用格式：wisetao_meta.meta_class_info）。 */
  mysqlTableWhitelist: string[]
  /** P0 恒为 true：整个插件只读，不生成、不执行任何写语句。 */
  readOnly: boolean
  /** 区间查询前先跑 estimate_count 扫描护栏（§estimate_count：所有大查询必过）。 */
  scanGuard: boolean
}

/** 审计配置。P0 支持写 WT_QUERY_AUDIT（含哈希链字段）。 */
export interface AuditConfig {
  enabled: boolean
  table: string
  /** 审计写入者身份标识。 */
  userId: string
  appId: string
  orgId: string
}

/** 插件完整配置。 */
export interface AskdataConfig {
  connection: StarRocksConnection
  mysqlConnection: MysqlConnection
  /** 光伏应用 ID（模型过滤，默认 10062）。 */
  appId: number
  tables: TableNames
  query: QueryConfig
  system: SystemLimits
  security: SecurityConfig
  audit: AuditConfig
}

/** 合法 SQL 标识符（表/列名），防御表名配置被注入。 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 会话时区只接受 ±HH:MM（StarRocks 字面量换算与 mysql CLI init-command 都依赖该形态）。 */
const TIME_ZONE_RE = /^[+-]\d{2}:\d{2}$/

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`配置错误：${label} 不是合法标识符: ${value}`)
  }
}

/** 光伏 cubeType 1-20 默认映射（§14.10.2；配置页与运行时共用，避免第二套拷贝）。 */
export const DEFAULT_CUBE_TYPE_MAP: Record<number, string> = {
  1: '华为组串电流汇总值', 2: '华为组串电压汇总值',
  3: '阳光组串电流汇总值', 4: '阳光组串电压汇总值',
  5: '华为逆变器电流汇总值', 6: '阳光逆变器电流汇总值',
  7: '华为逆变器电量值', 8: '阳光逆变器电量值',
  9: '华为组串电流离散率', 10: '华为组串电压离散率',
  11: '阳光组串电流离散率', 12: '阳光组串电压离散率',
  13: '华为逆变器电流离散率', 14: '阳光逆变器电流离散率',
  15: '华为逆变器电量离散率', 16: '阳光逆变器电量离散率',
  17: '储能放电量', 18: '储能充电量', 19: '储能上网量', 20: '储能下网量',
}

/** 粒度后缀 → WT_CUBE granularity 值默认映射（§14.10）。 */
export const DEFAULT_GRANULARITY_MAP: Record<string, number> = {
  '1H': 1, '1D': 2, '1M': 3, '1Y': 4,
}

/** 默认 MySQL 白名单（P1 元数据/告警面；跨库全限定格式）。 */
export const DEFAULT_MYSQL_TABLE_WHITELIST: string[] = [
  'wisetao_meta.meta_class_info',
  'wisetao_meta.meta_classtagmodel',
  'wisetao_meta.meta_class_link_info',
  'wisetao_meta.wt_elm_equipment',
  'wisetao_meta.wt_iot_tags',
  'wisetao_meta.wt_bas_alarmrecord',
  'bole.wt_cus_alarmdynamicconfig',
]

const DEFAULT_CONFIG: Omit<AskdataConfig, 'connection'> = {
  // MySQL 业务库默认留空：P0 纯 TSDB 部署无需配置；P1 元数据/告警工具在调用期
  // 以明确错误提示缺配置（不指向任何环境，避免内网拓扑烙进默认值）。
  mysqlConnection: {
    host: '',
    port: 3306,
    user: '',
    password: '',
    database: '',
  },
  appId: 10062,
  tables: { tag: 'WT_TAG', data: 'WT_DATA', cube: 'WT_CUBE', device: 'WT_DEVICE' },
  query: {
    tsdbChannel: 'sql',
    rest: { baseUrl: '', wtAppid: '', wtToken: '', wtOpenid: '' },
    aggregateTable: 'WT_CUBE',
    cubeTypeMap: DEFAULT_CUBE_TYPE_MAP,
    granularityMap: DEFAULT_GRANULARITY_MAP,
  },
  system: {
    maxScanRows: 100_000_000,
    maxTimeRangeDays: 365,
    badValueMask: 128,
    queryTimeoutMs: 15_000,
    maxLimit: 10_000,
    defaultLimit: 1000,
    defaultLookupLimit: 100,
    defaultAlarmLimit: 100,
    timeZone: '+08:00',
  },
  security: {
    tableWhitelist: ['WT_TAG', 'WT_DATA', 'WT_CUBE', 'WT_DEVICE'],
    mysqlTableWhitelist: DEFAULT_MYSQL_TABLE_WHITELIST,
    readOnly: true,
    scanGuard: true,
  },
  audit: {
    enabled: false,
    table: 'WT_QUERY_AUDIT',
    userId: 'askdata',
    appId: 'dsh-agp-askdata',
    orgId: '',
  },
}

/**
 * 解析并校验用户配置，补全默认值。
 *
 * 表名与白名单在此处做标识符校验，配置错误在加载期立即失败（misconfiguration fails loud）。
 */
export function resolveConfig(input: {
  connection: StarRocksConnection
  mysqlConnection?: Partial<MysqlConnection>
  appId?: number
  tables?: Partial<TableNames>
  query?: Partial<QueryConfig>
  system?: Partial<SystemLimits>
  security?: Partial<SecurityConfig>
  audit?: Partial<AuditConfig>
}): AskdataConfig {
  const tables = { ...DEFAULT_CONFIG.tables, ...input.tables }
  const system = { ...DEFAULT_CONFIG.system, ...input.system }
  const security = { ...DEFAULT_CONFIG.security, ...input.security }
  const audit = { ...DEFAULT_CONFIG.audit, ...input.audit }
  const appId = input.appId ?? DEFAULT_CONFIG.appId
  const mysqlConnection = { ...DEFAULT_CONFIG.mysqlConnection, ...input.mysqlConnection }
  const query = {
    ...DEFAULT_CONFIG.query,
    ...input.query,
    rest: { ...DEFAULT_CONFIG.query.rest, ...input.query?.rest },
    cubeTypeMap: input.query?.cubeTypeMap ?? DEFAULT_CONFIG.query.cubeTypeMap,
    granularityMap: input.query?.granularityMap ?? DEFAULT_CONFIG.query.granularityMap,
  }

  assertIdentifier(tables.tag, 'tables.tag')
  assertIdentifier(tables.data, 'tables.data')
  if (tables.cube) assertIdentifier(tables.cube, 'tables.cube')
  if (tables.device) assertIdentifier(tables.device, 'tables.device')
  assertIdentifier(audit.table, 'audit.table')
  for (const table of security.tableWhitelist) assertIdentifier(table, `security.tableWhitelist[]`)
  if (!security.readOnly) {
    throw new Error('配置错误：P0 阶段 security.readOnly 不允许关闭')
  }
  if (!input.connection?.host || !input.connection.database) {
    throw new Error('配置错误：connection.host / connection.database 必填')
  }
  if (!TIME_ZONE_RE.test(system.timeZone)) {
    throw new Error(`配置错误：system.timeZone 只允许 ±HH:MM 格式（如 +08:00），收到: ${system.timeZone}`)
  }
  if (mysqlConnection.host !== '' && !mysqlConnection.database) {
    throw new Error('配置错误：配置了 mysqlConnection.host 时 mysqlConnection.database 必填')
  }
  const driver = input.connection.driver ?? 'mysql2'
  if (driver !== 'mysql2' && driver !== 'cli') {
    throw new Error(`配置错误：connection.driver 只允许 'mysql2' / 'cli'，收到: ${driver}`)
  }
  if (query.tsdbChannel !== 'sql' && query.tsdbChannel !== 'rest') {
    throw new Error(`配置错误：query.tsdbChannel 只允许 'sql' / 'rest'，收到: ${query.tsdbChannel}`)
  }

  return {
    connection: { ...input.connection, driver },
    mysqlConnection,
    appId,
    tables,
    query,
    system,
    security,
    audit,
  }
}
