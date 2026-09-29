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
  /** 层1：时序数据查询通道。rest = TSDB HTTP 网关（需 baseUrl + 鉴权三头）。 */
  tsdbChannel: 'sql' | 'rest'
  /** REST 通道配置（tsdbChannel='rest' 时生效）。 */
  rest: {
    baseUrl: string
    wtAppid: string
    wtToken: string
    wtOpenid: string
    /** REST 调用失败时自动回落 SQL 通道（默认开；关闭则失败直接返回）。 */
    fallbackToSql: boolean
    /** meta 数据查询单页最大行数（pageSize 上限；AGP 接口要求 <1000）。 */
    maxPageSize: number
  }
  /** meta 元数据面（AGP 数据底座 meta 接口工具族）的可调阈值。 */
  meta: MetaQueryLimits
  /** 是否启用预聚合表路由（false = 强制只用 WT_DATA 全聚合；通用行业/口径存疑时关闭）。 */
  useAggregateTable: boolean
  /** 层2：聚合表名（空串 = 强制只用 WT_DATA，通用行业）。 */
  aggregateTable: string
  /** 层2：cubeType 映射（光伏特定，空对象 = 不做 cubeType 路由）。 */
  cubeTypeMap: Record<number, string>
  /** 层3：粒度后缀 → granularity 值映射。 */
  granularityMap: Record<string, number>
}

/**
 * meta 元数据面工具族（tools/meta-*.ts、model-relation-graph）的可调阈值。
 *
 * 这些阈值过去内嵌在工具模块里（模块级常量），等于存在第二套默认值；现在
 * 全部收进配置，与 SQL 面阈值同源同改。
 */
