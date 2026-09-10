import { describe, expect, it } from 'vitest'
import { resolveConfig, type AskdataConfig } from '../src/config.ts'
import {
  lookupTagSql,
  latestValueSql,
  timeSeriesSql,
  aggregateSql,
  estimateScanSql,
  tagExistenceSql,
  lookupModelSql,
  lookupObjectSql,
  lookupTagDefinitionSql,
  queryAlarmSql,
  queryAlarmConfigSql,
  resolveTagStep1Sql,
  resolveTagStep2Sql,
  resolveTagStep4Sql,
  resolveTagStep5Sql,
  lookupDeviceSql,
  tagIndexByFilterSql,
  timeSeriesByTagIndexSql,
  aggregateByTagIndexSql,
  aggregateCubeSql,
  cubeTypeDistinctSql,
  extractGranularityFromFilter,
} from '../src/sql/templates.ts'
import { assertSafeToExecute } from '../src/sql/whitelist.ts'

function testConfig(): AskdataConfig {
  return resolveConfig({
    connection: { host: 'fe.example.com', port: 9030, user: 'askdata', password: 'p', database: 'agp' },
    mysqlConnection: { host: 'db.example.com', port: 3306, user: 'askdata', password: 'p', database: 'wisetao_meta' },
  })
}

describe('lookupTagSql（§2.3）', () => {
  it('LIKE 转义 + 粒度过滤', () => {
    const sql = lookupTagSql(testConfig(), { keyword: "组串电流'100%", limit: 100 })
    expect(sql).toContain("tagName LIKE '%组串电流''100\\%%'")
    expect(sql).toContain('FROM WT_TAG')
    expect(sql).toContain('LIMIT 100')
    const withGran = lookupTagSql(testConfig(), { keyword: '电流', granularity: '1O', dataType: 2, limit: 50 })
    expect(withGran).toContain("tagName LIKE '%_1O_%'")
    expect(withGran).toContain('dataType = 2')
  })
})

describe('latestValueSql（§3.1 兜底路）', () => {
  it('max_by + IN + 质量过滤', () => {
    const sql = latestValueSql(testConfig(), { tagNames: ['HWNBYC174_1O_DEV001', "x'y"], badValueMask: 128 })
    expect(sql).toContain('max_by(a.`value`, a.`timestamp`) AS `latestValue`')
    expect(sql).toContain('LEFT JOIN WT_TAG b ON a.tagIndex = b.tagIndex')
    expect(sql).toContain("'HWNBYC174_1O_DEV001'")
    expect(sql).toContain("'x''y'")
    expect(sql).toContain('bitand(a.`quality`, 128) != 128')
  })
  it('存在性预检 SQL', () => {
    expect(tagExistenceSql(testConfig(), ['t1', 't2'])).toContain("WHERE tagName IN ('t1', 't2')")
  })
})

describe('timeSeriesSql（§3.2）', () => {
  const base = {
    tagFilter: '^HWNBYC174_1O_',
    startIso: '2026-08-01T00:00:00+08:00',
    endIso: '2026-08-02T00:00:00+08:00',
    limit: 1000,
    badValueMask: 128,
  }
  it('1h 桶金样', () => {
    const sql = timeSeriesSql(testConfig(), { ...base, bucket: '1h' })
    expect(sql).toContain("date_trunc('hour', a.`timestamp`) AS `bucket`")
    expect(sql).toContain('AVG(a.`value`) AS `avgValue`')
    expect(sql).toContain("MAX(a.`value`) AS `maxValue`")
    expect(sql).toContain("regexp(b.tagName, '^HWNBYC174_1O_')")
    expect(sql).toContain("GROUP BY date_trunc('hour', a.`timestamp`)")
    expect(sql).toContain("ORDER BY date_trunc('hour', a.`timestamp`)")
  })
  it('时间字面量按 Asia/Shanghai 规范化（分区裁剪 + 时区语义）', () => {
    const sql = timeSeriesSql(testConfig(), { ...base, bucket: 'raw' })
    expect(sql).toContain("a.`timestamp` >= '2026-08-01 00:00:00'")
    expect(sql).toContain("a.`timestamp` < '2026-08-02 00:00:00'")
  })
  it('raw 明细无聚合', () => {
    const sql = timeSeriesSql(testConfig(), { ...base, bucket: 'raw' })
    expect(sql).toContain('SELECT a.`timestamp`, a.`value`, a.`quality`')
    expect(sql).not.toContain('GROUP BY')
    expect(sql).toContain('ORDER BY a.`timestamp`')
  })
  it('5m 桶用 time_slice', () => {
    const sql = timeSeriesSql(testConfig(), { ...base, bucket: '5m' })
    expect(sql).toContain('time_slice(a.`timestamp`, INTERVAL 5 minute)')
  })
})

