/**
 * P0 SQL 模板（《工具实现规范》§2.3 / §3.1-§3.3，照抄生产三件套）。
 *
 * 模板三件套：`LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex`
 *           + `regexp(tagName, '^Xxx_1O_')`（带 ^）
 *           + `bitand(quality, mask) != mask` 质量过滤。
 * 入参必须先过 `sql/validate.ts`；模板只做字面量转义，不做语义校验。
 * @module
 */

import type { AskdataConfig } from '../config.ts'
import { qualityFilter } from './quality.ts'
import { parseTagFilterPrefix, splitSegment } from './tagname.ts'
import { toSqlTimestamp, type AggFunc, type GroupByDim, type Granularity, type TimeBucket } from './validate.ts'

/** LIKE 关键字转义：`\` `%` `_` 与单引号。 */
export function escapeLike(keyword: string): string {
  return keyword
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
    .replaceAll("'", "''")
}

/**
 * SQL 字符串字面量转义：先反斜杠 doubling 再单引号 doubling（顺序不可换）。
 *
 * MySQL 语义下反斜杠是转义字符：未转义的 `\d` 会丢反斜杠变成 `d`、
 * 尾部 `\` 会吃掉闭合引号。regexp 过滤串经此转义后，正则引擎收到的是用户原文。
 */
export function escapeSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