export interface MetaQueryLimits {
  /**
   * `model_relation_graph` 关系清单的安全截断上限：超出即截断并置
   * `complete=false`（有界清单，正常远小于此）。
   */
  relationCap: number
  /** meta 查询族（query_model / *_segment 等）未显式传 page_size 时的默认单页行数。 */
  defaultPageSize: number
  /**
   * 字段构成清单（model_field_list / relation_field_list）的安全截断上限：
   * 超出即截断并置 `complete=false`。建模属性理论上远小于此。
   */
  fieldCap: number
  /**
   * 关系图谱向下展开的层数（含首层，1 = 只画本模型发出的关系）。
   * 每多一层都要对每个对端模型再发一次 getRelationsByModel，层数与节点数
   * 一起决定响应时延与 token 消耗，故走配置而非硬编码。
   */
  relationDepth: number
  /**
   * 展开到最深层时，最多对几个对端模型继续展开（按出边数取前 N）。
   * 第 2 层全展（对端通常个位数），第 3 层及以后只展度数最高的 N 个，
   * 否则一个枢纽模型就能把图撑成上百个节点。
   */
  relationFanout: number
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
  /**
   * 工具未自声明 `previewLimit` 时，模型可见结果预览的默认行数
   * （`src/dsh/adapter.ts` 用；SQL 行查询面历史值）。
   */
  defaultPreviewLimit: number
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

/**
 * 值班报告阈值档（对照 §五 8 段模板"阈值对照"）：level 为档名（汛限/警戒/保证/校核
 * 或自定义名），value + op 为判超条件（缺省 op='>='，即观测值达到阈值即超）。
 */
export interface DutyThreshold {
  level: string
  value: number
  op?: '>=' | '>' | '<=' | '<'
}

/** 值班报告测站指标台账项：一个 AGP 测点 + 展示口径 + 阈值档。 */
export interface DutyMetric {
  /** 指标键（water_level / rainfall / inflow / outflow …），同站内唯一。 */
  metric: string
  /** 中文指标名（表格与研判文案用）。 */
  label: string
  /** 计量单位（m / mm / m³/s …）。 */
  unit: string
  /** AGP 测点全名（tagName）；实时值经 AGP API 拉取，不走 SQL。 */
  tagName: string
  /** 展示小数位（缺省 2）。 */
  decimals?: number
  /** 阈值档（可空 = 只汇总不研判；研判建议只由阈值规则引擎产生）。 */
  thresholds?: DutyThreshold[]
}

/** 值班报告测站台账：一个测站 = 名称 + 一组指标。 */
export interface DutyStation {
  id: string
  name: string
  metrics: DutyMetric[]
}

/** 报讯/通知对象（报告第 7 段；配置化，不由 LLM 生成）。 */
export interface DutyReporting {
  /** 通知对象（如"市防汛抗旱指挥部"）。 */
  object: string
  /** 通道/方式（如"防汛专报"）。 */
  channel?: string
  /** 频次（如"超汛限期间每 2 小时一次"）。 */
  frequency?: string
}

/**
 * 值班报告面配置（防汛值班报告 Agent，docs/architecture.md §19）。
 *
 * 测站台账与阈值是部署事实（工程专属），全部走配置；台账为空时值班工具在
 * 调用期给出明确提示，不影响其余工具面。报告产物目录缺省落在 $DSH_HOME/outputs。
 */
export interface DutyConfig {
  /** 工程/河段名（报告头；如"桃曲坡水库"）。 */
  project: string
  /** 报告产物目录；空 = $DSH_HOME/outputs，再退 ./outputs。 */
  outputDir: string
  stations: DutyStation[]
  reporting: DutyReporting[]
}

/**
 * RAGFlow 知识面配置（graph / wiki / 原文检索，与 ragflow-import 工具链同源）。
 *
 * 知识面是问数的第二数据源：TSDB 给数值，RAGFlow 给依据（规程原文、实体关系、
 * 百科页面）。全部经 HTTP 只读检索端点访问，不触碰 SQL 取数面。
 *
 * 多租户：RAGFlow 的 API key 即租户边界（key 属于谁就只能检索谁的数据集），
 * 租户 = {id, key, datasetIds} 的注册表；遗留单租户形态（根配置 ragflowApiKey +
 * datasetIds）在 tenants 为空时折算为 id=default 的单租户，部署无需迁移。
 */
export interface KnowledgeTenantConfig {
  /** 租户标识（小写 kebab-case；会话身份解析与 defaultTenant 引用它）。 */
  id: string
  /** 该租户的 API Key（Bearer）。进程内使用，不落盘、不进日志；留空回退环境变量 RAGFLOW_API_KEY_<ID大写>。 */
  ragflowApiKey: string
  /** 该租户的检索目标数据集 id 列表。 */
  datasetIds: string[]
  /** 覆写根配置 knowledge.maxChunks（缺省继承）。 */
  maxChunks?: number
  /** 覆写根配置 knowledge.maxGraphEntities（缺省继承）。 */
  maxGraphEntities?: number
}

export interface KnowledgeConfig {
  /** RAGFlow 实例基址（不含 /api/v1；客户端自动拼接）。多租户共用同一实例。 */
  ragflowBaseUrl: string
  /** 遗留单租户 API Key；tenants 非空时忽略。留空回退环境变量 RAGFLOW_API_KEY。 */
  ragflowApiKey: string
  /** 遗留单租户数据集；tenants 非空时忽略。空 = 知识工具不可用。 */
  datasetIds: string[]
  /** 单次知识调用超时（毫秒）。 */
  timeoutMs: number
  /** knowledge_search 默认返回片段数（根配置；租户可覆写）。 */
  maxChunks: number
  /** knowledge_graph 默认实体预算（服务端 top_n 上限 1024；租户可覆写）。 */
  maxGraphEntities: number
  /**
   * 兜底租户 id：会话未携带租户标识时使用。单租户部署留空自动取唯一租户；
   * 多租户建议显式配置；多租户且留空 = 未解析即报错（fail loud，防跨租户误用）。
   */
  defaultTenant: string
  /** 租户注册表（多租户形态；空 = 走遗留单租户）。 */
  tenants: KnowledgeTenantConfig[]
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
  knowledge: KnowledgeConfig
  /** 值班报告面（防汛值班报告 Agent；空台账 = 面不可用，调用期明确提示）。 */
  duty: DutyConfig
  /**
   * 工具组开关（部署形态隔离，默认全开 = 现状 24 工具）：
   * - sql：P0 五 + P1 六 + askdata_deep_analysis（内网 StarRocks/MySQL 取数面，共 12）
   * - api：值班报告二 + meta 元数据面六（AGP REST 网关面，共 8）
   * - knowledge：RAGFlow 知识面四工具
   * 云端 API 部署（如 openagp.top）关 sql：模型工具集里没有任何 SQL 工具，
   * persona 也不会提及，避免"只有光伏域 SQL 工具却被问云端项目"时的工具名幻觉。
   */
  toolsets: { sql: boolean; api: boolean; knowledge: boolean }
}

/** 合法 SQL 标识符（表/列名），防御表名配置被注入。 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 会话时区只接受 ±HH:MM（StarRocks 字面量换算与 mysql CLI init-command 都依赖该形态）。 */
const TIME_ZONE_RE = /^[+-]\d{2}:\d{2}$/

/** RAGFlow 数据集 id 形态（线上为 24 位 hex；下界 3 防空值，禁特殊字符防 URL 路径注入）。 */
const DATASET_ID_RE = /^[0-9a-zA-Z-]{3,64}$/

/** 知识面租户 id 形态（小写 kebab-case；defaultTenant 与环境变量名引用它）。 */
const TENANT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/

/** RAGFlow 基址只允许 http(s)，且不含路径后缀（/api/v1 由客户端拼接）。 */
function normalizeRagflowBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/.test(trimmed)) {
    throw new Error(`配置错误：knowledge.ragflowBaseUrl 必须是 http(s) 地址，收到: ${value}`)
  }
  return trimmed
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`配置错误：${label} 不是合法标识符: ${value}`)
  }
}