describe('aggregateSql（§3.3）', () => {
  const base = {
    tagFilter: '^zcdllsl_',
    startIso: '2026-08-01T00:00:00+08:00',
    endIso: '2026-08-02T00:00:00+08:00',
    limit: 1000,
    badValueMask: 128,
  }
  it('device 分组用 1 基 split[3]', () => {
    const sql = aggregateSql(testConfig(), { ...base, func: 'AVG', groupBy: 'device' })
    expect(sql).toContain("split(b.tagName, '_')[3] AS `device`")
    expect(sql).toContain("GROUP BY split(b.tagName, '_')[3]")
  })
  it('tagcode 分组用 1 基 split[1]；COUNT 用 COUNT(*)', () => {
    const sql = aggregateSql(testConfig(), { ...base, func: 'COUNT', groupBy: 'tagcode' })
    expect(sql).toContain("split(b.tagName, '_')[1] AS `tagCode`")
    expect(sql).toContain('COUNT(*) AS `aggValue`')
  })
  it('none 分组无常量列 GROUP BY', () => {
    const sql = aggregateSql(testConfig(), { ...base, func: 'SUM', groupBy: 'none' })
    expect(sql).toContain("'all' AS `bucket`")
    expect(sql).not.toContain('GROUP BY')
    expect(sql).toContain('ORDER BY `aggValue` DESC')
  })
  it('月桶', () => {
    const sql = aggregateSql(testConfig(), { ...base, func: 'MAX', groupBy: 'bucket_month' })
    expect(sql).toContain("date_trunc('month', a.`timestamp`) AS `bucket`")
  })
})

describe('estimateScanSql', () => {
  it('COUNT 护栏，字面量已规范化', () => {
    const sql = estimateScanSql(testConfig(), '2026-08-01T00:00:00+08:00', '2026-08-02T00:00:00+08:00')
    expect(sql).toContain('SELECT COUNT(*) AS `scanRows` FROM WT_DATA')
    expect(sql).toContain("`timestamp` >= '2026-08-01 00:00:00'")
  })
})

describe('模板全部通过校验层闸门', () => {
  it('每个模板产物都是白名单内只读语句', () => {
    const config = testConfig()
    const sqls = [
      lookupTagSql(config, { keyword: '电流', limit: 100 }),
      latestValueSql(config, { tagNames: ['t_1O_d'], badValueMask: 128 }),
      timeSeriesSql(config, {
        tagFilter: '^t_',
        startIso: '2026-08-01T00:00:00+08:00',
        endIso: '2026-08-02T00:00:00+08:00',
        bucket: '1h',
        limit: 10,
        badValueMask: 128,
      }),
      aggregateSql(config, {
        tagFilter: '^t_',
        startIso: '2026-08-01T00:00:00+08:00',
        endIso: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
        groupBy: 'device',
        limit: 10,
        badValueMask: 128,
      }),
      estimateScanSql(config, '2026-08-01T00:00:00+08:00', '2026-08-02T00:00:00+08:00'),
    ]
    for (const sql of sqls) expect(() => assertSafeToExecute(sql, config.security.tableWhitelist)).not.toThrow()
  })
})

// ============ P1 模板测试 ============

describe('SQL 字符串转义（escapeSqlString：反斜杠 + 单引号）', () => {
  it('regexp 过滤串保留反斜杠正则语义（\\d 不被 MySQL 转义规则吞掉）', () => {
    const sql = tagIndexByFilterSql(testConfig(), '^HWNBYC\\d+_1O_')
    expect(sql).toContain("regexp(tagName, '^HWNBYC\\\\d+_1O_')")
  })
  it('尾部反斜杠不再吃掉闭合引号', () => {
    const sql = tagIndexByFilterSql(testConfig(), '^abc\\')
    expect(sql).toContain("regexp(tagName, '^abc\\\\')")
  })
  it('精确匹配串同样先转反斜杠再双写引号', () => {
    const sql = resolveTagStep4Sql(testConfig(), "a'b\\c")
    expect(sql).toContain("tagname = 'a''b\\\\c'")
  })
})

