/**
 * askdata skill 行（`dsh-agp-askdata/skills`）：
 * 把 12 个工具的使用手册按"问数工作流"聚合为 4 个可召回的 skill，
 * 让用户/模型在面对复杂问题时按需加载详细指引，不必每次都看见 12 个工具的 schema。
 *
 * 设计：
 * - 聚合而非一对一：一个 skill = 一类问题的工作流（不是单个工具的说明书），符合
 *   `whenToUse` 的"问题描述而非工具列表"语义；
 * - 调用策略 modelInvocable=true / userInvocable=true：用户 `/skill` 显式调用 + 模型
 *   按目录自动发现两种入口都开放；
 * - 注册时机：在 askdata 宿主行 `apply` 后由 askdata-skills 行注入（cordis 行注入
 *   `ctx.skills`，与 dsh-tool-skill 同一层），保证 askdata 工具可用时 skill 也可用。
 *
 * 实施参考：`@deepseek-ai/dsh-skill` SkillRegistration 接口 + `ctx.skills.register`。
 * @module dsh-agp-askdata/skills
 */

import type { Context } from '@deepseek-ai/cordis'

/** Skill name 校验：仅小写字母/数字/单连字符，避免目录注入与歧义。 */
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

/** askdata 注入的 skill 注册项（content 是 Markdown 正文）。 */
export interface AskdataSkill {
  /** kebab-case 名，目录与 `skill` 工具的入参。 */
  name: string
  /** 一行以内的路由描述（进入模型可调用 skill 目录）。 */
  description: string
  /** 可选的额外路由提示（更具体的"何时用"）。 */
  whenToUse?: string
  /** Markdown 正文（被注入模型上下文的 `<skill_content>` 块）。 */
  content: string
}