/** 阈值必须是 ≥1 的整数（0/负数/小数会让截断、分页、预览静默失效）。 */
function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`配置错误：${label} 必须是 ≥1 的整数，收到: ${String(value)}`)
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
    rest: { baseUrl: '', wtAppid: '', wtToken: '', wtOpenid: '', fallbackToSql: true, maxPageSize: 1000 },
    // meta 面阈值：关系图谱安全上限 / 分组渲染阈值 / 默认单页行数。
    meta: { relationCap: 300, defaultPageSize: 100, fieldCap: 300, relationDepth: 3, relationFanout: 3 },
    useAggregateTable: true,
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
    defaultPreviewLimit: 20,
    timeZone: '+08:00',
  },
  security: {
    tableWhitelist: ['WT_TAG', 'WT_DATA', 'WT_CUBE', 'WT_DEVICE'],
    mysqlTableWhitelist: DEFAULT_MYSQL_TABLE_WHITELIST,
    readOnly: true,
    scanGuard: true,
  },
  audit: {
    enabled: true,
    table: 'WT_QUERY_AUDIT',
    userId: 'askdata',
    appId: 'dsh-agp-askdata',
    orgId: '',
  },
  // 知识面默认值：基址指向常规 RAGFlow 部署形态（具体实例由部署配置覆盖）；
  // datasetIds 默认留空——知识工具在未配置时调用期明确报错，不静默失效。
  knowledge: {
    ragflowBaseUrl: 'https://labragf.openagp.top:9080',
    ragflowApiKey: '',
    datasetIds: [] as string[],
    timeoutMs: 20_000,
    maxChunks: 8,
    maxGraphEntities: 60,
    defaultTenant: '',
    tenants: [] as KnowledgeTenantConfig[],
  },
  // 值班报告面默认空台账：防汛值班工具在未配置测站时调用期明确报错，
  // 不影响取数/知识面；阈值与报讯路径是工程专属部署事实，不内嵌默认值。
  duty: {
    project: '',
    outputDir: '',
    stations: [] as DutyStation[],
    reporting: [] as DutyReporting[],
  },
  // 工具组默认全开（现状 24 工具）；云端 API 部署配 { sql: false }。
  toolsets: { sql: true, api: true, knowledge: true },
}