describe('P1 MySQL 元数据模板', () => {
  const config = testConfig()

  it('lookupModelSql: app_id 过滤', () => {
    const sql = lookupModelSql(config, 10062)
    expect(sql).toContain('FROM wisetao_meta.meta_class_info')
    expect(sql).toContain('WHERE app_id = 10062')
  })

  it('lookupObjectSql: 多条件过滤 + LIKE 轉义', () => {
    const sql = lookupObjectSql(config, {
      appId: 10062,
      classPath: 'inverter',
      nodeName: "1号%'",
      parentId: 42,
      limit: 50,
    })
    expect(sql).toContain('FROM wisetao_meta.wt_elm_equipment')
    expect(sql).toContain('deleted = 0')
    expect(sql).toContain('app_id = 10062')
    expect(sql).toContain("class__path LIKE '%inverter%'")
    expect(sql).toContain("node_name LIKE '%1号\\%''%'")
    expect(sql).toContain('parent_id = 42')
    expect(sql).toContain('LIMIT 50')
  })

  it('lookupTagDefinitionSql: JOIN meta_class_info', () => {
    const sql = lookupTagDefinitionSql(config, 'wisetao.pv.inverter')
    expect(sql).toContain('FROM wisetao_meta.meta_classtagmodel t')
    expect(sql).toContain('JOIN wisetao_meta.meta_class_info c ON t.master_class_id = c.id')
    expect(sql).toContain("c.class_path = 'wisetao.pv.inverter'")
  })

  it('queryAlarmSql: 时间区间 + 级别过滤', () => {
    const sql = queryAlarmSql(config, {
      appId: 10062,
      startTime: '2026-08-01 00:00:00',
      endTime: '2026-08-02 00:00:00',
      alarmLevel: 'critical',
      limit: 100,
    })
    expect(sql).toContain('FROM wisetao_meta.wt_bas_alarmrecord')
    expect(sql).toContain("alarm_time >= '2026-08-01 00:00:00'")
    expect(sql).toContain("alarm_time < '2026-08-02 00:00:00'")
    expect(sql).toContain("alarm_level = 'critical'")
    expect(sql).toContain('ORDER BY alarm_time DESC')
  })


  it('queryAlarmConfigSql: 跨库引用 bole.wt_cus_alarmdynamicconfig', () => {
    const sql = queryAlarmConfigSql(config, { appId: 10062, cusClassPath: 'wisetao.pv.inverter' })
    expect(sql).toContain('FROM bole.wt_cus_alarmdynamicconfig')
    expect(sql).toContain("cus_class_path = 'wisetao.pv.inverter'")
  })
})

describe('P1 resolve_tag 链路模板', () => {
  const config = testConfig()

  it('step1: 查设备 id + class__path', () => {
    const sql = resolveTagStep1Sql(config, '1号逆变器', 10062)
    expect(sql).toContain('SELECT id, class__path')
    expect(sql).toContain('FROM wisetao_meta.wt_elm_equipment')
    expect(sql).toContain("node_name = '1号逆变器'")
    expect(sql).toContain('app_id = 10062')
  })

  it('step2: 查 tagCode', () => {
    const sql = resolveTagStep2Sql(config, '直流电压', 'wisetao.pv.inverter')
    expect(sql).toContain('SELECT t.tag_code')
    expect(sql).toContain("t.name = '直流电压'")
    expect(sql).toContain("c.class_path = 'wisetao.pv.inverter'")
  })

  it('step4: 查 wt_iot_tags alias', () => {
    const sql = resolveTagStep4Sql(config, 'Udc_1O_174')
    expect(sql).toContain('SELECT alias')
    expect(sql).toContain('FROM wisetao_meta.wt_iot_tags')
    expect(sql).toContain("tagname = 'Udc_1O_174'")
  })

  it('step5: 查 WT_TAG tagIndex（StarRocks）', () => {
    const sql = resolveTagStep5Sql(config, 'Udc_1O_174')
    expect(sql).toContain('SELECT tagIndex')
    expect(sql).toContain('FROM WT_TAG')
    expect(sql).toContain("tagName = 'Udc_1O_174'")
  })
})