/** askdata 提供的 4 个 skill 聚合（顺序即目录展示顺序）。 */
export const ASKDATA_SKILLS: readonly AskdataSkill[] = [
  {
    name: 'askdata-troubleshoot',
    description: '问数链路出问题时的标准化排查（连接 / 凭据 / 白名单 / 超时 / 路由）。',
    whenToUse: '当聚合查询报错（EXCEED_LIMIT / BACKEND_DOWN / DML_FORBIDDEN / SENSITIVE_TABLE）、data-agent 拉不到行、cube 路由失效、或时间窗口/扫描护栏触顶时调用。',
    content: `# askdata 排查手册

## 1. 错误码映射（按码定位修复方向）

| 错误码 | 含义 | 常见原因 | 第一动作 |
|---|---|---|---|
| \`BACKEND_DOWN\` | 后端不可达 | StarRocks/MySQL 连接超时/拒绝；REST 网关未部署 | 检查 connection.host/port/user/password；REST 失败应自动回落 SQL，若 \`rest.fallbackToSql=false\` 则直接失败 |
| \`WT_SQL_PARSE_ERROR\` | SQL 引擎拒绝 | 表不在白名单 / SQL 语法问题 / 模板产物引号被改 | 闸门通过后再出此码 → 检查 \`security.tableWhitelist\`；不通过 → 模板拼装有 bug |
| \`SENSITIVE_TABLE\` | 表不在白名单 | 工具或被注入 | 闸门不允许任何非白名单 SQL；审视工具入参是否被注入 |
| \`DML_FORBIDDEN\` | 含写/管理 | 不应从工具触发；本插件 \`security.readOnly=true\` 恒开 | 工具实现 bug 或恶意工具注入 |
| \`EXCEED_LIMIT\` | 扫描超限 | WT_DATA 全表扫在长窗口下顶到 \`system.maxScanRows\` | 用 1H/1D/1M/1Y 粒度 tag + aggregate（自动走 WT_CUBE）；或缩小时间窗口 |
| \`TAG_NOT_FOUND\` | tag_filter 未命中 | 没测点匹配；tag_filter 含正则元字符 | 先 lookup_tag 确认字典存在性；过滤串避免 \`.*\` \`(\` 等 |
| \`OBJECT_NOT_FOUND\` / \`TAG_DEFINITION_NOT_FOUND\` | 中文解析某步失败 | 中文名与 \`meta_classtagmodel.name\` 不严格相等；测点不在设备 class__path 下 | lookup_object → lookup_tag_definition → 用精确中文名 |
| \`TAG_NOT_REGISTERED\` | wt_iot_tags 没注册 | tagCode 与 deviceId 隶属关系不一致 | 查 \`wt_iot_tags WHERE tagname LIKE '前缀%'\` 确认 deviceId 真实隶属 |

## 2. REST 通道（tsdbChannel=rest）专项

- 网关未部署（ECONNREFUSED）会抛 BACKEND_DOWN；若 \`rest.fallbackToSql=true\` 自动回落到 SQL 通道；日志会输出"REST 通道失败，回落 SQL"。
- REST 主路目前只覆盖 latest_value（\`iotRealTimeValue\`）；time_series / aggregate 仍走 SQL。
- 鉴权三头在 DSH 配置页或 cordis.patch.yml 中配，禁止写代码常量。

## 3. 性能调优速查

| 现象 | 根因 | 修复 |
|---|---|---|
| aggregate 30s 超时（短窗口） | WT_DATA 全表扫；1D 测点未走 cube | 确认 tag_filter 带 \`^tagCode_粒度_device\`；考虑关 cube 看是否 SQL 路径反而快 |
| 最新值连续 30s 超时 | \`max_by\` 在大表上慢 | persona 已指引降级用 1D + aggregate MAX；联调集群建议生产部署独立 FE |
| WT_TAG 字典查询慢 | regexp() 全表扫 236 万行 | \`tagFilterPredicate\` 已自动等值/LIKE 兜底，regexp 仅在非保守形态用 |

## 4. 部署环境关键事实

- TSDB 数据锚点：约止于 2024-08-14；告警记录在 2024-06-16~10-10。
- StarRocks 集群负载波动大，单查询 1.7s~60s+ 都正常，\`queryTimeoutMs\` 配 30s 较稳。
- MySQL 凭据不落仓库：开发用 \`$DSH_HOME/patches/askdata-dev.local.yml\` overlay。
`,
  },
  {
    name: 'askdata-tagname',
    description: 'tagName 四段式编码、粒度段、tagCode/tagIndex 解析规则。',
    whenToUse: '用户用中文设备名+中文测点名提问、需要把 \`HWNBYC174_1D_100620000015521\` 这种全名解释给用户、或需要决定用 1O 还是 1D 粒度时调用。',
    content: `# tagName 四段式手册

## 1. 结构

\`\`\`
tagName = \`\${prefix}_tagCode_\${granularity}_\${deviceId}\`
\`\`\`

例如：\`HWNBYC174_1D_100620000015521\` = 前缀\`HWN\`+厂商编码、tagCode \`HWNBYC174\`、粒度段 \`1D\`、设备 id \`100620000015521\`。

## 2. 粒度段

\`\`\`
2 字节：首位 = 点类型（1=模拟量，2=状态量），末位 = 时间粒度
O = 原始（按采集频率）
H = 小时聚合（1H 走 WT_CUBE）
D = 日聚合（1D 走 WT_CUBE，月累计/总发电量等典型场景）
M = 月聚合（1M 走 WT_CUBE）
Y = 年聚合（1Y 走 WT_CUBE）
\`\`\`

**WT_DATA 上只有 1O 粒度有原始数据**；1H/1D/1M/1Y 数据在 \`WT_CUBE\` 预聚合表。

## 3. 累计量 vs 瞬时量的粒度选择

| 量纲 | 推荐粒度 | 自动走 |
|---|---|---|
| 总发电量、日累计、月累计 | \`1D\` 或 \`1M\` | WT_CUBE（快） |
| 当前电压、当前电流 | \`1O\`（或 \`2O\` 状态量） | WT_DATA 原始 |
| 区间均值/最大/最小 | 看查询周期：跨天用 \`1D\`，当日用 \`1O\` | 取决于周期 |

## 4. StarRocks SQL 端 1 基下标

- \`split(tagName, '_')[1]\` = tagCode
- \`split(tagName, '_')[3]\` = deviceId
- 禁止 0 基下标（StarRocks split 数组从 1 开始）

## 5. tagCode ↔ cubeType 一一对应

\`WT_CUBE\` cubeType 1-20 是 cubeType 编号；同一 tagCode 在某些粒度下会映射到多个 cubeType（实测 cubeType 13+15 对应同一 tagCode），aggregate 路由前的 \`cubeTypeDistinctSql\` 预检会处理这种歧义（不唯一则回退 WT_DATA）。
`,
  },
  {
    name: 'askdata-query-pattern',
    description: '典型问数工作流：从自然语言到工具调用的标准 5 步模板。',
    whenToUse: '面对一个新查询不知道先调哪个工具、不知道参数怎么填、需要把 12 个工具串成可复用流水线时调用。',
    content: `# 问数工作流标准模板

## 1. 五步问数流程

\`\`\`
[1] lookup_model          → 可选，了解有哪些设备模型
    ↓
[2] lookup_object         → 把用户的中文设备名解析成 deviceId + class__path
    ↓
[3] resolve_tag           → 把"测点中文名"解析成 tagName + tagIndex
    ↓
[4] estimate_count        → 大窗口先估算（cube 路由命中时跳过）
    ↓
[5] time_series / aggregate / latest_value / query_alarm → 取数
\`\`\`

## 2. 工具选择速查

| 用户问的 | 推荐工具链 |
|---|---|
| "X 设备 Y 测点的最新值" | resolve_tag → latest_value；超时降级 aggregate MAX |
| "X 设备最近一小时电流趋势" | resolve_tag → estimate_count → time_series(bucket=1h) |
| "X 设备过去 N 天日均值" | resolve_tag → aggregate(1D tag + AVG)；自动走 WT_CUBE |
| "今天有哪些告警" | query_alarm(当天起) |
| "哪些设备有这类告警配置" | query_alarm_config(cus_class_path=设备类路径) |
| "X 类设备型号清单" | lookup_model(app_id 过滤) |

## 3. 工具输入规约

- 所有时间入参：ISO8601，\`system.maxTimeRangeDays\` 内；纯日期 \`YYYY-MM-DD\` 当天 00:00 起。
- tag_filter：必带 \`^\` 锚定，匹配一个具体粒度+设备前缀；\`^HWNBYC174_1D_100620000015524\` 是最理想形态。
- 查询时窗：先用 estimate_count 看扫描量，超过 \`system.maxScanRows\` 时改用 1D 粒度 + aggregate（cube 路由自动生效）。

## 4. 强制约束（persona 硬性约束）

- LLM 不能直接拼裸 SQL；任何 SQL 都被闸门拦截。
- 所有取数走 askdata 工具，不接受"我自己写 SQL"的请求。
- 工具错误码被设计成可恢复：超时→换粒度、不存在→换查询、降级→查元数据。
`,
  },
  {
    name: 'askdata-config',
    description: '运行时配置（密码、连接、超时、cube 路由、REST 通道）的修改与生效路径。',
    whenToUse: '用户问"怎么改数据库密码"、"怎么切换 cube/原始表"、"怎么启用 TSDB 网关"、"怎么加白名单"、或新环境上线需要调整连接参数时调用。',
    content: `# 运行时配置手册

## 1. 配置在哪（按优先级从高到低）

1. **DSH 设置页**（Settings → Plugins）：\`<DSH web>\` 后端 schemastery 自动渲染，密码字段遮蔽回显（\`role('secret')\`），改完即时生效。
2. **用户层 patch**（\`$DSH_HOME/patches/*.yml\`）：\`dsh --profile web --patch <path>\` 启动时合并。生产密码/连接建议放在这里，**不落仓库**。
3. **仓库内 cordis.patch.yml**：默认配置 + 开发凭据占位，提交到 git。
4. **硬编码默认值**：\`src/config.ts\` 的 \`DEFAULT_*\` 常量，最后一道兜底。

## 2. 关键开关速查

| 配置 | 默认 | 效果 | 何时改 |
|---|---|---|---|
| \`connection.host/port/user/password/database\` | 全空 | TSDB 连接 | 任何环境上线必改 |
| \`connection.driver\` | \`mysql2\` | \`cli\` 回落外部 mysql 客户端 | 严格环境无驱动时 |
| \`mysqlConnection.*\` | 全空 | MySQL 业务库 | 用 P1 元数据/告警工具时改 |
| \`query.tsdbChannel\` | \`sql\` | latest_value 取数通道 | 网关可用时改 \`rest\` |
| \`query.rest.{baseUrl,wtAppid,wtToken,wtOpenid}\` | 全空 | TSDB 网关鉴权 | 启用 rest 时必填 |
| \`query.rest.fallbackToSql\` | \`true\` | REST 失败回落 SQL | 网关不稳定时关闭以快速失败 |
| \`query.useAggregateTable\` | \`true\` | 是否启用 WT_CUBE 路由 | 非光伏行业/口径存疑时关闭 |
| \`query.aggregateTable\` | \`WT_CUBE\` | 预聚合表名 | 集群无 cube 时置空 |
| \`query.cubeTypeMapJson\` | 1-20 光伏 cubeType 映射 | 影响路由解释 | 多行业切换时改 |
| \`query.granularityMapJson\` | 1H=1,1D=2,1M=3,1Y=4 | 粒度→granularity 值 | WT_CUBE 列不变则不改 |
| \`system.queryTimeoutMs\` | \`15000\` | 单条 SQL 超时 | 联调库波动时改 30000 |
| \`system.maxScanRows\` | \`1e8\` | 扫描护栏 | WT_DATA 全表场景调高 |
| \`system.timeZone\` | \`+08:00\` | 时间字面量偏移换算 | 仅接受 ±HH:MM |
| \`security.tableWhitelist\` | WT_TAG/WT_DATA/WT_CUBE/WT_DEVICE | 基础库白名单 | 加新表时追加 |
| \`security.mysqlTableWhitelist\` | 7 个 wisetao_meta.* + bole.* | MySQL 白名单 | 跨库新表时追加 |
| \`audit.enabled\` | \`false\` | 审计哈希链启用 | 上线时开 |

## 3. 安全红线

- 密码走 \`.role('secret')\`，页面不回显、代码不打印、日志不输出。
- 凭据不进 git：开发用 \`$DSH_HOME/patches/\` overlay；生产用 DSH credentials 服务。
- \`security.readOnly\` 不开放配置（P0 恒 true）。

## 4. 验证连接

启动 DSH web 后用 \`pnpm tsx scripts/e2e-p0.ts\` 跑 P0 端到端；用 \`scripts/e2e-p1.ts\` 验 P1。MySQL 通了 6/6 = 35 行模型 / 222 行测点定义 / 11619 条告警。
`,
  },
] as const