/**
 * `resolveConfig` 入参形态：顶层字段全可选，嵌套段也支持部分覆盖
 * （缺省项由 DEFAULT_CONFIG 补齐）。`createAskdataService` 复用同一形态，
 * 避免入口处再抄一份输入类型。
 */
export interface AskdataConfigInput {
  connection: StarRocksConnection
  mysqlConnection?: Partial<MysqlConnection>
  appId?: number
  tables?: Partial<TableNames>
  query?: Partial<Omit<QueryConfig, 'meta'>> & { meta?: Partial<MetaQueryLimits> }
  system?: Partial<SystemLimits>
  security?: Partial<SecurityConfig>
  audit?: Partial<AuditConfig>
  knowledge?: Partial<KnowledgeConfig>
  duty?: Partial<DutyConfig>
  toolsets?: Partial<AskdataConfig['toolsets']>
}

/**
 * 解析并校验用户配置，补全默认值。
 *
 * 表名与白名单在此处做标识符校验，配置错误在加载期立即失败（misconfiguration fails loud）。
 */
export function resolveConfig(input: AskdataConfigInput): AskdataConfig {
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
    meta: { ...DEFAULT_CONFIG.query.meta, ...input.query?.meta },
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
  if (query.tsdbChannel === 'rest' && !query.rest.baseUrl) {
    throw new Error('配置错误：query.tsdbChannel=rest 时必须配置 query.rest.baseUrl（TSDB HTTP 网关地址）')
  }
  assertPositiveInt(query.rest.maxPageSize, 'query.rest.maxPageSize')
  assertPositiveInt(query.meta.relationCap, 'query.meta.relationCap')
  assertPositiveInt(query.meta.defaultPageSize, 'query.meta.defaultPageSize')
  assertPositiveInt(query.meta.fieldCap, 'query.meta.fieldCap')
  assertPositiveInt(query.meta.relationDepth, 'query.meta.relationDepth')
  assertPositiveInt(query.meta.relationFanout, 'query.meta.relationFanout')
  assertPositiveInt(system.defaultPreviewLimit, 'system.defaultPreviewLimit')

  const knowledge = resolveKnowledgeConfig(input.knowledge)
  const duty = resolveDutyConfig(input.duty)
  const toolsets = {
    sql: input.toolsets?.sql ?? DEFAULT_CONFIG.toolsets.sql,
    api: input.toolsets?.api ?? DEFAULT_CONFIG.toolsets.api,
    knowledge: input.toolsets?.knowledge ?? DEFAULT_CONFIG.toolsets.knowledge,
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
    knowledge,
    duty,
    toolsets,
  }
}

/**
 * 知识面配置解析：基址归一化 + 数据集 id 形态校验 + 环境变量凭据回退 + 租户注册表归一。
 *
 * 凭据优先级（每个租户独立）：显式配置 > 环境变量 RAGFLOW_API_KEY_<ID大写>。
 * 遗留单租户（根配置 ragflowApiKey + datasetIds）回退 RAGFLOW_API_KEY。
 * key 全空的租户/遗留形态保留空串——知识工具调用期报明确错误（与 TSDB 面
 * "未配置mysqlConnection"同一模式），不阻断取数面启动。
 *
 * 租户归一：tenants 非空 = 多租户形态（忽略遗留 key/datasetIds）；
 * tenants 为空且遗留 datasetIds 非空 = 折算为 id=default 的单租户；
 * defaultTenant 缺省取唯一租户，多租户未配置且未解析到租户时调用期 fail loud。
 */