describe('P1 优化模板', () => {
  const config = testConfig()

  it('extractGranularityFromFilter: 从 tag_filter 提取粒度后缀', () => {
    expect(extractGranularityFromFilter('^HWNBYC174_1O_')).toBe('1O')
    expect(extractGranularityFromFilter('^HWNBYC174_1H_')).toBe('1H')
    expect(extractGranularityFromFilter('^HWNBYC174_1D_')).toBe('1D')
    expect(extractGranularityFromFilter('^HWNBYC174_1M_')).toBe('1M')
    expect(extractGranularityFromFilter('^HWNBYC174_1Y_')).toBe('1Y')
    expect(extractGranularityFromFilter('^no_granularity')).toBeNull()
  })

  it('tagIndexByFilterSql: 预查 tagIndex', () => {
    const sql = tagIndexByFilterSql(config, '^HWNBYC174_1O_')
    expect(sql).toContain('SELECT tagIndex')
    expect(sql).toContain('FROM WT_TAG')
    expect(sql).toContain("regexp(tagName, '^HWNBYC174_1O_')")
  })

  it('timeSeriesByTagIndexSql: IN 子查询替代 JOIN', () => {
    const sql = timeSeriesByTagIndexSql(config, {
      tagFilter: '^HWNBYC174_1O_',
      startIso: '2026-08-01T00:00:00+08:00',
      endIso: '2026-08-02T00:00:00+08:00',
      bucket: '1h',
      limit: 100,
      badValueMask: 128,
    })
    expect(sql).toContain('a.tagIndex IN (SELECT tagIndex FROM WT_TAG')
    expect(sql).not.toContain('LEFT JOIN')
  })

  it('aggregateByTagIndexSql: IN 子查询替代 JOIN', () => {
    const sql = aggregateByTagIndexSql(config, {
      tagFilter: '^HWNBYC174_1O_',
      startIso: '2026-08-01T00:00:00+08:00',
      endIso: '2026-08-02T00:00:00+08:00',
      func: 'AVG',
      groupBy: 'device',
      limit: 100,
      badValueMask: 128,
    })
    expect(sql).toContain('a.tagIndex IN (SELECT tagIndex FROM WT_TAG')
    expect(sql).not.toContain('LEFT JOIN')
  })

  it('cubeTypeDistinctSql: tagCode(+device)+granularity 预查', () => {
    const sql = cubeTypeDistinctSql(config, { tagCode: 'HWNBYC174', deviceId: '1001', granularity: 1 })
    expect(sql).toContain('SELECT DISTINCT cubeType')
    expect(sql).toContain('FROM WT_CUBE')
    expect(sql).toContain("tagCode = 'HWNBYC174'")
    expect(sql).toContain('device = 1001')
    expect(sql).toContain('granularity = 1')
    const open = cubeTypeDistinctSql(config, { tagCode: 'HWNBYC174', granularity: 1 })
    expect(open).not.toContain('device =')
  })

  it('aggregateCubeSql: 真实列过滤（tagCode/device/granularity），无 quality 无 tagIndex', () => {
    const sql = aggregateCubeSql(config, {
      tagCode: 'HWNBYC174',
      deviceId: '100620000015521',
      startIso: '2026-08-01T00:00:00+08:00',
      endIso: '2026-08-02T00:00:00+08:00',
      func: 'AVG',
      groupBy: 'none',
      granularity: 1,
      limit: 100,
    })
    expect(sql).toContain('FROM WT_CUBE a')
    expect(sql).toContain('a.`granularity` = 1')
    expect(sql).toContain("a.`tagCode` = 'HWNBYC174'")
    expect(sql).toContain('a.`device` = 100620000015521')
    expect(sql).toContain('AVG(a.`value`) AS `aggValue`')
    expect(sql).not.toContain('tagIndex')
    expect(sql).not.toContain('bitand')
    expect(sql).not.toContain('b.tagName')
  })

  it('aggregateCubeSql: device/tagcode 分组用自带列，无需 JOIN', () => {
    const sql = aggregateCubeSql(config, {
      tagCode: 'HWNBYC174',
      startIso: '2026-08-01T00:00:00+08:00',
      endIso: '2026-08-02T00:00:00+08:00',
      func: 'SUM',
      groupBy: 'device',
      granularity: 2,
      limit: 100,
    })
    expect(sql).toContain('a.`device` AS `device`')
    expect(sql).toContain('GROUP BY a.`device`')
    expect(sql).not.toContain('LEFT JOIN')
  })
})