/**
 * 校验全部 skill name 合法（加载期 fail loud）。
 * 取值来自常量，理论不会失败；保留以防手工编辑失误。
 */
export function assertAskdataSkillShape(): void {
  for (const s of ASKDATA_SKILLS) {
    if (!NAME_RE.test(s.name)) throw new Error(`askdata skill name 非法: ${s.name}`)
    if (!s.description || s.description.length > 200) {
      throw new Error(`askdata skill description 非法: ${s.name}`)
    }
  }
}

/** Cordis 插件名（诊断用）。 */
export const name = 'askdata-skills'

/** 宿主服务的 skills 注册表 + askdata 服务面（供反向引用）；tools 服务由 askdata-tools 行提供。 */
export const inject = ['skills', 'askdata']

/** 本行无自有配置。 */
export const Config: unknown = {}

/** 注入到 Context 的 skills 接口（与 @deepseek-ai/dsh-skill 的 SkillRegistry 形状对齐）。 */
interface SkillsService {
  register(registration: {
    name: string
    description: string
    whenToUse?: string
    content: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
    source: string
    provider: string
  }): () => void
}

/**
 * 把 ASKDATA_SKILLS 注入 \`ctx.skills\`。
 *
 * rank 250（runtime）让项目层 skill 可覆盖；DSH 显式手势注入（/skill）会经
 * \`renderSkillContent\` 把 content 注入模型上下文，实现"按需加载详细手册"。
 */
export function apply(ctx: Context): void {
  assertAskdataSkillShape()
  const skills = (ctx as Context & { skills?: SkillsService }).skills
  if (!skills) return
  for (const s of ASKDATA_SKILLS) {
    const dispose = skills.register({
      name: s.name,
      description: s.description,
      ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
      content: s.content,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'runtime',
    })
    ctx.effect(() => dispose, `askdata: dispose skill ${s.name}`)
  }
}