export function resolveKnowledgeConfig(input?: Partial<KnowledgeConfig>): KnowledgeConfig {
  const merged = { ...DEFAULT_CONFIG.knowledge, ...input }
  const apiKey = merged.ragflowApiKey.trim() !== ''
    ? merged.ragflowApiKey.trim()
    : (process.env.RAGFLOW_API_KEY ?? '').trim()
  for (const id of merged.datasetIds) {
    if (!DATASET_ID_RE.test(id)) {
      throw new Error(`配置错误：knowledge.datasetIds 含非法数据集 id: ${id}`)
    }
  }
  const timeoutMs = Math.max(1000, Math.trunc(merged.timeoutMs))
  const clampChunks = (n: number) => Math.min(50, Math.max(1, Math.trunc(n)))
  const clampEntities = (n: number) => Math.min(1024, Math.max(1, Math.trunc(n)))

  const rawTenants = Array.isArray(merged.tenants) ? merged.tenants : []
  const tenants: KnowledgeTenantConfig[] = []
  if (rawTenants.length > 0) {
    const seen = new Set<string>()
    for (const t of rawTenants) {
      const id = String(t?.id ?? '').trim()
      if (!TENANT_ID_RE.test(id)) {
        throw new Error(`配置错误：knowledge.tenants 含非法租户 id: ${id || '（空）'}（只允许小写字母开头的 kebab-case，2-32 字符）`)
      }
      if (seen.has(id)) throw new Error(`配置错误：knowledge.tenants 租户 id 重复: ${id}`)
      seen.add(id)
      const datasetIds = (Array.isArray(t?.datasetIds) ? t.datasetIds : []).map(String)
      for (const ds of datasetIds) {
        if (!DATASET_ID_RE.test(ds)) throw new Error(`配置错误：knowledge.tenants[${id}].datasetIds 含非法数据集 id: ${ds}`)
      }
      const explicitKey = String(t?.ragflowApiKey ?? '').trim()
      const ragflowApiKey = explicitKey !== ''
        ? explicitKey
        : (process.env[`RAGFLOW_API_KEY_${id.replace(/-/g, '_').toUpperCase()}`] ?? '').trim()
      tenants.push({
        id,
        ragflowApiKey,
        datasetIds,
        ...(t?.maxChunks != null && Number.isFinite(Number(t.maxChunks)) ? { maxChunks: clampChunks(Number(t.maxChunks)) } : {}),
        ...(t?.maxGraphEntities != null && Number.isFinite(Number(t.maxGraphEntities)) ? { maxGraphEntities: clampEntities(Number(t.maxGraphEntities)) } : {}),
      })
    }
  } else if (merged.datasetIds.length > 0) {
    // 遗留单租户折算（只认 datasetIds 非空）：部署不迁移也能跑，defaultTenant 自动指向它。
    // 仅有 key 无数据集时不折算——知识面按"未装配"处理，避免产出空检索目标的假租户。
    tenants.push({ id: 'default', ragflowApiKey: apiKey, datasetIds: [...merged.datasetIds] })
  }

  const explicitDefault = String(merged.defaultTenant ?? '').trim()
  const defaultTenant = explicitDefault !== ''
    ? explicitDefault
    : tenants.length === 1 ? tenants[0]!.id : ''
  if (defaultTenant !== '' && !tenants.some((t) => t.id === defaultTenant)) {
    throw new Error(`配置错误：knowledge.defaultTenant 引用了不存在的租户: ${defaultTenant}（可用：${tenants.map((t) => t.id).join('、') || '（无）'}）`)
  }

  return {
    ragflowBaseUrl: normalizeRagflowBaseUrl(merged.ragflowBaseUrl),
    ragflowApiKey: apiKey,
    datasetIds: [...merged.datasetIds],
    timeoutMs,
    maxChunks: clampChunks(merged.maxChunks),
    maxGraphEntities: clampEntities(merged.maxGraphEntities),
    defaultTenant,
    tenants,
  }
}

/** 测站 id / 指标键形态（报告文件名与 rule_id 的拼装原料，禁路径分隔符等）。 */
const DUTY_KEY_RE = /^[0-9A-Za-z_\u4e00-\u9fff-]{1,64}$/

/** 阈值判超操作符全集。 */
const DUTY_THRESHOLD_OPS: readonly DutyThreshold['op'][] = ['>=', '>', '<=', '<']