/** lookup_tag：查 WT_TAG 字典，反查业务名 ↔ tagName（§2.3）。 */
export function lookupTagSql(
  config: AskdataConfig,
  args: { keyword: string; dataType?: number; granularity?: Granularity; limit: number },
): string {
  const kw = escapeLike(args.keyword)
  const conditions = [
    `(tagName LIKE '%${kw}%' OR \`comment\` LIKE '%${kw}%')`,
    args.dataType !== undefined ? `dataType = ${args.dataType}` : undefined,
    args.granularity !== undefined ? `tagName LIKE '%_${args.granularity}_%'` : undefined,
  ].filter((c): c is string => c !== undefined)
  return [
    'SELECT tagName, tagIndex, dataType, `comment`',
    `FROM ${config.tables.tag}`,
    `WHERE ${conditions.join('\n  AND ')}`,
    'ORDER BY tagName',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** tagName 集合的存在性预检（latest_value 前置，缺失 → TAG_NOT_FOUND）。 */
export function tagExistenceSql(config: AskdataConfig, tagNames: string[]): string {
  const list = tagNames.map((t) => escapeSqlString(t)).join(', ')
  return `SELECT tagName FROM ${config.tables.tag} WHERE tagName IN (${list})`
}

/** latest_value 兜底路：StarRocks max_by（§3.1；主路 TSDB HTTP RTDQuery 为 P1）。 */
export function latestValueSql(
  config: AskdataConfig,
  args: { tagNames: string[]; badValueMask: number },
): string {
  const list = args.tagNames.map((t) => escapeSqlString(t)).join(',\n  ')
  return [
    'SELECT b.tagName,',
    '       max_by(a.`value`, a.`timestamp`) AS `latestValue`,',
    '       max(a.`timestamp`) AS `latestTime`',
    `FROM ${config.tables.data} a`,
    `LEFT JOIN ${config.tables.tag} b ON a.tagIndex = b.tagIndex`,
    `WHERE b.tagName IN (\n  ${list}\n)`,
    `  AND ${qualityFilter('a.`quality`', args.badValueMask)}`,
    'GROUP BY b.tagName',
  ].join('\n')
}

/** 时间桶表达式映射（§3.2）。 */
export function bucketExpression(bucket: TimeBucket): string {
  switch (bucket) {
    case 'raw':
      return ''
    case '1m':
      return 'time_slice(a.`timestamp`, INTERVAL 1 minute)'
    case '5m':
      return 'time_slice(a.`timestamp`, INTERVAL 5 minute)'
    case '15m':
      return 'time_slice(a.`timestamp`, INTERVAL 15 minute)'
    case '1h':
      return "date_trunc('hour', a.`timestamp`)"
    case '1d':
      return "date_trunc('day', a.`timestamp`)"
  }
}

/**
 * time_series：时序明细 / 时间桶聚合（§3.2）。别名一律反引号（`maxValue` 撞保留字 MAXVALUE，e2e 实证）。
 *
 * @deprecated 生产路径已由 `timeSeriesByTagIndexSql`（IN 子查询版，§14.10）取代；
 * 保留作为 §3.2 LEFT JOIN 版规格对照与守卫样张，勿在新代码中引用。
 */
export function timeSeriesSql(
  config: AskdataConfig,
  args: {
    tagFilter: string
    startIso: string
    endIso: string
    bucket: TimeBucket
    limit: number
    badValueMask: number
  },
): string {
  const where = [
    `a.\`timestamp\` >= ${toSqlTimestamp(args.startIso, config.system.timeZone)}`,
    `a.\`timestamp\` < ${toSqlTimestamp(args.endIso, config.system.timeZone)}`,
    `regexp(b.tagName, ${escapeSqlString(args.tagFilter)})`,
    qualityFilter('a.`quality`', args.badValueMask),
  ]
  const from = [
    `FROM ${config.tables.data} a`,
    `LEFT JOIN ${config.tables.tag} b ON a.tagIndex = b.tagIndex`,
  ]
  if (args.bucket === 'raw') {
    return [
      'SELECT a.`timestamp`, a.`value`, a.`quality`',
      ...from,
      `WHERE ${where.join('\n  AND ')}`,
      'ORDER BY a.`timestamp`',
      `LIMIT ${args.limit}`,
    ].join('\n')
  }
  const bucketExpr = bucketExpression(args.bucket)
  return [
    `SELECT ${bucketExpr} AS \`bucket\`,`,
    '       AVG(a.`value`) AS `avgValue`,',
    '       MIN(a.`value`) AS `minValue`,',
    '       MAX(a.`value`) AS `maxValue`,',
    '       COUNT(*) AS `sampleCount`',
    ...from,
    `WHERE ${where.join('\n  AND ')}`,
    `GROUP BY ${bucketExpr}`,
    `ORDER BY ${bucketExpr}`,
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** aggregate 的 group_select / GROUP BY 表达式映射（§3.3；split 为 StarRocks 1 基下标）。 */
export function groupByExpression(dim: GroupByDim): { select: string; groupBy: string } {
  switch (dim) {
    case 'none':
      return { select: "'all' AS `bucket`", groupBy: '' }
    case 'device':
      return {
        select: `${splitSegment('b.tagName', 3)} AS \`device\``,
        groupBy: splitSegment('b.tagName', 3),
      }
    case 'tagcode':
      return {
        select: `${splitSegment('b.tagName', 1)} AS \`tagCode\``,
        groupBy: splitSegment('b.tagName', 1),
      }
    case 'bucket_hour':
      return {
        select: "date_trunc('hour', a.`timestamp`) AS `bucket`",
        groupBy: "date_trunc('hour', a.`timestamp`)",
      }
    case 'bucket_day':
      return {
        select: "date_trunc('day', a.`timestamp`) AS `bucket`",
        groupBy: "date_trunc('day', a.`timestamp`)",
      }
    case 'bucket_month':
      return {
        select: "date_trunc('month', a.`timestamp`) AS `bucket`",
        groupBy: "date_trunc('month', a.`timestamp`)",
      }
  }
}

/** aggregate：SQL 端聚合，支持维度分组（§3.3）。 */
export function aggregateSql(
  config: AskdataConfig,
  args: {
    tagFilter: string
    startIso: string
    endIso: string
    func: AggFunc
    groupBy: GroupByDim
    limit: number
    badValueMask: number
  },
): string {
  const where = [
    `a.\`timestamp\` >= ${toSqlTimestamp(args.startIso, config.system.timeZone)}`,
    `a.\`timestamp\` < ${toSqlTimestamp(args.endIso, config.system.timeZone)}`,
    `regexp(b.tagName, ${escapeSqlString(args.tagFilter)})`,
    qualityFilter('a.`quality`', args.badValueMask),
  ]
  const { select, groupBy } = groupByExpression(args.groupBy)
  const aggCall = args.func === 'COUNT' ? 'COUNT(*)' : `${args.func}(a.\`value\`)`
  return [
    `SELECT ${select},`,
    `       ${aggCall} AS \`aggValue\`,`,
    '       COUNT(*) AS `sampleCount`',
    `FROM ${config.tables.data} a`,
    `LEFT JOIN ${config.tables.tag} b ON a.tagIndex = b.tagIndex`,
    `WHERE ${where.join('\n  AND ')}`,
    ...(groupBy ? [`GROUP BY ${groupBy}`] : []),
    'ORDER BY `aggValue` DESC',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** estimate_count：扫描行数估算（超 maxScanRows 拒绝返回明细）。 */
export function estimateScanSql(config: AskdataConfig, startIso: string, endIso: string): string {
  return [
    `SELECT COUNT(*) AS \`scanRows\` FROM ${config.tables.data}`,
    `WHERE \`timestamp\` >= ${toSqlTimestamp(startIso, config.system.timeZone)}`,
    `  AND \`timestamp\` < ${toSqlTimestamp(endIso, config.system.timeZone)}`,
  ].join('\n')
}

// ============ P1 优化：tagIndex 预查 + WT_CUBE 路由（§14.10） ============

/** 从 tag_filter 正则中提取粒度后缀（如 `^HWNBYC174_1H_` → `1H`）。 */
export function extractGranularityFromFilter(tagFilter: string): string | null {
  for (const g of ['1O', '2O', '1H', '1D', '1M', '1Y']) {
    if (tagFilter.includes(`_${g}_`)) return g
  }
  return null
}

/**
 * WT_TAG 字典过滤谓词：可解析前缀（`^tagCode_粒度_[device]`）时用等值/LIKE 前缀
 * （唯一索引/short key 前缀，实测 30-90ms），否则退回 regexp（全表扫，
 * 2026-09-09 实测 6.7s vs 0.03s，负载慢时 30s+）。
 */
export function tagFilterPredicate(tagFilter: string): string {
  const parts = parseTagFilterPrefix(tagFilter)
  if (parts?.deviceId) {
    return `tagName = ${escapeSqlString(`${parts.tagCode}_${parts.granularity}_${parts.deviceId}`)}`
  }
  if (parts) {
    return `tagName LIKE '${escapeLike(`${parts.tagCode}_${parts.granularity}_`)}%'`
  }
  return `regexp(tagName, ${escapeSqlString(tagFilter)})`
}

/** 预查 tagIndex：按 tag_filter 过滤 WT_TAG（谓词见 tagFilterPredicate）。 */
export function tagIndexByFilterSql(config: AskdataConfig, tagFilter: string): string {
  return [
    'SELECT tagIndex',
    `FROM ${config.tables.tag}`,
    `WHERE ${tagFilterPredicate(tagFilter)}`,
  ].join('\n')
}

/** time_series（tagIndex 优化版）：用 IN 子查询替代 JOIN，避免 WT_DATA 逐行 JOIN WT_TAG。 */
export function timeSeriesByTagIndexSql(
  config: AskdataConfig,
  args: {
    tagFilter: string
    startIso: string
    endIso: string
    bucket: TimeBucket
    limit: number
    badValueMask: number
  },
): string {
  const where = [
    `a.\`timestamp\` >= ${toSqlTimestamp(args.startIso, config.system.timeZone)}`,
    `a.\`timestamp\` < ${toSqlTimestamp(args.endIso, config.system.timeZone)}`,
    `a.tagIndex IN (SELECT tagIndex FROM ${config.tables.tag} WHERE ${tagFilterPredicate(args.tagFilter)})`,
    qualityFilter('a.`quality`', args.badValueMask),
  ]
  const from = [`FROM ${config.tables.data} a`]
  if (args.bucket === 'raw') {
    return [
      'SELECT a.`timestamp`, a.`value`, a.`quality`',
      ...from,
      `WHERE ${where.join('\n  AND ')}`,
      'ORDER BY a.`timestamp`',
      `LIMIT ${args.limit}`,
    ].join('\n')
  }
  const bucketExpr = bucketExpression(args.bucket)
  return [
    `SELECT ${bucketExpr} AS \`bucket\`,`,
    '       AVG(a.`value`) AS `avgValue`,',
    '       MIN(a.`value`) AS `minValue`,',
    '       MAX(a.`value`) AS `maxValue`,',
    '       COUNT(*) AS `sampleCount`',
    ...from,
    `WHERE ${where.join('\n  AND ')}`,
    `GROUP BY ${bucketExpr}`,
    `ORDER BY ${bucketExpr}`,
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** aggregate（tagIndex 优化版）：用 IN 子查询替代 JOIN。 */
export function aggregateByTagIndexSql(
  config: AskdataConfig,
  args: {
    tagFilter: string
    startIso: string
    endIso: string
    func: AggFunc
    groupBy: GroupByDim
    limit: number
    badValueMask: number
  },
): string {
  const where = [
    `a.\`timestamp\` >= ${toSqlTimestamp(args.startIso, config.system.timeZone)}`,
    `a.\`timestamp\` < ${toSqlTimestamp(args.endIso, config.system.timeZone)}`,
    `a.tagIndex IN (SELECT tagIndex FROM ${config.tables.tag} WHERE ${tagFilterPredicate(args.tagFilter)})`,
    qualityFilter('a.`quality`', args.badValueMask),
  ]
  const { select, groupBy } = groupByExpression(args.groupBy)
  const aggCall = args.func === 'COUNT' ? 'COUNT(*)' : `${args.func}(a.\`value\`)`
  return [
    `SELECT ${select},`,
    `       ${aggCall} AS \`aggValue\`,`,
    '       COUNT(*) AS `sampleCount`',
    `FROM ${config.tables.data} a`,
    `WHERE ${where.join('\n  AND ')}`,
    ...(groupBy ? [`GROUP BY ${groupBy}`] : []),
    'ORDER BY `aggValue` DESC',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** aggregate（WT_CUBE 路由版）的分组表达式：WT_CUBE 自带 device/tagCode 列，无需 JOIN WT_TAG。 */
function cubeGroupExpression(dim: GroupByDim): { select: string; groupBy: string } {
  switch (dim) {
    case 'none':
      return { select: "'all' AS `bucket`", groupBy: '' }
    case 'device':
      return { select: 'a.`device` AS `device`', groupBy: 'a.`device`' }
    case 'tagcode':
      return { select: 'a.`tagCode` AS `tagCode`', groupBy: 'a.`tagCode`' }
    case 'bucket_hour':
      return { select: "date_trunc('hour', a.`timestamp`) AS `bucket`", groupBy: "date_trunc('hour', a.`timestamp`)" }
    case 'bucket_day':
      return { select: "date_trunc('day', a.`timestamp`) AS `bucket`", groupBy: "date_trunc('day', a.`timestamp`)" }
    case 'bucket_month':
      return { select: "date_trunc('month', a.`timestamp`) AS `bucket`", groupBy: "date_trunc('month', a.`timestamp`)" }
  }
}

/**
 * WT_CUBE 路由前的 cubeType 唯一性预检：真实库中个别 tagCode 对应 2 个 cubeType
 * （如 NBQDLLSD1 → 电流/电量离散率），口径不唯一时调用方必须回退 WT_DATA 路径。
 *
 * `deviceId` 以数值字面量拼进 SQL：类型系统强制 number（来源 `parseTagFilterPrefix`
 * 的 `\d+` 捕获组，调用方负责 Number 转换），杜绝字符串拼接位注入。
 */
export function cubeTypeDistinctSql(
  config: AskdataConfig,
  args: { tagCode: string; deviceId?: number; granularity: number },
): string {
  const where = [
    `tagCode = ${escapeSqlString(args.tagCode)}`,
    ...(args.deviceId !== undefined ? [`device = ${args.deviceId}`] : []),
    `granularity = ${args.granularity}`,
  ]
  return [
    'SELECT DISTINCT cubeType',
    `FROM ${config.tables.cube}`,
    `WHERE ${where.join('\n  AND ')}`,
  ].join('\n')
}

/**
 * aggregate（WT_CUBE 路由版）：按 tagCode(+device)+granularity 等值过滤聚合表。
 *
 * 列面以真实 DDL 为准（2026-09-09 实测）：device/tagCode/cubeType/timestamp/granularity/
 * value/avgValue/maxValue1/minValue1/sumValue/countValue——无 quality、无 tagIndex/tagName，
 * 因此不过质量位过滤、不走 tagIndex 子查询；func 作用于 value（该粒度下测点的汇总值）。
 */
export function aggregateCubeSql(
  config: AskdataConfig,
  args: {
    tagCode: string
    deviceId?: number
    startIso: string
    endIso: string
    func: AggFunc
    groupBy: GroupByDim
    granularity: number
    limit: number
  },
): string {
  const where = [
    `a.\`timestamp\` >= ${toSqlTimestamp(args.startIso, config.system.timeZone)}`,
    `a.\`timestamp\` < ${toSqlTimestamp(args.endIso, config.system.timeZone)}`,
    `a.\`tagCode\` = ${escapeSqlString(args.tagCode)}`,
    ...(args.deviceId !== undefined ? [`a.\`device\` = ${args.deviceId}`] : []),
    `a.\`granularity\` = ${args.granularity}`,
  ]
  const { select, groupBy } = cubeGroupExpression(args.groupBy)
  const aggCall = args.func === 'COUNT' ? 'COUNT(*)' : `${args.func}(a.\`value\`)`
  return [
    `SELECT ${select},`,
    `       ${aggCall} AS \`aggValue\`,`,
    '       COUNT(*) AS `sampleCount`',
    `FROM ${config.tables.cube} a`,
    `WHERE ${where.join('\n  AND ')}`,
    ...(groupBy ? [`GROUP BY ${groupBy}`] : []),
    'ORDER BY `aggValue` DESC',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

// ============ P1 MySQL 元数据模板（§14.7） ============

/** MySQL 表名加数据库前缀（与白名单全限定格式对齐）。 */
function mysqlTable(config: AskdataConfig, table: string): string {
  return `${config.mysqlConnection.database}.${table}`
}

/** lookup_model：查模型清单（meta_class_info，app_id 过滤；LIMIT 受 maxLimit 约束）。 */
export function lookupModelSql(config: AskdataConfig, appId: number, limit: number): string {
  return [
    'SELECT class_alias, class_name, class_path, level',
    `FROM ${mysqlTable(config, 'meta_class_info')}`,
    `WHERE app_id = ${appId}`,
    'ORDER BY class_path',
    `LIMIT ${limit}`,
  ].join('\n')
}

/** lookup_object：查设备对象（wt_elm_equipment，按 class__path/node_name/parent_id 过滤）。 */
export function lookupObjectSql(
  config: AskdataConfig,
  args: { appId: number; classPath?: string; nodeName?: string; parentId?: number; limit: number },
): string {
  const conditions = [`deleted = 0`, `app_id = ${args.appId}`]
  if (args.classPath) conditions.push(`class__path LIKE '%${escapeLike(args.classPath)}%'`)
  if (args.nodeName) conditions.push(`node_name LIKE '%${escapeLike(args.nodeName)}%'`)
  if (args.parentId !== undefined) conditions.push(`parent_id = ${args.parentId}`)
  return [
    'SELECT id, node_code, node_name, class__path, parent_id, tree_level, position',
    `FROM ${mysqlTable(config, 'wt_elm_equipment')}`,
    `WHERE ${conditions.join('\n  AND ')}`,
    'ORDER BY node_code',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** lookup_tag_definition：查动态属性定义（meta_classtagmodel JOIN meta_class_info）。 */
export function lookupTagDefinitionSql(config: AskdataConfig, classPath: string): string {
  return [
    'SELECT t.tag_code, t.name, t.tag_type, t.calculated, t.in_out',
    `FROM ${mysqlTable(config, 'meta_classtagmodel')} t`,
    `JOIN ${mysqlTable(config, 'meta_class_info')} c ON t.master_class_id = c.id`,
    `WHERE c.class_path = ${escapeSqlString(classPath)} AND t.deleted = 0`,
    'ORDER BY t.tag_code',
  ].join('\n')
}

/** query_alarm：查告警记录（wt_bas_alarmrecord，按时间/级别过滤）。 */
export function queryAlarmSql(
  config: AskdataConfig,
  args: { appId: number; startTime: string; endTime: string; alarmLevel?: string; limit: number },
): string {
  const conditions = [
    `deleted = 0`,
    `app_id = ${args.appId}`,
    `alarm_time >= ${toSqlTimestamp(args.startTime, config.system.timeZone)}`,
    `alarm_time < ${toSqlTimestamp(args.endTime, config.system.timeZone)}`,
  ]
  if (args.alarmLevel) conditions.push(`alarm_level = ${escapeSqlString(args.alarmLevel)}`)
  return [
    'SELECT id, alarm_title, alarm_time, alarm_level, alarm_status, entity_name, tag_code, description',
    `FROM ${mysqlTable(config, 'wt_bas_alarmrecord')}`,
    `WHERE ${conditions.join('\n  AND ')}`,
    'ORDER BY alarm_time DESC',
    `LIMIT ${args.limit}`,
  ].join('\n')
}

/** query_alarm_config：查告警配置（bole.wt_cus_alarmdynamicconfig，跨库引用）。 */
export function queryAlarmConfigSql(
  config: AskdataConfig,
  args: { appId: number; cusClassPath?: string },
): string {
  const conditions = [`deleted = 0`, `app_id = ${args.appId}`]
  if (args.cusClassPath) conditions.push(`cus_class_path = ${escapeSqlString(args.cusClassPath)}`)
  // bole 库不在 mysqlConnection.database 配置范围内（告警配置专属库），故不走
  // mysqlTable() 前缀约定而直接跨库引用；库名变更需同步 DEFAULT_MYSQL_TABLE_WHITELIST。
  return [
    'SELECT tag_code, tag_comment, cus_class_path, alarm_type, alarm_level, alarm_classify, is_white, status',
    'FROM bole.wt_cus_alarmdynamicconfig',
    `WHERE ${conditions.join('\n  AND ')}`,
    'ORDER BY tag_code',
  ].join('\n')
}

// ============ resolve_tag 5 步链路模板（§14.3） ============

/** resolve_tag step1：查设备 id + class__path（wt_elm_equipment）。 */
export function resolveTagStep1Sql(config: AskdataConfig, deviceName: string, appId: number): string {
  return [
    'SELECT id, class__path',
    `FROM ${mysqlTable(config, 'wt_elm_equipment')}`,
    `WHERE node_name = ${escapeSqlString(deviceName)} AND deleted = 0 AND app_id = ${appId}`,
    'LIMIT 1',
  ].join('\n')
}

/** resolve_tag step2：查 tagCode（meta_classtagmodel JOIN meta_class_info）。 */
export function resolveTagStep2Sql(config: AskdataConfig, tagNameCn: string, classPath: string): string {
  return [
    'SELECT t.tag_code',
    `FROM ${mysqlTable(config, 'meta_classtagmodel')} t`,
    `JOIN ${mysqlTable(config, 'meta_class_info')} c ON t.master_class_id = c.id`,
    `WHERE t.name = ${escapeSqlString(tagNameCn)} AND c.class_path = ${escapeSqlString(classPath)} AND t.deleted = 0`,
    'LIMIT 1',
  ].join('\n')
}

/** resolve_tag step4：确认 tagName 存在 + 查 alias（wt_iot_tags）。 */
export function resolveTagStep4Sql(config: AskdataConfig, tagName: string): string {
  return [
    'SELECT alias',
    `FROM ${mysqlTable(config, 'wt_iot_tags')}`,
    `WHERE tagname = ${escapeSqlString(tagName)} AND deleted = 0`,
    'LIMIT 1',
  ].join('\n')
}

/** resolve_tag step5：查 tagIndex（WT_TAG，走 StarRocks）。 */
export function resolveTagStep5Sql(config: AskdataConfig, tagName: string): string {
  return [
    'SELECT tagIndex',
    `FROM ${config.tables.tag}`,
    `WHERE tagName = ${escapeSqlString(tagName)}`,
    'LIMIT 1',
  ].join('\n')
}