describe('lookupDeviceSql（WT_DEVICE 设备层级）', () => {
  const config = testConfig()

  it('关键字模糊匹配三级名称与编码，LIKE 转义', () => {
    const sql = lookupDeviceSql(config, { keyword: "逆变器%'_", limit: 50 })
    expect(sql).toContain('SELECT inverterId, inverterName, inverterCode, arrayId, arrayName, arrayCode, subId, subName, subCode, `type`')
    expect(sql).toContain('FROM WT_DEVICE')
    expect(sql).toContain("inverterName LIKE '%逆变器\\%''\\_%'")
    expect(sql).toContain('subCode LIKE')
    expect(sql).toContain('ORDER BY inverterCode')
    expect(sql).toContain('LIMIT 50')
  })
  it('device_type 精确过滤；无入参时无 WHERE', () => {
    const typed = lookupDeviceSql(config, { deviceType: 'inverter', limit: 10 })
    expect(typed).toContain('`type` = \'inverter\'')
    expect(typed).not.toContain('LIKE')
    const all = lookupDeviceSql(config, { limit: 10 })
    expect(all).not.toContain('WHERE')
  })
})

describe('P1 模板全部通过校验层闸门', () => {
  it('MySQL 元数据模板通过 MySQL 白名单', () => {
    const config = testConfig()
    const sqls = [
      lookupModelSql(config, 10062),
      lookupObjectSql(config, { appId: 10062, limit: 100 }),
      lookupObjectSql(config, { appId: 10062, classPath: 'inv', nodeName: '1号', parentId: 1, limit: 100 }),
      lookupTagDefinitionSql(config, 'wisetao.pv.inverter'),
      queryAlarmSql(config, {
        appId: 10062,
        startTime: '2026-08-01 00:00:00',
        endTime: '2026-08-02 00:00:00',
        limit: 100,
      }),
      queryAlarmConfigSql(config, { appId: 10062 }),
      queryAlarmConfigSql(config, { appId: 10062, cusClassPath: 'wisetao.pv.inverter' }),
      resolveTagStep1Sql(config, '1号逆变器', 10062),
      resolveTagStep2Sql(config, '直流电压', 'wisetao.pv.inverter'),
      resolveTagStep4Sql(config, '174_DEV001_1O_Udc'),
    ]
    for (const sql of sqls) {
      expect(() => assertSafeToExecute(sql, config.security.mysqlTableWhitelist)).not.toThrow()
    }
  })

  it('resolve_tag step5 + 优化模板通过 StarRocks 白名单', () => {
    const config = testConfig()
    const sqls = [
      resolveTagStep5Sql(config, 'Udc_1O_174'),
      lookupDeviceSql(config, { keyword: '逆变器', limit: 100 }),
      lookupDeviceSql(config, { deviceType: 'array', limit: 100 }),
      tagIndexByFilterSql(config, '^HWNBYC174_1O_'),
      timeSeriesByTagIndexSql(config, {
        tagFilter: '^t_1O_',
        startIso: '2026-08-01T00:00:00+08:00',
        endIso: '2026-08-02T00:00:00+08:00',
        bucket: '1h',
        limit: 10,
        badValueMask: 128,
      }),
      aggregateByTagIndexSql(config, {
        tagFilter: '^t_1O_',
        startIso: '2026-08-01T00:00:00+08:00',
        endIso: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
        groupBy: 'device',
        limit: 10,
        badValueMask: 128,
      }),
      aggregateCubeSql(config, {
        tagCode: 'HWNBYC174',
        deviceId: '100620000015521',
        startIso: '2026-08-01T00:00:00+08:00',
        endIso: '2026-08-02T00:00:00+08:00',
        func: 'AVG',
        groupBy: 'none',
        granularity: 1,
        limit: 10,
      }),
      cubeTypeDistinctSql(config, { tagCode: 'HWNBYC174', granularity: 1 }),
    ]
    for (const sql of sqls) {
      expect(() => assertSafeToExecute(sql, config.security.tableWhitelist)).not.toThrow()
    }
  })
})