/**
 * 值班报告面配置解析：台账形态校验（测站 id/指标键/tagName 非空且合法、
 * 阈值 op 合法、小数位 0-8）。台账为空是合法部署（值班工具调用期提示），
 * 配置了台账但字段非法则在加载期失败。
 */
export function resolveDutyConfig(input?: Partial<DutyConfig>): DutyConfig {
  const merged = { ...DEFAULT_CONFIG.duty, ...input }
  const seenStationIds = new Set<string>()
  for (const station of merged.stations) {
    if (!DUTY_KEY_RE.test(station.id)) {
      throw new Error(`配置错误：duty.stations[].id 非法（字母/数字/下划线/中文/连字符，1-64 字符）: ${station.id}`)
    }
    if (seenStationIds.has(station.id)) {
      throw new Error(`配置错误：duty.stations 测站 id 重复: ${station.id}`)
    }
    seenStationIds.add(station.id)
    if (!station.name || station.name.length > 100) {
      throw new Error(`配置错误：duty.stations[${station.id}].name 必填且 ≤100 字符`)
    }
    if (!Array.isArray(station.metrics) || station.metrics.length === 0) {
      throw new Error(`配置错误：duty.stations[${station.id}].metrics 不能为空`)
    }
    const seenMetrics = new Set<string>()
    for (const metric of station.metrics) {
      if (!DUTY_KEY_RE.test(metric.metric)) {
        throw new Error(`配置错误：duty.stations[${station.id}].metrics[].metric 非法: ${metric.metric}`)
      }
      if (seenMetrics.has(metric.metric)) {
        throw new Error(`配置错误：duty.stations[${station.id}] 指标键重复: ${metric.metric}`)
      }
      seenMetrics.add(metric.metric)
      if (!metric.label || metric.label.length > 100) {
        throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}].label 必填且 ≤100 字符`)
      }
      if (!metric.tagName || metric.tagName.length > 200) {
        throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}].tagName 必填（AGP 测点全名）`)
      }
      if (metric.decimals !== undefined && (!Number.isInteger(metric.decimals) || metric.decimals < 0 || metric.decimals > 8)) {
        throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}].decimals 必须是 0-8 整数`)
      }
      for (const threshold of metric.thresholds ?? []) {
        if (!threshold.level || threshold.level.length > 20) {
          throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}] 阈值 level 必填且 ≤20 字符`)
        }
        if (!Number.isFinite(threshold.value)) {
          throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}] 阈值 ${threshold.level}.value 必须是数值`)
        }
        if (threshold.op !== undefined && !DUTY_THRESHOLD_OPS.includes(threshold.op)) {
          throw new Error(`配置错误：duty.stations[${station.id}].metrics[${metric.metric}] 阈值 ${threshold.level}.op 只允许 >= > <= <`)
        }
      }
    }
  }
  for (const item of merged.reporting) {
    if (!item.object || item.object.length > 100) {
      throw new Error('配置错误：duty.reporting[].object 必填且 ≤100 字符')
    }
  }
  if (merged.project.length > 100) {
    throw new Error('配置错误：duty.project ≤100 字符')
  }
  return {
    project: merged.project,
    outputDir: merged.outputDir,
    stations: merged.stations.map((s) => ({
      id: s.id,
      name: s.name,
      metrics: s.metrics.map((m) => ({
        metric: m.metric,
        label: m.label,
        unit: m.unit,
        tagName: m.tagName,
        ...(m.decimals !== undefined ? { decimals: Math.trunc(m.decimals) } : {}),
        ...(m.thresholds ? {
          thresholds: m.thresholds.map((t) => ({ level: t.level, value: t.value, ...(t.op !== undefined ? { op: t.op } : {}) })),
        } : {}),
      })),
    })),
    reporting: merged.reporting.map((r) => ({
      object: r.object,
      ...(r.channel !== undefined ? { channel: r.channel } : {}),
      ...(r.frequency !== undefined ? { frequency: r.frequency } : {}),
    })),
  }
}
